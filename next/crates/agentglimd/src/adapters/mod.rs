//! Agent adapters (Source impls). All real adapters are read-only (Caps::WATCH only).

pub mod agy;
pub mod claude_code;
pub mod codex;
pub mod fake;
pub mod io;
pub mod opencode;
pub mod pi;
pub mod plans_harness;
pub mod tail;

use self::io::{Allowance, DirWalk, ReadOutcome, Step};
use crate::config::Config;
use crate::core::{
    Batch, BatchItem, Cursor, Detection, FileOffset, ItemKind, RecordKey, Source, TurnBudget,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// Ids of the real adapters that are on by default (off only with `"sources": {"<id>": false}`).
pub const DEFAULT_ON: [&str; 6] = [
    plans_harness::ID,
    claude_code::ID,
    codex::ID,
    opencode::ID,
    agy::ID,
    pi::ID,
];

/// Per-poll limits to ensure fairness and prevent stalls.
pub const MAX_BYTES_PER_PASS: u64 = 4 * 1024 * 1024; // 4 MiB
pub const MAX_FILES_PER_PASS: usize = 200;
pub const MAX_LINES_PER_SOURCE_PASS: usize = 5000;
pub const FAIR_LINES_PER_FILE: usize = 100;
pub const MAX_DISCOVERY_ENTRIES_PER_PASS: usize = MAX_FILES_PER_PASS;

/// Resolve the effective home directory: non-empty `HOME`, then non-empty `USERPROFILE`, else empty.
/// Empty or unset values never fall through to the real user's home.
pub fn resolve_home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(Into::into)
        .unwrap_or_default()
}

/// Sources enabled by config. The fake adapter is opt-in (`"sources": {"fake": true}`).
pub fn registry(cfg: &Config) -> Vec<Arc<dyn Source>> {
    registry_with_home(cfg, &resolve_home())
}

/// Same as [`registry`] with an explicit home (tests).
pub fn registry_with_home(cfg: &Config, home: &Path) -> Vec<Arc<dyn Source>> {
    let on = |id: &str| cfg.sources.get(id).copied().unwrap_or(true);
    let root = |id: &str| cfg.roots.get(id).map(PathBuf::from);
    let mut v: Vec<Arc<dyn Source>> = Vec::new();
    if on(plans_harness::ID) {
        v.push(Arc::new(plans_harness::PlansHarness::new(
            root(plans_harness::ID),
            home,
            cfg.history_days,
        )));
    }
    if on(claude_code::ID) {
        v.push(Arc::new(claude_code::ClaudeCode::new(
            root(claude_code::ID),
            home,
            cfg.history_days,
        )));
    }
    if on(codex::ID) {
        v.push(Arc::new(codex::Codex::new(
            root(codex::ID),
            home,
            cfg.history_days,
        )));
    }
    if on(opencode::ID) {
        v.push(Arc::new(opencode::OpenCode::new(
            root(opencode::ID),
            home,
            cfg.history_days,
        )));
    }
    if on(agy::ID) {
        v.push(Arc::new(agy::Agy::new(
            root(agy::ID),
            home,
            cfg.history_days,
        )));
    }
    if on(pi::ID) {
        v.push(Arc::new(pi::Pi::new(root(pi::ID), home, cfg.history_days)));
    }
    if cfg.sources.get("fake").copied().unwrap_or(false) {
        v.push(Arc::new(fake::FakeSource::default()));
    }
    v
}

/// Where an adapter reads from: a configured override, or `default_rel` under a home dir.
#[derive(Debug, Clone)]
pub struct RootSpec {
    pub over: Option<PathBuf>,
    pub default_rel: &'static str,
}

impl RootSpec {
    pub fn resolve(&self, home: &Path) -> PathBuf {
        self.over
            .clone()
            .unwrap_or_else(|| home.join(self.default_rel))
    }

    /// Detected when the root is a directory; otherwise a reason without absolute home paths.
    pub fn detect(&self, home: &Path) -> Detection {
        let root = self.resolve(home);
        if root.is_dir() {
            return Detection::Detected { paths: vec![root] };
        }
        let reason = match &self.over {
            Some(p) => format!("configured root not found: {}", p.display()),
            None => format!("~/{} not found", self.default_rel),
        };
        Detection::NotDetected { reason }
    }
}

/// Per-file tail state shared by the JSONL adapters.
#[derive(Debug, Default, Clone)]
pub struct FileState {
    pub offset: u64,
    pub session: Option<String>,
    pub model: Option<String>,
    pub announced: bool,
    /// File size at the last read (restored value after `restore`); used for truncation + guard.
    pub size: u64,
    /// mtime at the last read; `None` until the file has been read once in this process.
    pub mtime: Option<SystemTime>,
    /// Fingerprint: first 256 bytes (hex) to detect a changed prefix.
    pub fingerprint: String,
    /// Durable logical generation: monotonic, raised only on a proven replacement/truncation (never from inode).
    pub generation: u64,
    /// Bytes discarded while skipping an oversized line.
    pub discarded_bytes: u64,
    /// Whether a partial/oversized row remains unprocessed (discard mode).
    pub incomplete: bool,
    /// Durable content witness of exactly one committed content version (JSON, see [`Witness`]).
    ///
    /// A legacy bare hash, a witness that does not cover the committed offset, or `None` is *unknown* evidence,
    /// never equality.
    pub revision: Option<String>,
    /// mtime (ms) most recently *observed and acknowledged* in this process. Deliberately not persisted: a
    /// metadata-only touch that is proven content-identical must leave the durable checkpoint byte-identical.
    pub acked_mtime_ms: Option<u64>,
    /// In-memory marker of the discovery sweep that most recently saw this path (never persisted). A completed,
    /// error-free sweep removes the known paths whose marker it did not refresh.
    pub seen_epoch: u64,
}

/// How often the tree is walked again for new files (a cursor of 0 always walks).
pub const REDISCOVER: Duration = Duration::from_secs(15);

/// Extra bytes kept free of a per-source allowance so that a raw `/proc/self/io` probe of one adapter call stays
/// at or below the 4 MiB ceiling: the probe itself reads a few dozen instrumentation bytes from `/proc`.
pub const RAW_PROBE_HEADROOM: u64 = 4096;

/// Version tag of the durable content witness stored in `FileCheckpoint.revision`.
const WITNESS_VERSION: u32 = 2;
/// Domain separator of the line-chain digest (bumping it invalidates old partial witnesses, never old events).
const CHAIN_DOMAIN: &[u8] = b"agentglim-jsonl-content-chain-v2";

fn sha256_hex(parts: &[&[u8]]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    format!("{:x}", h.finalize())
}

fn chain_seed() -> String {
    sha256_hex(&[CHAIN_DOMAIN])
}

/// One step of the chained content digest. `tag` distinguishes a parsed line (`L`) from a consumed byte range that
/// produced no committed line (`G`: blank lines, an oversized/discarded row or a partial trailing line).
fn chain_hash(prev: &str, tag: u8, start: u64, end: u64, body: &[u8]) -> String {
    sha256_hex(&[
        prev.as_bytes(),
        &[tag],
        &start.to_le_bytes(),
        &end.to_le_bytes(),
        body,
    ])
}

/// Resumable verification progress of one committed content version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct VerifyProgress {
    /// Byte offset the chain has reached (always a committed-content line boundary at or below the witness end).
    at: u64,
    /// Chain digest over `[0, at)`.
    hash: String,
    /// Number of parsed lines folded in so far.
    lines: u64,
    /// File size observed when this verification started; a different size restarts the pass.
    size: u64,
    /// File mtime (ms) observed when this verification started; a different mtime restarts the pass.
    mtime: u64,
}

/// The durable content witness: exactly one committed content version of one file.
///
/// `from`/`off`/`lines`/`hash` describe the parsed lines (and the byte ranges between them) of the bytes
/// `[from, off)`. Only a witness with `from == 0`, `off ==` the committed offset and no verification in progress can
/// prove that a file's content is still the committed content. Anything else (a legacy bare hash, a truncated
/// witness, a witness that does not cover the committed offset) is *unknown evidence* and never equality.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Witness {
    v: u32,
    from: u64,
    off: u64,
    lines: u64,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verify: Option<VerifyProgress>,
}

impl Witness {
    /// Parse a stored `FileCheckpoint.revision`. Legacy (bare hash) or malformed values are unknown, not equality.
    fn parse(stored: &Option<String>) -> Option<Witness> {
        let raw = stored.as_deref()?;
        if !raw.starts_with('{') {
            return None;
        }
        let w: Witness = serde_json::from_str(raw).ok()?;
        (w.v == WITNESS_VERSION).then_some(w)
    }

    fn render(&self) -> String {
        serde_json::to_string(self).expect("witness serializes")
    }

    /// True when this witness covers the whole committed content from byte 0 (a verification may be in progress).
    fn covers_committed(&self, st: &FileState) -> bool {
        self.from == 0 && self.off == st.offset
    }
}

/// Incremental line-chain state, extended with the payload bytes this poll actually committed.
#[derive(Debug, Clone)]
struct ChainState {
    from: u64,
    off: u64,
    lines: u64,
    hash: String,
}

impl ChainState {
    fn fresh(at: u64) -> Self {
        Self {
            from: at,
            off: at,
            lines: 0,
            hash: chain_seed(),
        }
    }

    /// Continue the stored witness when it ends exactly where the committed offset is; otherwise start a new chain
    /// at the committed offset (a partial chain, which can never prove whole-file equality).
    fn from_state(st: &FileState, at: u64) -> Self {
        match Witness::parse(&st.revision) {
            Some(w) if w.off == at && w.verify.is_none() => Self {
                from: w.from,
                off: w.off,
                lines: w.lines,
                hash: w.hash,
            },
            _ => Self::fresh(at),
        }
    }

    fn mix_gap(&mut self, to: u64) {
        if to > self.off {
            self.hash = chain_hash(&self.hash, b'G', self.off, to, &[]);
            self.off = to;
        }
    }

    fn mix_line(&mut self, line: &[u8], start: u64, end: u64) {
        self.mix_gap(start);
        self.hash = chain_hash(&self.hash, b'L', start, end, line);
        self.off = end;
        self.lines += 1;
    }

    fn to_witness(&self) -> Witness {
        Witness {
            v: WITNESS_VERSION,
            from: self.from,
            off: self.off,
            lines: self.lines,
            hash: self.hash.clone(),
            verify: None,
        }
    }
}

/// Narrow work-accounting counters for the independent oracle (never a substitute for a physical measurement).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WorkStats {
    /// Directory entries returned to this adapter (matching or not, files or directories).
    pub entries: u64,
    /// Metadata/stat calls issued while classifying entries and known files.
    pub stats: u64,
    /// Files opened for content (fingerprint, payload, verification, boundary probe).
    pub opens: u64,
    /// Directories opened.
    pub dirs: u64,
    /// Known files visited by the tail pass.
    pub file_visits: u64,
    /// Bytes returned by payload reads.
    pub payload_bytes: u64,
    /// Bytes returned by verification reads.
    pub verify_bytes: u64,
    /// Completed successful discovery sweeps.
    pub sweeps: u64,
    /// Discovery sweeps that ended with an error (incomplete: cannot certify absence).
    pub sweeps_errored: u64,
    /// Verification passes started and completed.
    pub verifications_started: u64,
    pub verifications_completed: u64,
    /// Entries/known-file visits of the most recent call.
    pub last_pass_entries: u64,
    pub last_pass_file_visits: u64,
}

fn ms_of(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Fingerprint (first 256 bytes, hex) of a file: the prefix sample used to detect an equal-size rewrite.
/// `ReadOutcome::NoBudget` means the turn allowance had nothing left, so the caller must stop rather than
/// treat the empty sample as a changed file.
fn fingerprint_charged(
    path: &Path,
    al: &Allowance,
    work: &mut WorkStats,
) -> std::io::Result<ReadOutcome<String>> {
    // A clamped (partially budgeted) sample is not comparable with a stored one: treat it as "no budget" so the
    // pass stops and the file is revisited next turn instead of being declared a changed/replaced file.
    if al.remaining() < 256 {
        return Ok(ReadOutcome::NoBudget);
    }
    let buf = match io::read_bytes(path, 0, 256, al, work)? {
        ReadOutcome::Data(b) => b,
        ReadOutcome::NoBudget => return Ok(ReadOutcome::NoBudget),
    };
    let mut out = String::with_capacity(buf.len() * 2);
    for b in &buf {
        out.push_str(&format!("{:02x}", b));
    }
    Ok(ReadOutcome::Data(out))
}

/// Bounded, resumable discovery sweep of one source root.
///
/// The sweep keeps an open [`DirWalk`] (one `ReadDir` + a pending-directory stack) between calls and turns, so
/// nothing is materialised or sorted and no pass restarts at entry zero. A matching file is adopted into the
/// known map **as it is found** (one charged visit), stamped with the sweep id; paths that the completed sweep
/// did not see are removed by a separate, bounded, visit-charged reconcile pass. Only an error-free sweep may
/// prove a path absent, and `discovery_complete()` stays false until that reconcile pass has finished.
#[derive(Debug, Default)]
struct DiscoverState {
    /// A sweep is running (walk and/or reconcile still to do).
    active: bool,
    /// At least one complete, error-free sweep finished in this process.
    ever_complete: bool,
    /// The current sweep (or an entry/directory inside it) failed: absence is unproven and a retry is due.
    error: bool,
    walk: Option<DirWalk>,
    /// Monotonic epoch of completed, error-free sweeps (reported to core via `discovery_epoch`).
    epoch: u64,
    /// Sweep id stamped on the files this sweep sees (always `epoch + 1` while it runs).
    sweep: u64,
    /// Blocked on the walk because the turn allowance was spent; the next call continues the walk.
    walk_paused: bool,
    /// Reconcile cursor: known paths below it have been checked against this sweep.
    reconcile_from: Option<PathBuf>,
    reconciled: bool,
    /// Known files when the sweep started, and how many of them it saw again. When every one was seen the sweep
    /// cannot have dropped a path, so the (charged) reconcile pass is provably unnecessary.
    known_at_start: usize,
    seen_existing: usize,
    /// Restored checkpoint entries adopted while this sweep was running (they were not seen by it).
    adopted_during_sweep: usize,
    /// Paths the completed sweep proved absent. Applied only when the sweep is complete, so a checkpoint can
    /// never lose a path before `discovery_complete()` says the absence is proven.
    remove: Vec<PathBuf>,
}

impl DiscoverState {
    fn begin(&mut self, root: &Path, known: usize) {
        self.active = true;
        self.error = false;
        self.walk = Some(DirWalk::start(root));
        self.sweep = self.epoch + 1;
        self.walk_paused = false;
        self.reconcile_from = None;
        self.reconciled = false;
        self.known_at_start = known;
        self.seen_existing = 0;
        self.remove.clear();
        // `adopted_during_sweep` deliberately survives `begin`: restored entries adopted just before the sweep
        // started are unstamped too, so the reconcile pass is required for them.
    }

    fn clear(&mut self) {
        self.active = false;
        self.error = false;
        self.walk = None;
        self.walk_paused = false;
        self.reconcile_from = None;
        self.reconciled = false;
        self.known_at_start = 0;
        self.seen_existing = 0;
        self.adopted_during_sweep = 0;
        self.ever_complete = false;
    }
}

/// Bounded detection continuation: one bounded pass per call, from where the previous call stopped.
#[derive(Default)]
struct DetectState {
    walk: Option<DirWalk>,
}

enum DetectStep {
    Found,
    Exhausted,
    Partial,
}

#[derive(Default)]
struct TailInner {
    files: BTreeMap<PathBuf, FileState>,
    pending: BTreeMap<String, FileState>,
    root: Option<PathBuf>,
    last_discover: Option<Instant>,
    consumed: u64,
    /// Set by `restore`: the next `Cursor(0)` is not a reset (the restored offsets are the state).
    restored: bool,
    /// Ordered continuation of the known-file pass: the next path to visit (wrap to the first when past the end).
    next_path: Option<PathBuf>,

    /// Producer identities emitted during the most recent poll, aligned 1:1 with Batch::items.
    identities: Vec<RecordKey>,

    discover: DiscoverState,
    detect: DetectState,
    work: WorkStats,

    /// Removed-path generation high-water marks for reappearance distinctness.
    removed_generations: BTreeMap<String, u64>,

    /// Checkpoint-delta dirty set: relative paths whose parser state changed (or was visited, so a
    /// re-verified state is re-upserted harmlessly) since the last delta was taken. Bounded by the
    /// per-turn visit allowance (\u2264200): each entry is one charged visit. Drained by
    /// `checkpoint_delta()`/`checkpoint()`; the poller retains the drained delta in its pending
    /// batch until the commit succeeds, so a failed commit retries the exact same delta.
    dirty: BTreeSet<String>,
    /// Removal candidates proved absent by a completed sweep since the last delta was taken:
    /// `(relative path, last logical generation)`. Only a complete, error-free sweep populates this.
    delta_removed: Vec<(String, u64)>,
    /// Last drained (acked) durable checkpoint per path. A visited-but-unchanged file (e.g. a
    /// metadata-only touch) compares equal and is not re-emitted, so the delta carries only real
    /// changes. Resident state, updated per drained entry — never copied per turn.
    acked: BTreeMap<String, crate::core::FileCheckpoint>,
}

/// Multi-file JSONL tail state. `Cursor(0)` resets and rereads from the start; the returned
/// cursor counts bytes consumed since that reset. Discovery (walking the tree) is separate
/// from tailing known files, and a file whose size and mtime are unchanged is not read.
pub struct JsonlTail {
    suffix: &'static str,
    inner: Mutex<TailInner>,
    /// The one allowance of the current scheduled source turn, when core opened one.
    turn: Mutex<Option<Arc<TurnBudget>>>,
}

impl Default for JsonlTail {
    fn default() -> Self {
        Self::with_suffix(".jsonl")
    }
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn checkpoint_of(path: String, st: &FileState) -> crate::core::FileCheckpoint {
    crate::core::FileCheckpoint {
        path,
        generation: st.generation,
        offset: st.offset,
        size: st.size,
        mtime_ms: ms_of(st.mtime).unwrap_or(0),
        fingerprint: st.fingerprint.clone(),
        session: st.session.clone(),
        model: st.model.clone(),
        announced: st.announced,
        discarded_bytes: st.discarded_bytes,
        incomplete: st.incomplete,
        revision: st.revision.clone(),
    }
}

/// `u64` field or 0.
pub fn num(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

/// File stem of a relative path (`a/b/c.jsonl` -> `c`).
pub fn stem(rel: &str) -> String {
    Path::new(rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.to_string())
}

enum VerifyOutcome {
    /// Proven byte-for-byte unchanged (the witness describes the committed content).
    Equal,
    /// The content differs, or the stored evidence cannot prove equality: the caller re-reads from byte 0.
    Different,
    /// Bounded progress persisted; equality is not yet established and must not be acknowledged.
    Progress,
}

impl JsonlTail {
    /// True only after a complete, successful discovery sweep in this process. Before the first complete sweep, and
    /// after any sweep that hit a root/read-dir/entry/stat error, absence is unproven.
    pub fn discovery_complete(&self) -> bool {
        let g = self.inner.lock().unwrap();
        g.discover.ever_complete && !g.discover.active && !g.discover.error
    }

    /// Monotonic count of completed, error-free discovery sweeps (core uses it to decide whether a checkpoint
    /// diff can differ from the previous one).
    pub fn discovery_epoch(&self) -> Option<u64> {
        let g = self.inner.lock().unwrap();
        Some(g.discover.epoch)
    }

    /// This tail only drops a known path when a completed sweep proved it absent, so core never has to merge
    /// unseen paths back into a partial checkpoint.
    pub fn retains_unseen_paths(&self) -> bool {
        true
    }

    /// Tail files whose name ends with `suffix` (e.g. `transcript.jsonl`).
    pub fn with_suffix(suffix: &'static str) -> Self {
        Self {
            suffix,
            inner: Mutex::new(TailInner::default()),
            turn: Mutex::new(None),
        }
    }

    /// Opens the one scheduled source-turn allowance: `detect` and the following `poll` share it.
    pub fn begin_turn(&self, allowance: Arc<TurnBudget>) {
        *self.turn.lock().expect("turn lock") = Some(allowance);
    }

    pub fn end_turn(&self) {
        *self.turn.lock().expect("turn lock") = None;
    }

    /// Narrow work counters for the independent oracle.
    pub fn work_stats(&self) -> WorkStats {
        self.inner.lock().expect("tail lock").work
    }

    fn allowance(&self) -> Allowance {
        match self.turn.lock().expect("turn lock").clone() {
            Some(b) => Allowance::new(b),
            None => Allowance::standalone(),
        }
    }

    /// One bounded discovery step: continue the walk (charging an entry before each advance and a visit per
    /// entry/directory) and then, once the walk is complete and error-free, continue the bounded reconcile pass
    /// that removes the known paths this sweep did not see. Everything resumes where the previous call stopped.
    fn discover_step(&self, g: &mut TailInner, root: &Path, al: &Allowance) {
        let entries_before = g.work.entries;
        if !g.discover.active {
            let known = g.files.len();
            g.discover.begin(root, known);
        }
        // --- walk --------------------------------------------------------------
        if !g.discover.reconciled {
            if let Some(mut walk) = g.discover.walk.take() {
                let mut paused = false;
                loop {
                    match walk.step(al, &mut g.work) {
                        Step::File { path, meta } => {
                            if meta.is_file() && self.matches(&path) {
                                self.adopt_found(g, root, &path);
                            }
                        }
                        Step::Dir(_) => {}
                        // An uninspectable entry/directory is an unproven path, never an absent one.
                        Step::MetaError(_) | Step::Unreadable(_) | Step::EntryError => {
                            g.discover.error = true;
                        }
                        Step::Budget => {
                            paused = true;
                            break;
                        }
                        Step::End => break,
                    }
                }
                g.discover.walk_paused = paused;
                if !walk.is_done() {
                    g.discover.walk = Some(walk);
                    g.work.last_pass_entries = g.work.entries.saturating_sub(entries_before);
                    return;
                }
                if g.discover.error {
                    // Keep every known path (absence is unproven) and retry from the root on a later turn.
                    g.work.sweeps_errored += 1;
                    g.discover.active = false;
                    return;
                }
                // Every path known when the sweep started was seen again: this sweep cannot have dropped one,
                // so the charged reconcile pass is provably unnecessary.
                if g.discover.seen_existing == g.discover.known_at_start
                    && g.discover.adopted_during_sweep == 0
                {
                    g.discover.reconciled = true;
                    g.discover.reconcile_from = None;
                }
            }
        }
        // --- bounded removal reconcile ----------------------------------------
        if !g.discover.reconciled {
            let sweep = g.discover.sweep;
            let mut from = g.discover.reconcile_from.clone();
            loop {
                let next = match &from {
                    Some(p) => g
                        .files
                        .range((
                            std::ops::Bound::Excluded(p.clone()),
                            std::ops::Bound::Unbounded,
                        ))
                        .next()
                        .map(|(k, _)| k.clone()),
                    None => g.files.keys().next().cloned(),
                };
                let Some(path) = next else {
                    break;
                };
                if !al.visit() {
                    g.discover.reconcile_from = Some(path);
                    g.work.last_pass_entries = g.work.entries.saturating_sub(entries_before);
                    return;
                }
                g.work.file_visits += 1;
                let rel = rel_of(root, &path);
                let seen = g
                    .files
                    .get(&path)
                    .map(|st| st.seen_epoch == sweep)
                    .unwrap_or(false);
                // A restored entry still waiting for its bounded adoption cannot be proven absent yet.
                if !seen && !g.pending.contains_key(&rel) {
                    g.discover.remove.push(path.clone());
                }
                from = Some(path);
            }
            g.discover.reconciled = true;
            g.discover.reconcile_from = None;
        }
        if !g.discover.active {
            return;
        }
        // The sweep is complete: apply the proven-absent paths now (one map removal each, no re-walk).
        for path in std::mem::take(&mut g.discover.remove) {
            let rel = rel_of(root, &path);
            if let Some(st) = g.files.remove(&path) {
                let e = g.removed_generations.entry(rel.clone()).or_insert(0);
                if st.generation > *e {
                    *e = st.generation;
                }
                // Transactional removal candidate: the prior committed row stays durable until the
                // delta carrying this removal commits (tombstone + checkpoint advancement together).
                g.dirty.remove(&rel);
                g.delta_removed.push((rel, st.generation));
            }
        }
        g.discover.active = false;
        g.discover.epoch += 1;
        g.discover.adopted_during_sweep = 0;
        g.work.last_pass_entries = g.work.entries.saturating_sub(entries_before);
        g.discover.ever_complete = true;
        g.work.sweeps += 1;
        g.last_discover = Some(Instant::now());
    }

    /// Whether this file name is one this tail watches (`transcript.jsonl`, `.jsonl`, ...).
    fn matches(&self, path: &Path) -> bool {
        path.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(self.suffix))
    }

    /// Adopt one discovered file into the known map **now** (one charged visit), instead of collecting a
    /// whole-tree `found` set and rebuilding the map when the sweep ends.
    fn adopt_found(&self, g: &mut TailInner, root: &Path, path: &Path) {
        let rel = rel_of(root, path);
        let sweep = g.discover.sweep;
        let existed = g.files.contains_key(path);
        let mut st = g.files.remove(path).unwrap_or_default();
        if !existed {
            let base = g.removed_generations.get(&rel).copied().unwrap_or(0);
            st.generation = st.generation.max(base.saturating_add(1)).max(1);
        } else if st.generation == 0 {
            st.generation = 1;
        }
        st.seen_epoch = sweep;
        if existed {
            g.discover.seen_existing += 1;
        }
        g.dirty.insert(rel);
        g.files.insert(path.to_path_buf(), st);
    }

    /// Adopt restored/pending entries into the known-file map so a restored checkpoint keeps tailing while a
    /// bounded discovery sweep is still running. Bounded per turn (one charged visit each) and resumable: the
    /// remaining entries stay in `pending` for the next turn and are never treated as absent meanwhile.
    fn adopt_pending(g: &mut TailInner, root: &Path, al: &Allowance) {
        if g.pending.is_empty() {
            return;
        }
        loop {
            if !al.visit() {
                return;
            }
            let Some(rel) = g.pending.keys().next().cloned() else {
                return;
            };
            g.work.file_visits += 1;
            if let Some(st) = g.pending.remove(&rel) {
                if g.files.entry(root.join(&rel)).or_insert(st).seen_epoch == 0 {
                    g.discover.adopted_during_sweep += 1;
                }
            }
        }
    }

    /// Bounded, resumable layout detection. Each call inspects at most
    /// [`MAX_DISCOVERY_ENTRIES_PER_PASS`] directory entries, spends at most one allowance and keeps its place, so
    /// a supported file behind more entries than one pass allows is still found on a later call.
    pub fn detect<F>(&self, root: &Path, label: &str, supported: F) -> Detection
    where
        F: Fn(&serde_json::Value) -> bool,
    {
        let al = self.allowance();
        let mut guard = self.inner.lock().expect("tail lock");
        let g: &mut TailInner = &mut guard;
        if g.detect.walk.is_none() {
            g.detect.walk = Some(DirWalk::start(root));
        }
        let mut walk = g.detect.walk.take().expect("detect walk");
        let visited_before = g.work.entries;
        let mut step = DetectStep::Partial;
        let mut inspected = 0usize;
        loop {
            if inspected >= MAX_DISCOVERY_ENTRIES_PER_PASS {
                break;
            }
            match walk.step(&al, &mut g.work) {
                Step::File { path, meta } => {
                    inspected += 1;
                    if meta.is_file() && self.probe_file(&path, &supported, &al, &mut g.work) {
                        step = DetectStep::Found;
                        break;
                    }
                }
                Step::Dir(_) => {
                    inspected += 1;
                }
                Step::MetaError(_) | Step::Unreadable(_) | Step::EntryError => {
                    inspected += 1;
                }
                Step::Budget => break,
                Step::End => {
                    step = DetectStep::Exhausted;
                    break;
                }
            }
        }
        let done = walk.is_done() || matches!(step, DetectStep::Found | DetectStep::Exhausted);
        if done {
            g.detect.walk = None;
        } else {
            g.detect.walk = Some(walk);
        }
        g.work.last_pass_entries = g.work.entries.saturating_sub(visited_before);
        match step {
            DetectStep::Found => Detection::Detected {
                paths: vec![root.to_path_buf()],
            },
            DetectStep::Exhausted => Detection::NotDetected {
                reason: format!("not found: no supported {label} records under root"),
            },
            DetectStep::Partial => Detection::NotDetected {
                reason: format!("not found: still scanning {label} records under root"),
            },
        }
    }

    /// One bounded, charged content probe of a candidate file. Reads at most 64 KiB and looks at the first lines.
    fn probe_file<F>(
        &self,
        path: &Path,
        supported: &F,
        al: &Allowance,
        work: &mut WorkStats,
    ) -> bool
    where
        F: Fn(&serde_json::Value) -> bool,
    {
        let buf = match io::read_bytes(path, 0, 65536, al, work) {
            Ok(ReadOutcome::Data(b)) => b,
            _ => return false,
        };
        let text = String::from_utf8_lossy(&buf);
        for line in text.lines().take(32) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if supported(&v) {
                    return true;
                }
            }
        }
        false
    }

    /// Tails every matching file under `root`; `map` turns one parsed line into items.
    pub fn poll<F>(&self, root: &Path, since: Cursor, history_days: u32, mut map: F) -> Batch
    where
        F: FnMut(&str, &mut FileState, &serde_json::Value, &mut Vec<BatchItem>),
    {
        let al = self.allowance();
        let mut g = self.inner.lock().expect("tail lock");
        g.root = Some(root.to_path_buf());
        g.identities.clear();
        g.work.last_pass_entries = 0;
        g.work.last_pass_file_visits = 0;
        if since.0 == 0 {
            if g.restored {
                g.restored = false;
            } else {
                g.files.clear();
                g.pending.clear();
                g.consumed = 0;
                g.last_discover = None;
                g.next_path = None;
                g.discover.clear();
                g.detect = DetectState::default();
                g.dirty.clear();
                g.delta_removed.clear();
                g.acked.clear();
            }
        }
        Self::adopt_pending(&mut g, root, &al);
        // Discovery is due on a fresh/restored state, on the rediscovery interval, when a bounded sweep is still
        // running, and after a failed sweep (a later fresh retry must be able to discover new paths).
        let due = g
            .last_discover
            .map(|t| t.elapsed() >= REDISCOVER)
            .unwrap_or(true);
        if g.discover.active || due || g.discover.error {
            self.discover_step(&mut g, root, &al);
        }

        let mut items = Vec::new();
        Self::tail_known(root, &mut g, history_days, &mut items, &mut map, &al);
        Batch {
            items,
            next: Cursor(g.consumed),
        }
    }

    /// Verifies the committed content version against the durable witness, in bounded resumable passes. Never
    /// acknowledges a mixed or unknown content version, and restarts a pass whose file changed under it.
    fn verify_committed(
        path: &Path,
        st: &mut FileState,
        len: u64,
        mtime_ms: u64,
        al: &Allowance,
        work: &mut WorkStats,
    ) -> VerifyOutcome {
        let base = match Witness::parse(&st.revision) {
            Some(w) if w.covers_committed(st) => w,
            // Missing, legacy, oversized or non-covering evidence: unknown, never equality.
            _ => return VerifyOutcome::Different,
        };
        let mut v = match base.verify.clone() {
            Some(p) if p.size == len && p.mtime == mtime_ms => p,
            _ => {
                work.verifications_started += 1;
                VerifyProgress {
                    at: 0,
                    hash: chain_seed(),
                    lines: 0,
                    size: len,
                    mtime: mtime_ms,
                }
            }
        };
        loop {
            if v.at >= base.off {
                let mut cleared = base.clone();
                cleared.verify = None;
                st.revision = Some(cleared.render());
                work.verifications_completed += 1;
                return if v.hash == base.hash && v.lines == base.lines {
                    VerifyOutcome::Equal
                } else {
                    VerifyOutcome::Different
                };
            }
            let want = (base.off - v.at)
                .min(al.remaining())
                .min(tail::MAX_BYTES_PER_CALL as u64);
            if want == 0 {
                let mut w = base.clone();
                w.verify = Some(v);
                st.revision = Some(w.render());
                return VerifyOutcome::Progress;
            }
            let (res, _used) =
                match io::read_lines_verify(path, v.at, want as usize, false, al, work) {
                    Ok(ReadOutcome::Data(x)) => x,
                    // No budget or a failed read: bounded progress is kept, equality is not acknowledged.
                    _ => {
                        let mut w = base.clone();
                        w.verify = Some(v);
                        st.revision = Some(w.render());
                        return VerifyOutcome::Progress;
                    }
                };
            // `read_lines_verify` already recorded these bytes in `verify_bytes`; do not add them again.
            let from = v.at;
            let mut reached = from;
            match &res {
                tail::ReadResult::Data {
                    lines,
                    next_offset,
                    line_offsets,
                    line_starts,
                    ..
                } => {
                    for (i, line) in lines.iter().enumerate() {
                        let ls = line_starts
                            .get(i)
                            .copied()
                            .unwrap_or(*next_offset)
                            .min(base.off);
                        let le = line_offsets
                            .get(i)
                            .copied()
                            .unwrap_or(*next_offset)
                            .min(base.off);
                        if ls > reached {
                            v.hash = chain_hash(&v.hash, b'G', reached, ls, &[]);
                        }
                        v.hash = chain_hash(&v.hash, b'L', ls, le, line.as_bytes());
                        v.lines += 1;
                        reached = le;
                    }
                    let end = (*next_offset).min(base.off);
                    if end > reached {
                        v.hash = chain_hash(&v.hash, b'G', reached, end, &[]);
                        reached = end;
                    }
                }
                tail::ReadResult::OversizedLine { next_offset } => {
                    let end = (*next_offset).min(base.off);
                    if end > reached {
                        v.hash = chain_hash(&v.hash, b'G', reached, end, &[]);
                        reached = end;
                    }
                }
            }
            if reached <= from {
                // No forward progress inside the committed region (partial trailing line): stop this pass.
                let mut w = base.clone();
                w.verify = Some(v);
                st.revision = Some(w.render());
                return VerifyOutcome::Progress;
            }
            v.at = reached;
            // Detect a file that changed while it was being verified: drop the progress, acknowledge nothing.
            work.stats += 1;
            let after = std::fs::metadata(path).ok();
            let after_len = after.as_ref().map(|m| m.len()).unwrap_or(len);
            let after_ms = after
                .as_ref()
                .map(|m| ms_of(m.modified().ok()))
                .unwrap_or(Some(mtime_ms));
            if after_len != len || after_ms != Some(mtime_ms) {
                v = VerifyProgress {
                    at: 0,
                    hash: chain_seed(),
                    lines: 0,
                    size: after_len,
                    mtime: after_ms.unwrap_or(mtime_ms),
                };
            }
            let mut w = base.clone();
            w.verify = Some(v.clone());
            st.revision = Some(w.render());
        }
    }

    /// Reads only the known files, from their offsets, in bounded ordered chunks.
    ///
    /// The known map is walked with an ordered range cursor (`next_path`) instead of materialising a path vector
    /// and an index order every turn: one chunk of at most `min(remaining visits, MAX_FILES_PER_PASS)` paths is
    /// taken per round, the cursor wraps at the end so a late-changed file is served within a bounded number of
    /// turns, and every file visit is charged before its work.
    fn tail_known<F>(
        root: &Path,
        g: &mut TailInner,
        history_days: u32,
        items: &mut Vec<BatchItem>,
        map: &mut F,
        al: &Allowance,
    ) where
        F: FnMut(&str, &mut FileState, &serde_json::Value, &mut Vec<BatchItem>),
    {
        if g.files.is_empty() {
            return;
        }
        let now = SystemTime::now();
        let history_cutoff = now - Duration::from_secs(history_days as u64 * 86400);

        let mut lines_this_pass = 0usize;
        let mut files_visited = 0usize;
        let mut progress = true;
        while progress
            && !al.exhausted()
            && lines_this_pass < MAX_LINES_PER_SOURCE_PASS
            && files_visited < MAX_FILES_PER_PASS
        {
            progress = false;
            let want = (al.remaining_visits() as usize)
                .min(MAX_FILES_PER_PASS - files_visited)
                .min(g.files.len());
            if want == 0 {
                break;
            }
            let mut keys: Vec<PathBuf> = Vec::with_capacity(want.min(64));
            match g.next_path.clone() {
                Some(from) => keys.extend(g.files.range(from..).map(|(p, _)| p.clone()).take(want)),
                None => keys.extend(g.files.keys().take(want).cloned()),
            }
            if keys.len() < want {
                keys.extend(g.files.keys().take(want - keys.len()).cloned());
            }
            for key in keys.iter() {
                if al.exhausted()
                    || lines_this_pass >= MAX_LINES_PER_SOURCE_PASS
                    || files_visited >= MAX_FILES_PER_PASS
                {
                    g.work.last_pass_file_visits = files_visited as u64;
                    return;
                }
                let path = key.clone();
                // Charge the visit *before* the work; when the allowance is spent the same path is retried next
                // turn instead of being skipped.
                if !al.visit() {
                    g.next_path = Some(path);
                    g.work.last_pass_file_visits = files_visited as u64;
                    return;
                }
                files_visited += 1;
                g.work.file_visits += 1;
                let next_cursor = match g.files.range(path.clone()..).nth(1) {
                    Some((p, _)) => Some(p.clone()),
                    None => g.files.keys().next().cloned(),
                };
                g.next_path = next_cursor;
                let rel = rel_of(root, &path);
                // One charged visit: this file's state is (re-)upserted in the turn's delta.
                g.dirty.insert(rel.clone());
                let st = g.files.get_mut(&path).expect("known");

                g.work.stats += 1;
                let meta = match std::fs::metadata(&path) {
                    Ok(m) => m,
                    // An uninspectable path is unproven, not absent and not new: keep its parser state and
                    // generation untouched, publish nothing and let a later turn retry the read.
                    Err(_) => continue,
                };
                let (len, mtime) = (meta.len(), meta.modified().ok());
                let mtime_ms = ms_of(mtime).unwrap_or(0);

                // History window: adopt at EOF if too old and never read before. No content is parsed, so the
                // adopted file has no whole-file witness (unknown evidence) and stays silent until it changes.
                if st.offset == 0 && st.mtime.is_none() {
                    if let Some(mt) = mtime {
                        if mt < history_cutoff {
                            let Some(fp) =
                                Self::fingerprint_or_stop(&path, al, &mut g.work, &mut g.next_path)
                            else {
                                st.acked_mtime_ms = Some(mtime_ms);
                                g.work.last_pass_file_visits = files_visited as u64;
                                return;
                            };
                            g.consumed += len;
                            st.offset = len;
                            st.size = len;
                            st.mtime = Some(mt);
                            st.acked_mtime_ms = Some(mtime_ms);
                            st.fingerprint = fp;
                            if st.generation == 0 {
                                st.generation = 1;
                            }
                            continue;
                        }
                    }
                }

                // With no observed baseline (an offsets-only restore) only a size change is observable.
                let baseline = st.acked_mtime_ms.or_else(|| ms_of(st.mtime));
                if baseline.is_none() {
                    st.acked_mtime_ms = Some(mtime_ms);
                }
                let size_changed = len != st.size;
                let mtime_changed = match baseline {
                    Some(prev) => prev != mtime_ms,
                    None => false,
                };

                // The 256-byte prefix sample is read (and charged) on every visit: an equal-size rewrite on a new
                // inode or a preserved mtime must still be visible, so silence cannot rest on metadata alone.
                let Some(fp) = Self::fingerprint_or_stop(&path, al, &mut g.work, &mut g.next_path)
                else {
                    g.work.last_pass_file_visits = files_visited as u64;
                    return;
                };
                let st = g.files.get_mut(&path).expect("known");
                let grew = len > st.size;
                let same_size = len == st.size;
                let prefix_changed = !st.fingerprint.is_empty() && !fp.starts_with(&st.fingerprint);
                let shrank = len < st.size.max(st.offset);
                let changed = size_changed || mtime_changed || prefix_changed;

                if !changed && st.offset >= len {
                    // Nothing observable changed and the file is fully consumed: no payload read.
                    continue;
                }

                let mut replaced = false;
                if shrank
                    || (grew && prefix_changed)
                    || (same_size && !st.fingerprint.is_empty() && fp != st.fingerprint)
                {
                    replaced = true;
                } else if same_size && mtime_changed {
                    // Same size, same prefix and a changed mtime: only a content witness can decide.
                    match Self::verify_committed(&path, st, len, mtime_ms, al, &mut g.work) {
                        VerifyOutcome::Equal => {
                            // Proven metadata-only touch: the durable checkpoint must stay byte-identical, so the
                            // new mtime is only remembered in this process.
                            st.acked_mtime_ms = Some(mtime_ms);
                            continue;
                        }
                        VerifyOutcome::Different => replaced = true,
                        VerifyOutcome::Progress => {
                            g.work.last_pass_file_visits = files_visited as u64;
                            return;
                        }
                    }
                }

                if replaced {
                    let new_gen = st.generation.saturating_add(1).max(1);
                    let seen = st.seen_epoch;
                    *st = FileState {
                        fingerprint: fp.clone(),
                        generation: new_gen,
                        acked_mtime_ms: Some(mtime_ms),
                        seen_epoch: seen,
                        ..FileState::default()
                    };
                } else {
                    // Keep the durable prefix sample current: the bytes before the committed offset did not
                    // change (an append only extends the file), so the sample can grow to the full 256 bytes.
                    st.fingerprint = fp.clone();
                }
                if st.generation == 0 {
                    st.generation = 1;
                }

                if st.offset >= len {
                    st.size = len;
                    st.mtime = mtime;
                    st.acked_mtime_ms = Some(mtime_ms);
                    continue;
                }

                let read_start = st.offset;
                let discard_pending = st.incomplete;
                let read_cap = al.remaining().min(tail::MAX_BYTES_PER_CALL as u64) as usize;
                let pending_bytes = len.saturating_sub(read_start);
                if read_cap == 0 || pending_bytes == 0 {
                    if al.bytes_exhausted() {
                        // Out of content budget: stop before doing more per-file work this turn.
                        g.next_path = Some(path);
                        g.work.last_pass_file_visits = files_visited as u64;
                        return;
                    }
                    st.size = len;
                    st.mtime = mtime;
                    st.acked_mtime_ms = Some(mtime_ms);
                    continue;
                }

                let read = io::read_lines(
                    &path,
                    read_start,
                    read_cap,
                    discard_pending,
                    al,
                    &mut g.work,
                );
                let mut chain = ChainState::from_state(st, read_start);
                // The durable witness is only replaced once a read actually happened: an out-of-budget turn
                // must leave the checkpoint exactly as it was.
                let keep_revision = st.revision.clone();
                st.revision = None;
                match read {
                    Ok(ReadOutcome::NoBudget) => {
                        st.revision = keep_revision;
                        g.next_path = Some(path);
                        g.work.last_pass_file_visits = files_visited as u64;
                        return;
                    }
                    Ok(ReadOutcome::Data((
                        tail::ReadResult::Data {
                            lines,
                            next_offset,
                            line_offsets,
                            line_starts,
                            ..
                        },
                        _used,
                    ))) => {
                        // `read_lines` already recorded the returned bytes in `payload_bytes`.
                        st.incomplete = false;
                        if lines.is_empty() {
                            if next_offset > read_start {
                                let consumed = next_offset.saturating_sub(read_start);
                                chain.mix_gap(next_offset);
                                g.consumed += consumed;
                                st.offset = next_offset;
                                st.size = len;
                                st.mtime = mtime;
                                st.acked_mtime_ms = Some(mtime_ms);
                                st.revision = Some(chain.to_witness().render());
                                progress = true;
                            } else {
                                st.size = len;
                                st.mtime = mtime;
                                st.acked_mtime_ms = Some(mtime_ms);
                            }
                        } else {
                            let mut last_offset = read_start;
                            let mut processed = 0usize;
                            for (i, line) in lines.iter().enumerate() {
                                if processed >= FAIR_LINES_PER_FILE
                                    || lines_this_pass >= MAX_LINES_PER_SOURCE_PASS
                                    || al.exhausted()
                                {
                                    break;
                                }
                                lines_this_pass += 1;
                                processed += 1;
                                let before_items = items.len();
                                let position = line_starts.get(i).copied().unwrap_or(read_start);
                                match serde_json::from_str::<serde_json::Value>(line) {
                                    Ok(v) => map(&rel, st, &v, items),
                                    Err(e) => items.push(BatchItem {
                                        kind: ItemKind::Error,
                                        session: st.session.clone().unwrap_or_else(|| rel.clone()),
                                        data: serde_json::json!({
                                            "file": rel,
                                            "error": format!("bad json line: {e}"),
                                        }),
                                    }),
                                }
                                for k in 0..(items.len() - before_items) {
                                    g.identities.push(RecordKey::offset(
                                        rel.clone(),
                                        st.generation,
                                        position,
                                        k as u32,
                                    ));
                                }
                                last_offset = line_offsets[i];
                                chain.mix_line(line.as_bytes(), position, last_offset);
                            }
                            if processed > 0 {
                                let consumed = last_offset.saturating_sub(read_start);
                                g.consumed += consumed;
                                st.offset = last_offset;
                                st.size = len;
                                st.mtime = mtime;
                                st.acked_mtime_ms = Some(mtime_ms);
                                st.revision = Some(chain.to_witness().render());
                                progress = true;
                            }
                            if processed < lines.len() {
                                // Leave the rest for a later turn (fairness): revisit this file next.
                                g.next_path = Some(path);
                            }
                        }
                    }
                    Ok(ReadOutcome::Data((
                        tail::ReadResult::OversizedLine { next_offset },
                        _used,
                    ))) => {
                        // `read_lines` already recorded the returned bytes in `payload_bytes`.
                        let consumed = next_offset.saturating_sub(read_start);
                        g.consumed += consumed;
                        items.push(BatchItem {
                            kind: ItemKind::Error,
                            session: st.session.clone().unwrap_or_else(|| rel.clone()),
                            data: serde_json::json!({
                                "file": rel,
                                "error": format!("oversized line skipped at offset {}", read_start),
                            }),
                        });
                        g.identities.push(RecordKey::offset(
                            rel.clone(),
                            st.generation,
                            read_start,
                            0,
                        ));
                        st.offset = next_offset;
                        st.size = len;
                        st.mtime = mtime;
                        st.acked_mtime_ms = Some(mtime_ms);
                        st.discarded_bytes += consumed;
                        // The boundary byte is charged to the same allowance as every other read.
                        let still_discarding = if next_offset > 0 {
                            match io::read_bytes(&path, next_offset - 1, 1, al, &mut g.work) {
                                Ok(ReadOutcome::Data(b)) => b.first().is_some_and(|b| *b != b'\n'),
                                Ok(ReadOutcome::NoBudget) => true,
                                Err(_) => true,
                            }
                        } else {
                            true
                        };
                        chain.mix_gap(next_offset);
                        st.incomplete = still_discarding;
                        st.revision = Some(chain.to_witness().render());
                        progress = true;
                        if al.exhausted() {
                            g.work.last_pass_file_visits = files_visited as u64;
                            return;
                        }
                    }
                    Err(e) => {
                        // Nothing was read: keep the checkpoint so the read is retried, and report the error.
                        items.push(BatchItem {
                            kind: ItemKind::Error,
                            session: st.session.clone().unwrap_or_else(|| rel.clone()),
                            data: serde_json::json!({"file": rel, "error": e.to_string()}),
                        });
                        g.identities.push(RecordKey::offset(
                            rel.clone(),
                            st.generation,
                            st.offset,
                            0,
                        ));
                    }
                }
            }
        }
        g.work.last_pass_file_visits = files_visited as u64;
    }

    /// Fingerprint of one known file; `None` means the turn allowance had nothing left (stop the pass, keep the
    /// cursor) and an I/O error means "retry this path later", never "the content changed".
    fn fingerprint_or_stop(
        path: &Path,
        al: &Allowance,
        work: &mut WorkStats,
        cursor: &mut Option<PathBuf>,
    ) -> Option<String> {
        match fingerprint_charged(path, al, work) {
            Ok(ReadOutcome::Data(fp)) => Some(fp),
            Ok(ReadOutcome::NoBudget) => {
                *cursor = Some(path.to_path_buf());
                None
            }
            Err(_) => {
                *cursor = Some(path.to_path_buf());
                None
            }
        }
    }

    /// Producer identities emitted during the most recent poll, aligned 1:1 with Batch::items.
    pub fn identities(&self) -> Vec<RecordKey> {
        self.inner.lock().expect("tail lock").identities.clone()
    }

    /// Consumed offsets per file (path relative to the adapter root), for persistence.
    pub fn offsets(&self) -> Vec<FileOffset> {
        let g = self.inner.lock().expect("tail lock");
        let mut out: Vec<FileOffset> = g
            .pending
            .iter()
            .map(|(path, st)| FileOffset {
                path: path.clone(),
                offset: st.offset,
                size: st.size,
            })
            .collect();
        if let Some(root) = &g.root {
            for (p, st) in &g.files {
                out.push(FileOffset {
                    path: rel_of(root, p),
                    offset: st.offset,
                    size: st.size,
                });
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out.dedup_by(|a, b| a.path == b.path);
        out
    }

    /// Marks `offs` as already consumed. The next poll (any cursor) reads only newer bytes; a
    /// file now smaller than its restored size restarts at 0.
    pub fn restore(&self, offs: Vec<FileOffset>) {
        let mut g = self.inner.lock().expect("tail lock");
        g.dirty.clear();
        g.delta_removed.clear();
        g.acked = offs
            .iter()
            .map(|o| {
                (
                    o.path.clone(),
                    crate::core::FileCheckpoint {
                        path: o.path.clone(),
                        offset: o.offset,
                        size: o.size,
                        ..Default::default()
                    },
                )
            })
            .collect();
        g.files.clear();
        g.consumed = offs.iter().map(|o| o.offset).sum();
        g.pending = offs
            .into_iter()
            .map(|o| {
                (
                    o.path.clone(),
                    FileState {
                        offset: o.offset,
                        size: o.size,
                        announced: o.offset > 0,
                        ..FileState::default()
                    },
                )
            })
            .collect();
        g.last_discover = None;
        g.restored = true;
        g.discover.clear();
    }

    /// Bounded checkpoint delta since the last delta was taken (dirty drain): changed/visited file
    /// states plus removal candidates from completed sweeps. At most one entry per charged visit in
    /// the turns since the last take (\u2264200 per turn), never the whole resident population.
    pub fn checkpoint_delta(&self) -> crate::core::CheckpointDelta {
        let mut g = self.inner.lock().expect("tail lock");
        let dirty = std::mem::take(&mut g.dirty);
        let removed_raw = std::mem::take(&mut g.delta_removed);
        let mut upserts = Vec::with_capacity(dirty.len());
        for rel in &dirty {
            let st = g
                .root
                .as_ref()
                .and_then(|root| g.files.get(&root.join(rel)))
                .or_else(|| g.pending.get(rel));
            if let Some(st) = st {
                let fc = checkpoint_of(rel.clone(), st);
                // Only real changes are emitted: a visited-but-unchanged file (metadata-only
                // touch, unchanged restart) compares equal to its acked state and stays silent.
                if g.acked.get(rel) != Some(&fc) {
                    g.acked.insert(rel.clone(), fc.clone());
                    upserts.push(fc);
                }
            }
        }
        // `dirty` is a BTreeSet, so `upserts` is already ordered by path.
        let removed = removed_raw
            .into_iter()
            .map(|(path, generation)| {
                g.acked.remove(&path);
                crate::core::RemovedPath {
                    path,
                    generation,
                    removed_ms: crate::core::now_ms(),
                }
            })
            .collect();
        crate::core::CheckpointDelta {
            upserts,
            revisions: std::collections::BTreeMap::new(),
            removed,
        }
    }

    /// Pending checkpoint delta as a `SourceCheckpoint` (changed files + revisions). Taking it
    /// drains the delta, exactly like [`JsonlTail::checkpoint_delta`].
    pub fn checkpoint(&self) -> crate::core::SourceCheckpoint {
        let delta = self.checkpoint_delta();
        crate::core::SourceCheckpoint {
            files: delta.upserts,
            revisions: delta.revisions,
        }
    }

    /// The complete checkpoint (all known + pending files), for restore/serialization callers.
    /// Never drains the delta: the pending changes stay pending for the next delta take.
    pub fn full_checkpoint(&self) -> crate::core::SourceCheckpoint {
        let g = self.inner.lock().expect("tail lock");
        let mut files = Vec::new();
        let mut seen_paths = BTreeSet::new();
        if let Some(root) = &g.root {
            for (p, st) in &g.files {
                let path = rel_of(root, p);
                seen_paths.insert(path.clone());
                files.push(checkpoint_of(path, st));
            }
        }
        for (path, st) in &g.pending {
            if seen_paths.contains(path) {
                continue;
            }
            files.push(checkpoint_of(path.clone(), st));
        }
        // `g.files` is keyed by absolute path and `g.pending` by relative path; both are ordered, and the root
        // prefix is common, so a two-run merge keeps the checkpoint sorted by path without a full sort.
        files.sort_by(|a, b| a.path.cmp(&b.path));
        crate::core::SourceCheckpoint {
            files,
            revisions: std::collections::BTreeMap::new(),
        }
    }

    pub fn restore_checkpoint(&self, checkpoint: crate::core::SourceCheckpoint) {
        let mut g = self.inner.lock().expect("tail lock");
        g.dirty.clear();
        g.delta_removed.clear();
        g.acked = checkpoint
            .files
            .iter()
            .map(|f| (f.path.clone(), f.clone()))
            .collect();
        g.files.clear();
        g.pending.clear();
        g.consumed = checkpoint.files.iter().map(|f| f.offset).sum();
        for f in checkpoint.files {
            let mtime = if f.mtime_ms == 0 {
                None
            } else {
                std::time::SystemTime::UNIX_EPOCH
                    .checked_add(std::time::Duration::from_millis(f.mtime_ms))
            };
            g.pending.insert(
                f.path.clone(),
                FileState {
                    offset: f.offset,
                    size: f.size,
                    mtime,
                    fingerprint: f.fingerprint,
                    session: f.session,
                    model: f.model,
                    announced: f.announced,
                    generation: if f.generation == 0 { 1 } else { f.generation },
                    discarded_bytes: f.discarded_bytes,
                    incomplete: f.incomplete,
                    revision: f.revision,
                    acked_mtime_ms: None,
                    seen_epoch: 0,
                },
            );
        }
        g.last_discover = None;
        g.restored = true;
        g.discover.clear();
    }

    pub fn restore_removed(&self, removed: &[crate::core::RemovedPath]) {
        let mut g = self.inner.lock().expect("tail lock");
        for r in removed {
            let e = g.removed_generations.entry(r.path.clone()).or_insert(0);
            if r.generation > *e {
                *e = r.generation;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_defaults_and_opt_out() {
        let home = Path::new("/nonexistent-home");
        let ids = |c: &Config| -> Vec<&'static str> {
            registry_with_home(c, home).iter().map(|s| s.id()).collect()
        };
        assert_eq!(
            ids(&Config::default()),
            vec![
                "plans-harness",
                "claude-code",
                "codex",
                "opencode",
                "agy",
                "pi"
            ]
        );
        let mut c = Config::default();
        c.sources.insert("codex".into(), false);
        c.sources.insert("fake".into(), true);
        assert_eq!(
            ids(&c),
            vec![
                "plans-harness",
                "claude-code",
                "opencode",
                "agy",
                "pi",
                "fake"
            ]
        );
    }

    #[test]
    fn root_spec_reasons() {
        let s = RootSpec {
            over: None,
            default_rel: ".codex/sessions",
        };
        match s.detect(Path::new("/nonexistent-home")) {
            Detection::NotDetected { reason } => assert_eq!(reason, "~/.codex/sessions not found"),
            d => panic!("{d:?}"),
        }
    }
}

#[cfg(test)]
mod witness_tests {
    //! Narrow unit guards for the adapter-private content witness, its canonical serialization, and the bounded
    //! discovery/detection continuation. Adapter -> store behaviour is covered by the owned integration targets.

    use super::*;
    use crate::core::Env;

    fn claude_line(model: &str) -> String {
        format!(
            "{{\"type\":\"assistant\",\"sessionId\":\"s1\",\"message\":{{\"role\":\"assistant\",\"model\":\"{model}\"}},\"timestamp\":\"2026-11-01T00:00:00.000Z\"}}\n"
        )
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn touch_in(path: &Path, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let times = std::fs::FileTimes::new()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(secs));
        f.set_times(times).unwrap();
    }

    #[test]
    fn witness_serialization_is_canonical_and_rejects_legacy_hashes() {
        let w = Witness {
            v: WITNESS_VERSION,
            from: 0,
            off: 10,
            lines: 1,
            hash: "ab".repeat(32),
            verify: None,
        };
        let once = w.render();
        assert_eq!(Witness::parse(&Some(once.clone())), Some(w.clone()));
        assert_eq!(
            Witness::parse(&Some(once.clone())).unwrap().render(),
            once,
            "re-rendering a parsed witness must not change the durable checkpoint"
        );
        assert_eq!(
            Witness::parse(&Some("ab".repeat(32))),
            None,
            "a legacy bare content hash is unknown evidence, never equality"
        );
        assert_eq!(Witness::parse(&None), None);
    }

    #[test]
    fn chain_shifts_when_a_committed_line_changes() {
        let mut a = ChainState::fresh(0);
        a.mix_line(b"one", 0, 4);
        a.mix_line(b"two", 4, 8);
        let mut b = ChainState::fresh(0);
        b.mix_line(b"one", 0, 4);
        b.mix_line(b"twO", 4, 8);
        assert_ne!(
            a.hash, b.hash,
            "a same-size line edit must change the chain"
        );
        assert_eq!(a.off, b.off);
        let mut c = ChainState::fresh(0);
        c.mix_line(b"one", 0, 4);
        c.mix_line(b"two", 4, 8);
        assert_eq!(a.hash, c.hash, "the chain is deterministic");
    }

    /// B1: a metadata-only touch after an append must not change the durable checkpoint or emit items.
    #[test]
    fn touch_after_append_keeps_the_witness_and_stays_silent() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path();
        let path = home.join(".claude/projects/p/a.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, claude_line("a")).unwrap();
        let src = claude_code::ClaudeCode::new(None, home, 30);
        let b1 = block_on(src.poll(Cursor(0))).unwrap();
        assert_eq!(b1.items.len(), 2, "session + step");

        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(claude_line("b").as_bytes()).unwrap();
        f.flush().unwrap();
        let b2 = block_on(src.poll(Cursor(1))).unwrap();
        assert_eq!(b2.items.len(), 1, "one appended step");

        let saved = src.full_checkpoint();
        let w =
            Witness::parse(&saved.files[0].revision).expect("append keeps a whole-file witness");
        assert_eq!((w.from, w.off, w.lines), (0, saved.files[0].offset, 2));

        // Drain/ack the append turn's delta (as the poller does on commit) before the touch.
        let _ = src.checkpoint();
        touch_in(&path, 3 * 3600);
        let b3 = block_on(src.poll(Cursor(1))).unwrap();
        assert!(
            b3.items.is_empty(),
            "a touch must not replay: {:?}",
            b3.items
        );
        assert!(
            src.checkpoint().files.is_empty(),
            "a proven metadata-only touch must produce no checkpoint delta"
        );
        assert_eq!(
            src.full_checkpoint().files[0],
            saved.files[0],
            "a proven metadata-only touch must leave the durable checkpoint byte-identical"
        );
    }

    /// A same-size rewrite on a new inode is a replacement even when size and mtime are byte-identical.
    #[test]
    fn equal_size_new_inode_rewrite_is_a_replacement() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path();
        let path = home.join(".claude/projects/p/a.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, claude_line("a")).unwrap();
        let src = claude_code::ClaudeCode::new(None, home, 30);
        block_on(src.poll(Cursor(0))).unwrap();
        let saved = src.checkpoint();
        let tmp = home.join(".claude/projects/p/a.jsonl.new");
        std::fs::write(&tmp, claude_line("b")).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        // Preserve the observed size *and* mtime so only the content differs.
        let mtime = saved.files[0].mtime_ms;
        let f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(mtime),
        ))
        .unwrap();
        let b = block_on(src.poll(Cursor(1))).unwrap();
        assert!(
            b.items
                .iter()
                .any(|i| i.data.get("model").and_then(|m| m.as_str()) == Some("b")),
            "the equal-size rewrite must be re-read: {:?}",
            b.items
        );
    }

    /// Detection is bounded per call but keeps a continuation: entries beyond one pass are still scanned.
    #[test]
    fn detection_continues_past_one_entry_pass() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path();
        let dir = home.join(".claude/projects/fair");
        std::fs::create_dir_all(dir.join("deep/last")).unwrap();
        for i in 0..240 {
            std::fs::write(
                dir.join(format!("a{i:03}.jsonl")),
                b"{\"type\":\"log\",\"note\":\"unsupported\"}\n",
            )
            .unwrap();
        }
        std::fs::write(dir.join("deep/last/supported.jsonl"), claude_line("m")).unwrap();
        let src = claude_code::ClaudeCode::new(None, home, 30);
        let env = Env {
            home: home.to_path_buf(),
            vars: Default::default(),
        };
        let mut detected_at = None;
        for attempt in 0..4 {
            if matches!(src.detect(&env), Detection::Detected { .. }) {
                detected_at = Some(attempt);
                break;
            }
            assert!(
                src.work_stats().last_pass_entries <= MAX_DISCOVERY_ENTRIES_PER_PASS as u64
                    || src.work_stats().last_pass_entries == 0,
                "one detection pass must stay within the entry bound"
            );
        }
        assert!(
            detected_at.is_some(),
            "a supported file behind 240 candidates must be found by repeated bounded detection"
        );
    }

    /// Before the first complete sweep the tail must not claim discovery completion.
    #[test]
    fn fresh_tail_has_not_completed_a_sweep() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path();
        std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
        let src = claude_code::ClaudeCode::new(None, home, 30);
        assert!(!src.discovery_complete_now());
        block_on(src.poll(Cursor(0))).unwrap();
        assert!(
            src.discovery_complete_now(),
            "a complete successful sweep reports completion"
        );
    }
}

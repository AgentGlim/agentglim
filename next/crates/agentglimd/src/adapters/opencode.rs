//! opencode adapter: reads the JSON-file store `~/.local/share/opencode/storage/`
//! (`session/<project>/<ses_id>.json`, `message/<ses_id>/<msg_id>.json`; `part/` is skipped).
//! format: unverified against a real install (layout from third-party parsers; newer opencode
//! releases may keep data in SQLite instead, which this adapter does not read).
//! One JSON document per file: a file is "done" once emitted; an assistant message is emitted
//! only after `time.completed` is set, and is reread when its content or metadata changes.
//!
//! ## Whole-turn accounting (v5)
//! One scheduled turn is `begin_turn` → `detect` → `poll` → `end_turn` and draws on exactly the one
//! [`TurnBudget`] core creates. Directory entries, per-item work visits and every byte of sample,
//! payload and verification I/O are charged to that single allowance through the shared
//! [`super::io`] boundary — this adapter owns no counter of its own. A standalone `detect`/`poll`
//! (no `begin_turn`) is bounded by one `Allowance::standalone()` for that call.
//!
//! ## Discovery cadence (v5)
//! A new discovery sweep starts on the 15-second discovery tick (`detect` marks it due) or for a
//! source that has never swept / is called standalone. A scheduled 2-second poll only *continues*
//! an unfinished sweep; it does not restart discovery on every call. Directory enumeration uses the
//! resumable [`super::io::DirWalk`] (one open `ReadDir` + pending-dir stack, no whole-directory
//! vector, no sort). Only a completed, error-free sweep reconciles removals, and that reconciliation
//! is itself visit-charged and resumable, so a partial sweep can never prove a path absent.
//!
//! ## Content witnesses (v5)
//! A document up to [`SAMPLE_FULL_MAX`] bytes is sampled in full, so its sample is exact content
//! evidence. For a larger document, an unchanged bounded sample plus unchanged inode/length/mtime is
//! **not** equality evidence: the adapter keeps a resumable, chunked full-content witness
//! ([`VERIFY_CHUNK`]-aligned fold digest) that advances on subsequent turns, so an edit that lands
//! between the sample windows is still observed. Witness progress is persisted in the existing
//! `FileCheckpoint.revision` string (versioned JSON; a plain integer stays the legacy format) and the
//! witness digest in `FileCheckpoint.fingerprint`, so a restart resumes instead of restarting.
//!
//! ## Deferred payload (v5-r3)
//! A completed witness that proves a *changed* version becomes a durable candidate bound to the exact
//! version it verified (length, acknowledged mtime, physical generation, bounded sample) plus its fold
//! digest. If the rest of the turn's byte allowance cannot hold the document, the candidate is persisted
//! (`FileCheckpoint.fingerprint`) instead of being thrown away, so a later turn — or a restart at that
//! exact boundary — validates and publishes it once instead of re-verifying from scratch. A document that
//! moves while the candidate waits invalidates it and verification restarts; a payload that does not
//! reproduce the candidate digest is never parsed or published.
//!
//! ## Finished documents
//! A document larger than [`MAX_DOC_BYTES`] (4 MiB − 16 KiB) is diagnosed once per physical version
//! instead of being read; invalid/partial JSON is diagnosed once and retried when it changes; a
//! document that changed while it was read publishes nothing and is retried. Sessions are visited
//! before messages in each round-robin pass.

use super::io::{read_bytes, Allowance, DirWalk, ReadOutcome, Step};
use super::{
    RootSpec, WorkStats, MAX_BYTES_PER_PASS, MAX_DISCOVERY_ENTRIES_PER_PASS, MAX_FILES_PER_PASS,
};
use crate::core::{
    now_ms, Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, FileCheckpoint,
    FileOffset, ItemKind, RecordKey, Source, SourceCheckpoint, SourceKind, TurnBudget,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

pub const ID: &str = "opencode";

/// Largest single JSON document this adapter will read in one call. [`MAX_BYTES_PER_PASS`] minus
/// headroom for the sample reads and other documents charged in the same call. A larger document is
/// explicitly diagnosed (once per physical version) and never silently accepted.
pub const MAX_DOC_BYTES: u64 = MAX_BYTES_PER_PASS - 16 * 1024;

/// A document up to this size is sampled in full, proving exact content equality.
pub const SAMPLE_FULL_MAX: u64 = 4096;
/// Window size used for larger documents.
pub const SAMPLE_WINDOW: u64 = 256;
/// Number of windows used for larger documents (head, thirds and tail).
pub const SAMPLE_WINDOWS: usize = 4;
/// Upper bound on the bytes charged to sample one file.
pub const SAMPLE_MAX_BYTES: u64 = SAMPLE_FULL_MAX;

/// Work visits a turn keeps for known-file content work even while a discovery sweep is unfinished.
///
/// Discovery and known-file visits share one 200-visit allowance (no second budget): reserving a
/// floor for content work stops a large tree from spending an entire turn on enumeration and
/// returning an empty batch, so every turn makes content progress as well as discovery progress.
pub const CONTENT_VISIT_RESERVE: u64 = 64;

/// Work visits a turn keeps for discovery while known-file content work runs first.
pub const DISCOVERY_VISIT_RESERVE: u64 = 64;

/// Bytes of one full-content witness step. A document is verified in aligned chunks of exactly this
/// size (the final chunk may be shorter), so the fold digest can be resumed from any persisted offset
/// without depending on how earlier turns happened to slice the reads.
pub const VERIFY_CHUNK: u64 = 4 * 1024;

/// Aligned witness chunks one known-file visit may verify (a finite derived per-visit bound).
pub const WITNESS_CHUNKS_PER_VISIT: u32 = 32;

/// Domain separator for the resumable witness fold, so a witness digest can never be confused with a
/// plain SHA-256 of the document.
const WITNESS_DOMAIN: &[u8] = b"agentglim/opencode/witness/v1";

/// Minimum age of the running sweep before a *scheduled* turn may start a fresh one (the production discovery
/// tick is 15 s; the adapter keeps the floor itself so a shorter configured tick cannot multiply sweeps).
pub const SWEEP_INTERVAL_MS: u64 = 15_000;

#[derive(Clone)]
struct JFile {
    size: u64,
    mtime: Option<SystemTime>,
    done: bool,
    /// Bounded content sample used to detect same-inode/same-size revisions.
    sample: String,
    /// Plain SHA-256 of the whole document, for documents larger than [`SAMPLE_FULL_MAX`]. Used to
    /// decide a metadata-only change when the mtime moved. Empty for small documents and legacy rows.
    content_hash: String,
    /// Digest of the last completed full-content witness (see [`VERIFY_CHUNK`]). Empty means unknown;
    /// unknown is **never** equality evidence.
    witness_hash: String,
    generation: u64,
    revision: u64,
    session: Option<String>,
    model: Option<String>,
    /// Discovery epoch that last saw this path. Only a completed sweep reconciles stale epochs.
    epoch: u64,
    /// In-progress full-content witness pass (survives a turn and, through the checkpoint, a restart).
    verify: Option<Witness>,
    /// A *completed* witness for one exact document version whose payload read was deferred because the
    /// rest of that turn's byte allowance could not hold the document. Without it the completed pass is
    /// thrown away and verification starts over every turn, so a near-ceiling supported document would
    /// livelock instead of publishing its edit. Persisted across turns and restarts; only a payload that
    /// reproduces [`Candidate::chain`] exactly may be published.
    candidate: Option<Candidate>,
}

impl Default for JFile {
    /// A newly discovered file starts at size 0 so the first visit processes it.
    fn default() -> Self {
        Self {
            size: 0,
            mtime: None,
            done: false,
            sample: String::new(),
            content_hash: String::new(),
            witness_hash: String::new(),
            generation: 0,
            revision: 0,
            session: None,
            model: None,
            epoch: 0,
            verify: None,
            candidate: None,
        }
    }
}

/// A completed full-content witness carried across a deferred payload read.
///
/// It is bound to the exact version it verified (length, acknowledged mtime, physical generation and —
/// through [`JFile::sample`] — the bounded content sample), so any change while the payload work waits
/// invalidates it. The fold chain is the coherence check: the payload read on a later turn must reproduce
/// it byte-for-byte before anything is parsed or published.
#[derive(Clone, PartialEq, Eq)]
struct Candidate {
    /// Fold digest (`WITNESS_DOMAIN` chain) of the exact verified version.
    chain: String,
    /// Document length this candidate proves.
    size: u64,
    /// Acknowledged mtime (ms) this candidate proves.
    mtime_ms: u64,
    /// Physical generation (device+inode) this candidate proves.
    generation: u64,
}

impl Candidate {
    /// Whether this candidate still describes the version just observed.
    fn matches(&self, len: u64, mtime_ms: u64, generation: u64) -> bool {
        self.size == len && self.mtime_ms == mtime_ms && self.generation == generation
    }
}

/// Persistent progress of one resumable full-content witness pass.
#[derive(Clone, Default, PartialEq, Eq)]
struct Witness {
    /// Aligned offset verified so far (`0` = nothing yet).
    at: u64,
    /// Fold digest of `[0, at)` (hex).
    chain: String,
    /// Document length this pass is proving; a different length restarts the pass.
    size: u64,
    /// Acknowledged mtime (ms) this pass is proving; a different mtime restarts the pass.
    mtime_ms: u64,
    /// Physical generation (device+inode) this pass is proving.
    generation: u64,
}

#[derive(Default)]
struct Sweep {
    active: bool,
    epoch: u64,
    /// One resumable walk per supported subtree (`session`, `message`), in that order.
    walks: Vec<DirWalk>,
    next_walk: usize,
    /// Any unreadable directory, unprovable metadata or iterator error: no removal evidence.
    ok: bool,
    /// Bounded, resumable epoch reconciliation. 0 = sessions, 1 = messages, 2 = restored pending.
    rec_phase: u8,
    rec_cursor: Option<String>,
    reconciling: bool,
}

/// Bounded, resumable layout probe for [`OpenCode::detect`] (never a whole-tree vector).
#[derive(Default)]
struct Probe {
    walks: Vec<DirWalk>,
    next_walk: usize,
}

#[derive(Default)]
struct Inner {
    /// Known files of the two supported subtrees, keyed by root-relative path. Two maps keep
    /// session-before-message ordering without ever sorting the whole tree.
    sessions: BTreeMap<String, JFile>,
    messages: BTreeMap<String, JFile>,
    /// Restored parser state that a completed sweep has not matched to a file yet.
    pending: BTreeMap<String, JFile>,
    root: Option<PathBuf>,
    consumed: u64,
    restored: bool,
    /// Round-robin known-file continuation: subtree phase and the last path visited.
    visit_phase: u8,
    visit_cursor: Option<String>,
    sweep: Sweep,
    /// Whether a new sweep is due (discovery tick / never swept).
    sweep_due: bool,
    /// Wall clock (ms) of the last sweep start; the 15 s cadence floor is measured against it.
    last_sweep_start_ms: Option<u64>,
    /// Sweeps started by this instance (cadence observability, never reset by a turn).
    sweep_starts: u64,
    /// Completed, error-free sweeps (the durable discovery epoch core reads).
    sweeps_done: u64,
    epoch_seq: u64,
    probe: Option<Probe>,
    /// True only for the poll in which a completed, error-free sweep also finished reconciling.
    complete_this_poll: bool,
    /// Last diagnostic emitted for a path, so an unchanged oversized/invalid document is reported
    /// once instead of on every call.
    diag: BTreeMap<String, String>,
    /// Per-path accepted-revision high-water of paths a completed sweep proved absent. Kept so a path that
    /// reappears is observed under a *new* revision instead of recycling a key the store already holds.
    retired_rev: BTreeMap<String, u64>,
    /// Producer identities of the most recent [`Source::poll`], aligned 1:1 with its items.
    identities: Vec<RecordKey>,
    /// Injectable clock (ms since the epoch) used only by tests; `None` = wall clock.
    clock: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
    /// The shared whole-turn allowance, present between `begin_turn` and `end_turn`.
    budget: Option<Arc<TurnBudget>>,
    /// Application work counters for this turn (never a physical-I/O claim).
    work: WorkStats,
}

/// Items emitted by one poll together with their 1:1 durable producer identities.
///
/// Every payload item belongs to one accepted *revision* of one document:
/// `RecordKey::revision(rel, JFile::revision, item-in-document)`. The revision counter is persisted in the
/// checkpoint, so A -> B -> A is three distinct keys, an unchanged restart re-emits nothing, and a
/// reappearance after a proven removal continues above the retired high-water instead of recycling a key the
/// store already holds. Diagnostics are identified by their physical-version token, so a re-diagnosis of the
/// same version is deduplicated by the store instead of being stored twice.
#[derive(Default)]
struct Out {
    items: Vec<BatchItem>,
    keys: Vec<RecordKey>,
    /// Index of the next item inside the document revision currently being emitted.
    item_index: u32,
}

impl Out {
    /// Starts a new document emission scope.
    fn begin_doc(&mut self) {
        self.item_index = 0;
    }

    /// Appends one item of `rel`'s accepted revision `rev`.
    fn push(&mut self, rel: &str, rev: u64, item: BatchItem) {
        self.keys
            .push(RecordKey::revision(rel, rev.to_string(), self.item_index));
        self.item_index = self.item_index.wrapping_add(1);
        self.items.push(item);
    }

    /// Appends a diagnostic identified by its physical-version token.
    fn push_diag(&mut self, rel: &str, token: &str, item: BatchItem) {
        self.keys
            .push(RecordKey::revision(rel, format!("d:{token}"), 0));
        self.items.push(item);
    }
}

pub struct OpenCode {
    spec: RootSpec,
    home: PathBuf,
    inner: Mutex<Inner>,
    history_days: u32,
}

impl OpenCode {
    pub fn new(root: Option<PathBuf>, home: &Path, history_days: u32) -> Self {
        Self {
            spec: RootSpec {
                over: root,
                default_rel: ".local/share/opencode/storage",
            },
            home: home.to_path_buf(),
            inner: Mutex::new(Inner {
                sweep_due: true,
                ..Inner::default()
            }),
            history_days: if (1..=365).contains(&history_days) {
                history_days
            } else {
                30
            },
        }
    }

    /// Application work counters for the current (or most recent) turn.
    pub fn work_stats(&self) -> WorkStats {
        self.inner.lock().expect("opencode lock").work
    }

    /// Whether the most recent poll ended a complete, error-free sweep *and* reconciled removals.
    pub fn discovery_complete_now(&self) -> bool {
        self.inner.lock().expect("opencode lock").complete_this_poll
    }

    /// Number of discovery sweeps this instance has *started* (cadence observability, per instance and never
    /// reset by a turn). Used to prove the 15 s floor and the absence of a catch-up storm.
    pub fn sweep_starts(&self) -> u64 {
        self.inner.lock().expect("opencode lock").sweep_starts
    }

    /// Replaces the clock the sweep cadence is measured against. `None` restores the wall clock. Test-only
    /// injection: production never calls it, and it changes nothing except the due-time comparison.
    pub fn set_clock(&self, clock: Option<Arc<dyn Fn() -> u64 + Send + Sync>>) {
        self.inner.lock().expect("opencode lock").clock = clock;
    }

    /// Current time (ms since the epoch) for cadence decisions.
    fn now(g: &Inner) -> u64 {
        match &g.clock {
            Some(c) => c(),
            None => now_ms(),
        }
    }

    /// The allowance for this call: the shared whole-turn one when a turn is open, else one private
    /// allowance for this standalone call (never a second budget inside a turn).
    fn allowance(g: &Inner) -> Allowance {
        match &g.budget {
            Some(b) => Allowance::new(b.clone()),
            None => Allowance::standalone(),
        }
    }
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn n(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// Milliseconds since the epoch; comparisons are normalized to this precision because a persisted
/// checkpoint only keeps milliseconds (D02).
fn millis(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let b = s.as_bytes();
    for i in (0..b.len()).step_by(2) {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// Start of a witness fold chain.
fn chain_init() -> String {
    let mut h = Sha256::new();
    h.update(WITNESS_DOMAIN);
    hex(h.finalize().as_slice())
}

/// Folds one aligned chunk into the witness chain.
fn chain_fold(chain: &str, chunk: &[u8]) -> String {
    let prev = from_hex(chain).unwrap_or_else(|| {
        let mut h = Sha256::new();
        h.update(WITNESS_DOMAIN);
        h.finalize().to_vec()
    });
    let mut h = Sha256::new();
    h.update(&prev);
    h.update(chunk);
    hex(h.finalize().as_slice())
}

/// Witness digest of a whole in-memory document, chunked exactly like the resumable pass.
fn witness_digest(buf: &[u8]) -> String {
    let mut chain = chain_init();
    for chunk in buf.chunks(VERIFY_CHUNK as usize) {
        chain = chain_fold(&chain, chunk);
    }
    chain
}

#[cfg(unix)]
fn file_generation(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.dev()
        .wrapping_mul(0x9e3779b97f4a7c15)
        .wrapping_add(meta.ino())
}

#[cfg(not(unix))]
fn file_generation(_meta: &std::fs::Metadata) -> u64 {
    0
}

/// Bytes this adapter plans to read to sample a document of `len` bytes (charged before reading).
pub fn planned_sample_bytes(len: u64) -> u64 {
    if len <= SAMPLE_FULL_MAX {
        len
    } else {
        SAMPLE_WINDOW * SAMPLE_WINDOWS as u64
    }
}

/// Bounded content sample: the whole document when small, otherwise head/one-third/two-thirds/tail
/// windows joined with `:` (empty part where two offsets coincide). `None` means the shared allowance
/// had no bytes left, so the visit must be retried on a later turn.
fn read_sample(
    path: &Path,
    len: u64,
    al: &Allowance,
    work: &mut WorkStats,
) -> std::io::Result<Option<(String, u64)>> {
    let mut read = 0u64;
    let mut parts: Vec<String> = Vec::new();
    if len <= SAMPLE_FULL_MAX {
        match read_bytes(path, 0, len as usize, al, work)? {
            ReadOutcome::NoBudget => return Ok(None),
            ReadOutcome::Data(buf) => {
                read += buf.len() as u64;
                parts.push(hex(&buf));
            }
        }
    } else {
        let last = len - SAMPLE_WINDOW;
        let offsets = [0u64, last / 3, (last * 2) / 3, last];
        let mut prev: Option<u64> = None;
        for off in offsets {
            if prev == Some(off) {
                parts.push(String::new());
                continue;
            }
            prev = Some(off);
            match read_bytes(path, off, SAMPLE_WINDOW as usize, al, work)? {
                ReadOutcome::NoBudget => return Ok(None),
                ReadOutcome::Data(buf) => {
                    if buf.len() as u64 != SAMPLE_WINDOW {
                        // The document shrank under the sample: no evidence, retry later.
                        return Ok(None);
                    }
                    read += SAMPLE_WINDOW;
                    parts.push(hex(&buf));
                }
            }
        }
    }
    work.payload_bytes += read;
    Ok(Some((parts.join(":"), read)))
}

/// Sessions sort before messages so a session is announced first.
fn phase_of(rel: &str) -> u8 {
    u8::from(!rel.starts_with("session/"))
}

fn supported_rel(rel: &str) -> bool {
    rel.starts_with("session/") || rel.starts_with("message/")
}

// format: unverified
fn map_doc(rel: &str, v: &Value, out: &mut Out, rev: u64) -> bool {
    if rel.starts_with("session/") {
        let Some(id) = v.get("id").and_then(Value::as_str) else {
            return true;
        };
        out.push(
            rel,
            rev,
            BatchItem {
                kind: ItemKind::Session,
                session: id.to_string(),
                data: json!({"cwd": v.get("directory"), "title": v.get("title"),
                             "version": v.get("version"),
                             "started": v.get("time").and_then(|t| t.get("created"))}),
            },
        );
        return true;
    }
    if !rel.starts_with("message/") {
        return true;
    }
    let sid = v
        .get("sessionID")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| rel.split('/').nth(1).map(str::to_string))
        .unwrap_or_default();
    let role = v.get("role").and_then(Value::as_str).unwrap_or("?");
    let time = v.get("time").cloned().unwrap_or(Value::Null);
    let model = v
        .get("modelID")
        .cloned()
        .or_else(|| v.get("model").and_then(|m| m.get("modelID")).cloned());
    if role == "assistant" {
        let Some(done) = time.get("completed").filter(|c| !c.is_null()) else {
            return false; // still streaming: look again when the file changes
        };
        out.push(
            rel,
            rev,
            BatchItem {
                kind: ItemKind::Step,
                session: sid.clone(),
                data: json!({"role": "assistant", "ts": done, "model": model}),
            },
        );
        if let Some(t) = v.get("tokens") {
            let cache = t.get("cache").cloned().unwrap_or(Value::Null);
            out.push(
                rel,
                rev,
                BatchItem {
                    kind: ItemKind::Spend,
                    session: sid,
                    data: json!({"model": model, "ts": done,
                                 "input_tokens": n(t, "input"),
                                 "output_tokens": n(t, "output"),
                                 "reasoning_tokens": n(t, "reasoning"),
                                 "cache_read_tokens": n(&cache, "read"),
                                 "cache_write_tokens": n(&cache, "write"),
                                 "cost": v.get("cost")}),
                },
            );
        }
    } else {
        out.push(
            rel,
            rev,
            BatchItem {
                kind: ItemKind::Step,
                session: sid,
                data: json!({"role": role, "ts": time.get("created"), "model": model}),
            },
        );
    }
    true
}

/// Push an explicit diagnostic for `rel`, at most once per physical version (`key`).
fn diagnose(g: &mut Inner, rel: &str, key: String, message: &str, out: &mut Out) {
    diagnose_map(&mut g.diag, rel, key, message, out);
}

fn diagnose_map(
    diag: &mut BTreeMap<String, String>,
    rel: &str,
    key: String,
    message: &str,
    out: &mut Out,
) {
    if diag.get(rel) == Some(&key) {
        return;
    }
    diag.insert(rel.to_string(), key.clone());
    out.push_diag(
        rel,
        &key,
        BatchItem {
            kind: ItemKind::Error,
            session: rel.to_string(),
            data: json!({"file": rel, "error": message}),
        },
    );
}

fn phase_map(g: &Inner, phase: u8) -> &BTreeMap<String, JFile> {
    if phase == 0 {
        &g.sessions
    } else {
        &g.messages
    }
}

fn phase_map_mut(g: &mut Inner, phase: u8) -> &mut BTreeMap<String, JFile> {
    if phase == 0 {
        &mut g.sessions
    } else {
        &mut g.messages
    }
}

fn known_len(g: &Inner) -> usize {
    g.sessions.len() + g.messages.len()
}

/// First key of `phase` strictly after `cursor` (None = from the beginning).
fn next_after(g: &Inner, phase: u8, cursor: Option<&str>) -> Option<String> {
    let map = phase_map(g, phase);
    match cursor {
        None => map.keys().next().cloned(),
        Some(c) => map
            .range::<str, _>((Bound::Excluded(c), Bound::Unbounded))
            .next()
            .map(|(k, _)| k.clone()),
    }
}

/// Stop a sweep without removal evidence and schedule a retry: a failed or partial walk (or an
/// exhausted allowance) never proves any path absent.
fn sweep_incomplete(g: &mut Inner) {
    if g.sweep.ok {
        // Budget-exhausted continuation: keep the walks, keep the epoch, do not count an error.
        return;
    }
    g.sweep = Sweep::default();
    g.sweep_due = true;
    g.work.sweeps_errored += 1;
}

/// Start a new bounded sweep over the two supported subtrees. A subtree that is genuinely absent (including a
/// `NotFound` stat) simply holds no documents; a subtree we cannot *inspect* for any other reason may, so that
/// sweep can never certify absence.
fn sweep_start(g: &mut Inner, root: &Path, now: u64) {
    g.epoch_seq = g.epoch_seq.wrapping_add(1).max(1);
    g.last_sweep_start_ms = Some(now);
    g.sweep_starts += 1;
    let mut walks = Vec::new();
    let mut ok = true;
    for sub in ["session", "message"] {
        let d = root.join(sub);
        g.work.stats += 1;
        match std::fs::metadata(&d) {
            Ok(m) if m.is_dir() => walks.push(DirWalk::start(&d)),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // Unprovable subtree (permission, I/O, symlink loop): keep known state, remove nothing.
            Err(_) => ok = false,
        }
    }
    g.sweep = Sweep {
        active: true,
        epoch: g.epoch_seq,
        walks,
        next_walk: 0,
        ok,
        rec_phase: 0,
        rec_cursor: None,
        reconciling: false,
    };
    g.complete_this_poll = false;
}

/// Advance every open walk as far as this turn's allowance permits. Returns `true` when every walk
/// reached its end in this call.
fn sweep_walks(g: &mut Inner, root: &Path, al: &Allowance) -> bool {
    // Discovery gets at most half of one turn's entry/visit dimensions; the other half services
    // known files, so a large tree never makes a turn return an empty batch while content work is
    // pending and discovery still advances every turn.
    let entries_floor = al.remaining_entries();
    // Each discovered entry also costs one classification visit, so a quarter of the entry cap keeps
    // discovery within half a turn's visits and leaves the rest for known-file content work.
    let entries_cap = entries_floor.min(MAX_DISCOVERY_ENTRIES_PER_PASS as u64 / 4);
    while g.sweep.next_walk < g.sweep.walks.len() {
        if al.remaining_visits() == 0
            || entries_floor.saturating_sub(al.remaining_entries()) >= entries_cap
        {
            // Keep the sweep's place; known-file content work gets the rest of this turn.
            return false;
        }
        let idx = g.sweep.next_walk;
        let step = g.sweep.walks[idx].step(al, &mut g.work);
        match step {
            Step::File { path, .. } => {
                let rel = rel_of(root, &path);
                if !supported_rel(&rel)
                    || !path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(".json"))
                {
                    continue;
                }
                let epoch = g.sweep.epoch;
                // Adoption piggybacks on the classification visit `DirWalk::step` already charged for this entry;
                // charging a second visit here would double count one work unit.
                let mut st = match g.pending.remove(&rel) {
                    Some(restored) => restored,
                    None => {
                        let mut fresh = JFile::default();
                        // A path a completed sweep proved absent keeps its accepted-revision high-water, so a
                        // reappearance is a new observation instead of a recycled producer key.
                        if let Some(rev) = g.retired_rev.get(&rel).copied() {
                            fresh.revision = rev;
                        }
                        fresh
                    }
                };
                st.epoch = epoch;
                let phase = phase_of(&rel);
                match phase_map_mut(g, phase).get_mut(&rel) {
                    Some(existing) => existing.epoch = epoch,
                    None => {
                        phase_map_mut(g, phase).insert(rel, st);
                    }
                }
            }
            Step::Dir(_) => {}
            Step::MetaError(_) | Step::Unreadable(_) | Step::EntryError => {
                // Unproven path/directory: this sweep cannot certify absence.
                g.sweep.ok = false;
            }
            Step::Budget => return false,
            Step::End => g.sweep.next_walk += 1,
        }
    }
    true
}

/// Bounded, resumable epoch reconciliation: drop known/restored paths a completed error-free sweep
/// did not see. Visit-charged per candidate and resumable, so one turn never scans the whole set.
/// Returns `true` when reconciliation finished in this call.
fn sweep_reconcile(g: &mut Inner, al: &Allowance) -> bool {
    loop {
        match g.sweep.rec_phase {
            0 | 1 => {
                let phase = g.sweep.rec_phase;
                let cursor = g.sweep.rec_cursor.clone();
                let Some(rel) = next_after(g, phase, cursor.as_deref()) else {
                    g.sweep.rec_phase += 1;
                    g.sweep.rec_cursor = None;
                    continue;
                };
                if !al.visit() {
                    return false;
                }
                g.work.file_visits += 1;
                let epoch = g.sweep.epoch;
                let stale = phase_map(g, phase)
                    .get(&rel)
                    .is_some_and(|st| st.epoch != epoch);
                if stale {
                    let last = phase_map(g, phase)
                        .get(&rel)
                        .map(|st| st.revision)
                        .unwrap_or(0);
                    g.retired_rev.insert(rel.clone(), last);
                    phase_map_mut(g, phase).remove(&rel);
                    g.diag.remove(&rel);
                }
                g.sweep.rec_cursor = Some(rel);
            }
            2 => {
                let cursor = g.sweep.rec_cursor.clone();
                let next = match cursor {
                    None => g.pending.keys().next().cloned(),
                    Some(c) => g
                        .pending
                        .range::<str, _>((Bound::Excluded(c.as_str()), Bound::Unbounded))
                        .next()
                        .map(|(k, _)| k.clone()),
                };
                let Some(rel) = next else {
                    g.sweep.rec_phase += 1;
                    continue;
                };
                if !al.visit() {
                    return false;
                }
                g.work.file_visits += 1;
                // A restored path that a completed error-free sweep never saw is absent.
                let last = g.pending.get(&rel).map(|st| st.revision).unwrap_or(0);
                g.retired_rev.insert(rel.clone(), last);
                g.pending.remove(&rel);
                g.diag.remove(&rel);
                g.sweep.rec_cursor = Some(rel);
            }
            _ => return true,
        }
    }
}

/// One bounded verification step of a large document whose length, sample and mtime are unchanged.
enum Wit {
    Running,
    Match,
    /// The completed pass proves the document differs from the stored witness. The value is the fold chain of
    /// the version that was verified: a payload read must reproduce it exactly before anything is published.
    Changed(String),
    Deferred,
}

fn advance_witness(
    path: &Path,
    st: &mut JFile,
    len: u64,
    mtime_ms: u64,
    generation: u64,
    al: &Allowance,
    work: &mut WorkStats,
) -> std::io::Result<Wit> {
    // Start (or restart) the pass when there is no progress or the observed version moved.
    let restart = match &st.verify {
        None => true,
        Some(w) => w.size != len || w.mtime_ms != mtime_ms || w.generation != generation,
    };
    if restart {
        st.verify = Some(Witness {
            at: 0,
            chain: chain_init(),
            size: len,
            mtime_ms,
            generation,
        });
        work.verifications_started += 1;
    }
    // One visit advances up to this many aligned chunks (a finite derived limit, so a single
    // document visit cannot monopolise the turn) and stops early when the bytes run out.
    let mut steps = 0u32;
    let finished: Option<Witness> = loop {
        let Some(w) = st.verify.as_mut() else {
            return Ok(Wit::Running);
        };
        if w.at >= len {
            break st.verify.take();
        }
        let want = (len - w.at).min(VERIFY_CHUNK) as usize;
        // A chunk boundary must stay aligned so the fold digest is reproducible from any resumption
        // point; when this turn cannot afford the whole next chunk, keep the progress and retry later.
        if steps >= WITNESS_CHUNKS_PER_VISIT {
            // Per-visit bound reached: keep the persisted progress and let the round-robin move on so
            // one large document cannot starve every other known file.
            return Ok(Wit::Running);
        }
        if (al.remaining() as usize) < want {
            return Ok(Wit::Deferred);
        }
        let chunk = match read_bytes(path, w.at, want, al, work)? {
            ReadOutcome::NoBudget => return Ok(Wit::Deferred),
            ReadOutcome::Data(b) => b,
        };
        if chunk.len() != want {
            // Shrank while verifying: no coherent document, restart on a later turn.
            st.verify = None;
            return Ok(Wit::Deferred);
        }
        steps += 1;
        work.verify_bytes += chunk.len() as u64;
        let chain = chain_fold(&w.chain, &chunk);
        w.at += chunk.len() as u64;
        w.chain = chain;
    };
    // The chunks of this visit must all describe one physical version: if the file moved while they were read,
    // the pass is a mix of two versions and cannot be equality or difference evidence for either. Drop it and
    // start again from the observed version on a later turn.
    if steps > 0 {
        work.stats += 1;
        let stable = match std::fs::metadata(path) {
            Ok(m) => {
                m.len() == len
                    && millis(m.modified().ok()).unwrap_or(0) == mtime_ms
                    && (mtime_ms == 0 || file_generation(&m) == generation)
            }
            Err(_) => false,
        };
        if !stable {
            st.verify = None;
            return Ok(Wit::Deferred);
        }
    }
    let Some(w) = finished else {
        return Ok(Wit::Running);
    };
    let chain = w.chain;
    work.verifications_completed += 1;
    if st.witness_hash.is_empty() {
        // Unknown evidence is never equality: adopt the digest silently, do not replay.
        st.witness_hash = chain;
        return Ok(Wit::Match);
    }
    if st.witness_hash == chain {
        Ok(Wit::Match)
    } else {
        Ok(Wit::Changed(chain))
    }
}

/// Visit the next known file: `Ok(true)` when this file's work finished, `Ok(false)` when it must be
/// retried on a later turn (allowance spent), `Err(())` when the allowance is gone for the turn.
#[allow(clippy::too_many_arguments)]
fn visit_one(
    g: &mut Inner,
    rel: &str,
    root: &Path,
    al: &Allowance,
    out: &mut Out,
    cutoff: SystemTime,
) -> std::io::Result<bool> {
    let path = root.join(rel);
    // The metadata call is charged whether it succeeds or fails: a failing path cannot be retried for free.
    g.work.stats += 1;
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            let key = format!("stat:{}", e.kind() as i32);
            diagnose(g, rel, key, &e.to_string(), out);
            return Ok(true);
        }
    };
    let len = meta.len();
    let mtime = meta.modified().ok();
    let generation = file_generation(&meta);
    let mtime_ms = millis(mtime).unwrap_or(0);

    let Inner {
        sessions,
        messages,
        work,
        consumed,
        diag,
        ..
    } = g;
    let map = if phase_of(rel) == 0 {
        sessions
    } else {
        messages
    };
    let Some((sample, _)) = read_sample(&path, len, al, work)? else {
        return Ok(false);
    };
    let Some(st) = map.get_mut(rel) else {
        return Ok(true);
    };

    // History window: adopt old, unseen files at EOF without reading the document.
    if !st.done && st.size == 0 && mtime.is_some_and(|m| m < cutoff) {
        st.done = true;
        st.size = len;
        st.mtime = mtime;
        st.sample = sample;
        st.generation = generation;
        return Ok(true);
    }

    let gen_ok = st.generation == 0 || st.generation == generation;
    let sample_ok = st.sample.is_empty() || st.sample == sample;
    let mtime_ok = match (millis(st.mtime), Some(mtime_ms)) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    };
    let small = len <= SAMPLE_FULL_MAX;
    // Set when a completed witness pass described one exact version: the payload read below must reproduce it.
    let mut expected_chain: Option<String> = None;

    // A persisted candidate describes exactly one version. Any observed move (length, mtime, physical
    // generation or bounded content sample) invalidates it here, before it can be compared with a payload,
    // so a stale candidate can never publish, and the next visit verifies the current version from scratch.
    // A metadata-preserving change is not caught by this test; the payload digest below catches it.
    let candidate_stale = st.candidate.as_ref().is_some_and(|c| {
        !c.matches(len, mtime_ms, generation) || (!st.sample.is_empty() && st.sample != sample)
    });
    if candidate_stale {
        st.candidate = None;
        st.verify = None;
    }

    // Same length, same inode and same sample. For a small document the sample *is* the content, so
    // this is exact equality. For a larger document the bounded sample cannot prove equality: an
    // unchanged mtime therefore starts/continues a full-content witness pass instead of accepting it.
    if len == st.size && gen_ok && sample_ok && (small || mtime_ok) {
        if small {
            st.mtime = mtime;
            st.sample = sample;
            st.generation = generation;
            st.verify = None;
            return Ok(true);
        }
        if len > MAX_DOC_BYTES {
            // Already diagnosed for this physical version; verifying a document that can never be
            // published would only consume allowance. Silence here is not an acceptance claim.
            st.mtime = mtime;
            st.sample = sample;
            st.generation = generation;
            st.verify = None;
            return Ok(true);
        }
        // A completed witness for exactly this version survives the payload deferral: reuse it instead of
        // re-verifying the document. The payload read below validates the bytes against it before
        // publication, and the shared allowance test below keeps it when the turn cannot hold the payload.
        if let Some(cand) = st.candidate.clone() {
            expected_chain = Some(cand.chain);
        } else {
            match advance_witness(&path, st, len, mtime_ms, generation, al, work)? {
                Wit::Running => return Ok(true),
                Wit::Deferred => return Ok(false),
                Wit::Match => {
                    st.mtime = mtime;
                    st.sample = sample;
                    st.generation = generation;
                    // Proven unchanged against the stored witness: nothing is pending for this version.
                    st.candidate = None;
                    return Ok(true);
                }
                Wit::Changed(chain) => {
                    // The completed pass proved this version differs from the stored witness. Keep the chain
                    // it verified: only a payload that reproduces that chain exactly may be parsed and
                    // published. It is persisted (`checkpoint`), so a later turn — or a restart — reads the
                    // payload instead of discarding the completed pass and verifying again.
                    st.candidate = Some(Candidate {
                        chain: chain.clone(),
                        size: len,
                        mtime_ms,
                        generation,
                    });
                    expected_chain = Some(chain);
                }
            }
        }
    }

    // A document above the supported ceiling is diagnosed once per physical version instead of being
    // read; later valid documents are not starved by it.
    if len > MAX_DOC_BYTES {
        let key = format!("oversized:{}:{}", len, sample);
        diagnose_map(
            diag,
            rel,
            key,
            "document larger than the supported size",
            out,
        );
        st.done = false;
        st.size = len;
        st.mtime = mtime;
        st.sample = sample;
        st.generation = generation;
        st.verify = None;
        return Ok(true);
    }

    // The whole document must fit what is left of this turn's byte allowance; otherwise it is retried
    // on a later turn, whose fresh allowance can fit it. A completed candidate stays persisted across
    // this deferral, so the wait costs one turn instead of restarting the whole verification.
    if len > al.remaining() {
        return Ok(false);
    }
    let buf = match read_bytes(&path, 0, len as usize, al, work)? {
        ReadOutcome::NoBudget => return Ok(false),
        ReadOutcome::Data(b) => b,
    };
    if buf.len() as u64 != len {
        // Changed while read: publish nothing, leave the state stale so a later visit re-reads it.
        return Ok(true);
    }
    work.payload_bytes += buf.len() as u64;
    // Stability: the physical version must not have moved under the read.
    work.stats += 1;
    let stable = match std::fs::metadata(&path) {
        Ok(m) => {
            m.len() == len
                && millis(m.modified().ok()).unwrap_or(0) == mtime_ms
                && (mtime_ms == 0 || file_generation(&m) == generation)
        }
        Err(_) => false,
    };
    if !stable {
        return Ok(true);
    }

    let text = String::from_utf8_lossy(&buf).into_owned();
    let content_hash = if small {
        String::new()
    } else {
        let mut h = Sha256::new();
        h.update(&buf);
        hex(h.finalize().as_slice())
    };
    let witness = witness_digest(&buf);

    // Coherence: a completed witness pass described one exact version of this document. The payload just read
    // must reproduce that chain byte-for-byte; a mismatch means the file moved again during the read (or the
    // chunks mixed two versions), so nothing may be parsed or published. Drop the progress so the next visit
    // verifies the currently observed version from scratch.
    if let Some(expected) = &expected_chain {
        if &witness != expected {
            st.verify = None;
            st.candidate = None;
            return Ok(true);
        }
    }

    // Large document whose mtime moved but whose bounded sample is identical: compare the plain full
    // content hash before emitting anything. An identical hash means the document is unchanged
    // (metadata only) -> advance metadata, emit nothing. An unknown hash is never replay evidence
    // either, so a legacy row is adopted silently instead of replaying. A version a completed witness
    // proved different is never treated as unchanged.
    if !small
        && expected_chain.is_none()
        && st.size == len
        && (st.generation == 0 || st.generation == generation)
        && (st.sample.is_empty() || st.sample == sample)
        && (st.content_hash.is_empty() || st.content_hash == content_hash)
    {
        st.size = len;
        st.mtime = mtime;
        st.sample = sample;
        st.generation = generation;
        st.content_hash = content_hash;
        st.witness_hash = witness;
        st.verify = None;
        st.candidate = None;
        return Ok(true);
    }

    match serde_json::from_str::<Value>(&text) {
        Ok(v) => {
            if rel.starts_with("session/") {
                if let Some(id) = v.get("id").and_then(Value::as_str) {
                    st.session = Some(id.to_string());
                }
            } else if rel.starts_with("message/") {
                let sid = v
                    .get("sessionID")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| rel.split('/').nth(1).map(str::to_string));
                let model = v
                    .get("modelID")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        v.get("model")
                            .and_then(|m| m.get("modelID"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                if sid.is_some() {
                    st.session = sid;
                }
                if model.is_some() {
                    st.model = model;
                }
            }
            out.begin_doc();
            let rev = st.revision.saturating_add(1);
            let done = map_doc(rel, &v, out, rev);
            st.done = done;
            st.size = len;
            st.mtime = mtime;
            st.sample = sample;
            st.generation = generation;
            st.content_hash = content_hash;
            st.witness_hash = witness;
            st.verify = None;
            // The payload read is this version's acceptance: no candidate is pending any more.
            st.candidate = None;
            if done {
                st.revision = rev;
                *consumed = consumed.saturating_add(len);
            }
            diag.remove(rel);
        }
        Err(_) => {
            // Likely mid-write. Diagnose once per physical version, keep the state so an unchanged
            // retry is skipped, and look again when the document changes.
            let key = format!("invalid:{}:{}", len, sample);
            diagnose_map(
                diag,
                rel,
                key,
                "document is not valid JSON (left for the next write)",
                out,
            );
            st.done = false;
            st.size = len;
            st.mtime = mtime;
            st.sample = sample;
            st.generation = generation;
            st.content_hash = content_hash;
            st.verify = None;
            // An unparseable version cannot be accepted; do not keep re-reading its candidate every turn.
            st.candidate = None;
        }
    }
    Ok(true)
}

/// One bounded round-robin pass over known files, sessions before messages. Every visit is
/// visit-charged before the work; the cursor only advances past a file whose work finished, so an
/// allowance-exhausted visit is retried on the next turn instead of being skipped.
fn visit_pass(
    g: &mut Inner,
    root: &Path,
    al: &Allowance,
    out: &mut Out,
    cutoff: SystemTime,
    visits_floor: u64,
) -> bool {
    let mut visits = 0usize;
    let mut wraps = 0u8;
    loop {
        // Visits are their own dimension: a turn whose entry allowance went to discovery can still
        // visit already-known files with the bytes and visits it has left.
        if visits >= MAX_FILES_PER_PASS
            || al.bytes_exhausted()
            || al.remaining_visits() <= visits_floor
        {
            return false;
        }
        let phase = g.visit_phase;
        let cursor = g.visit_cursor.clone();
        let next = next_after(g, phase, cursor.as_deref());
        let Some(rel) = next else {
            // End of this subtree: wrap to the other one (sessions first, then messages).
            wraps += 1;
            g.visit_phase = 1 - phase;
            g.visit_cursor = None;
            if wraps > 2 || known_len(g) == 0 {
                return true;
            }
            continue;
        };
        if !al.visit() {
            return false;
        }
        visits += 1;
        g.work.file_visits += 1;
        match visit_one(g, &rel, root, al, out, cutoff) {
            Ok(true) => g.visit_cursor = Some(rel),
            Ok(false) => {
                // Allowance spent mid-file: keep the cursor on the previous path so this file is the
                // next visit instead of being silently skipped.
                return false;
            }
            Err(_) => {
                // An I/O error keeps its charge (the failed attempt was work) and the visit is kept.
                g.visit_cursor = Some(rel);
            }
        }
    }
}

/// Close a batch. A non-empty batch always carries a non-zero cursor: `Cursor(0)` means "reset and
/// replay", so a call that emitted only a diagnostic (no payload read) must still advance it.
fn finished_batch(items: Vec<BatchItem>, consumed: u64) -> Batch {
    let next = Cursor(if items.is_empty() {
        consumed
    } else {
        consumed.max(1)
    });
    Batch { items, next }
}

impl OpenCode {
    fn poll_sync(&self, since: Cursor) -> Batch {
        let root = self.spec.resolve(&self.home);
        let cutoff = SystemTime::now() - Duration::from_secs(self.history_days as u64 * 86400);
        let mut g = self.inner.lock().expect("opencode lock");
        g.root = Some(root.clone());
        g.complete_this_poll = false;
        g.identities.clear();
        if since.0 == 0 {
            if g.restored {
                g.restored = false;
            } else {
                let r = g.root.clone();
                let budget = g.budget.clone();
                let work = g.work;
                let epoch_seq = g.epoch_seq;
                // Process-level state (clock, cadence counters, retired revision high-water) survives a replay
                // reset: only parser/content state is discarded.
                let clock = g.clock.clone();
                let sweep_starts = g.sweep_starts;
                let sweeps_done = g.sweeps_done;
                let last_sweep_start_ms = g.last_sweep_start_ms;
                let retired_rev = std::mem::take(&mut g.retired_rev);
                *g = Inner {
                    root: r,
                    budget,
                    work,
                    epoch_seq,
                    sweep_due: true,
                    clock,
                    sweep_starts,
                    sweeps_done,
                    last_sweep_start_ms,
                    retired_rev,
                    ..Inner::default()
                };
            }
        }
        let al = Self::allowance(&g);
        let standalone = g.budget.is_none();

        let mut out = Out::default();
        let entries_before = g.work.entries;
        let visits_before = g.work.file_visits;
        // Known-file content work runs before discovery so a large tree cannot spend a whole turn on
        // enumeration and return an empty batch while an accepted revision is still pending. A source
        // with no known files yet (first call, or an explicit replay from cursor 0, where a source
        // without content restarts anyway) discovers first so its first batch is not empty.
        let content_first = known_len(&g) > 0 && since.0 != 0;
        if content_first {
            visit_pass(
                &mut g,
                &root,
                &al,
                &mut out,
                cutoff,
                DISCOVERY_VISIT_RESERVE,
            );
        }

        // Discovery cadence: a sweep starts when the discovery tick marked it due (or for a never-swept
        // source / a standalone call), but a *scheduled* turn may not start a fresh one more often than
        // `SWEEP_INTERVAL_MS`. A shorter configured discovery tick therefore cannot multiply sweeps, and a
        // long pause cannot produce a catch-up storm: the floor is measured against the last sweep start.
        // Between sweeps the open sweep and known-file verification keep progressing every turn.
        let now = Self::now(&g);
        let cadence_ready = match g.last_sweep_start_ms {
            None => true,
            Some(t) => now >= t.saturating_add(SWEEP_INTERVAL_MS),
        };
        let want_sweep = !g.sweep.active && (g.sweep_due || standalone);
        g.work.stats += 1;
        match std::fs::metadata(&root) {
            Ok(m) if m.is_dir() => {
                if want_sweep && (standalone || cadence_ready) {
                    sweep_start(&mut g, &root, now);
                }
                if g.sweep.active {
                    if !g.sweep.reconciling {
                        let walks_done = sweep_walks(&mut g, &root, &al);
                        if walks_done {
                            if g.sweep.ok {
                                g.sweep.reconciling = true;
                                g.sweep.rec_phase = 0;
                                g.sweep.rec_cursor = None;
                            } else {
                                // Incomplete/error sweep: never remove anything; retry later.
                                sweep_incomplete(&mut g);
                            }
                        }
                    }
                    if g.sweep.active && g.sweep.reconciling && sweep_reconcile(&mut g, &al) {
                        g.sweep = Sweep::default();
                        g.sweep_due = false;
                        g.complete_this_poll = true;
                        g.work.sweeps += 1;
                        g.sweeps_done += 1;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The root is gone: nothing can be proven absent, so keep all known state.
                g.sweep = Sweep::default();
                g.sweep_due = true;
            }
            _ => {
                // The root exists but cannot be inspected (permission, I/O, not a directory): this turn has no
                // absence evidence, the open sweep is dropped without removing anything and retried later.
                if g.sweep.active {
                    g.sweep.ok = false;
                    sweep_incomplete(&mut g);
                }
                g.sweep_due = true;
            }
        }

        // A second, bounded content pass spends whatever visits discovery left over, so files a
        // sweep discovered in this turn are serviced in this turn instead of idling behind the cursor.
        visit_pass(&mut g, &root, &al, &mut out, cutoff, 0);
        g.work.last_pass_entries = g.work.entries.saturating_sub(entries_before);
        g.work.last_pass_file_visits = g.work.file_visits.saturating_sub(visits_before);
        // The producer identities of exactly these items, captured for `Source::identities()`.
        g.identities = std::mem::take(&mut out.keys);
        let consumed = g.consumed;
        finished_batch(out.items, consumed)
    }
}

impl Source for OpenCode {
    fn id(&self) -> &'static str {
        ID
    }
    fn kind(&self) -> SourceKind {
        SourceKind::CodingAgent
    }

    /// One allowance for the whole turn (`detect` + `poll`): the adapter never creates a second one.
    fn begin_turn(&self, allowance: Arc<TurnBudget>) {
        let mut g = self.inner.lock().expect("opencode lock");
        g.budget = Some(allowance);
        g.work = WorkStats::default();
    }

    fn end_turn(&self) {
        let mut g = self.inner.lock().expect("opencode lock");
        g.budget = None;
    }

    fn detect(&self, env: &Env) -> Detection {
        let root = self.spec.resolve(&env.home);
        let mut g = self.inner.lock().expect("opencode lock");
        g.root = Some(root.clone());
        // Detection never claims absence: a subtree it cannot inspect may hold documents, so it reports an
        // honest not-detected reason instead of "empty layout".
        g.work.stats += 1;
        match std::fs::metadata(&root) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => {
                g.probe = None;
                return unupported_or_missing(&root);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                g.probe = None;
                return unupported_or_missing(&root);
            }
            Err(_) => {
                g.probe = None;
                return Detection::NotDetected {
                    reason: "opencode storage root cannot be inspected".into(),
                };
            }
        }
        let mut unproven = false;
        let mut dirs: Vec<PathBuf> = Vec::new();
        for sub in ["session", "message"] {
            let d = root.join(sub);
            g.work.stats += 1;
            match std::fs::metadata(&d) {
                Ok(m) if m.is_dir() => dirs.push(d),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => unproven = true,
            }
        }
        if dirs.is_empty() {
            g.probe = None;
            if unproven {
                return Detection::NotDetected {
                    reason: "opencode storage subtree cannot be inspected".into(),
                };
            }
            return unupported_or_missing(&root);
        }
        let al = Self::allowance(&g);
        if g.probe.is_none() {
            g.probe = Some(Probe {
                walks: dirs.iter().map(|d| DirWalk::start(d)).collect(),
                next_walk: 0,
            });
        }
        let mut found = false;
        let mut incomplete = false;
        {
            let Some(mut probe) = g.probe.take() else {
                return Detection::NotDetected {
                    reason: "opencode storage layout not found or empty".into(),
                };
            };
            let mut keep = true;
            while probe.next_walk < probe.walks.len() {
                match probe.walks[probe.next_walk].step(&al, &mut g.work) {
                    Step::File { path, meta } => {
                        if meta.is_file()
                            && path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|n| n.ends_with(".json"))
                        {
                            found = true;
                            break;
                        }
                    }
                    Step::Dir(_) => {}
                    Step::MetaError(_) | Step::Unreadable(_) | Step::EntryError => {
                        incomplete = true
                    }
                    Step::Budget => {
                        incomplete = true;
                        break;
                    }
                    Step::End => probe.next_walk += 1,
                }
            }
            if found || incomplete {
                // Keep the resumable probe (or drop it when a document was found).
                g.probe = if found { None } else { Some(probe) };
                keep = false;
            }
            if keep {
                g.probe = None;
            }
        }
        if found {
            // A discovery tick: the next poll of this turn starts a fresh bounded sweep.
            g.sweep_due = true;
            return Detection::Detected { paths: vec![root] };
        }
        if incomplete {
            return Detection::NotDetected {
                reason:
                    "opencode layout probe reached its entry/visit limit without a JSON document"
                        .into(),
            };
        }
        g.probe = None;
        if root
            .parent()
            .map(|p| p.join("opencode.db"))
            .unwrap_or_else(|| PathBuf::from("opencode.db"))
            .exists()
        {
            return Detection::NotDetected {
                reason: "opencode SQLite store not supported in this build".into(),
            };
        }
        Detection::NotDetected {
            reason: "opencode storage layout not found or empty".into(),
        }
    }

    fn capabilities(&self) -> Caps {
        Caps::WATCH
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        Box::pin(async move { Ok(self.poll_sync(since)) })
    }

    /// Only a completed, error-free sweep that also finished reconciling removals may prove absence.
    fn discovery_complete(&self) -> bool {
        self.inner.lock().expect("opencode lock").complete_this_poll
    }

    /// Monotonic count of completed, error-free sweeps: a checkpoint can only drop a path after one, so core
    /// needs no per-commit checkpoint diff for this source.
    fn discovery_epoch(&self) -> Option<u64> {
        Some(self.inner.lock().expect("opencode lock").sweeps_done)
    }

    /// Known paths are only dropped by a completed, error-free sweep plus its bounded reconciliation, so core
    /// never has to merge unseen paths back into an incomplete checkpoint.
    fn retains_unseen_paths(&self) -> bool {
        true
    }

    /// Producer identities of the most recent poll, aligned 1:1 with its items.
    fn identities(&self) -> Vec<RecordKey> {
        self.inner.lock().expect("opencode lock").identities.clone()
    }

    fn offsets(&self) -> Vec<FileOffset> {
        let g = self.inner.lock().expect("opencode lock");
        let mut out: Vec<FileOffset> = Vec::new();
        for st in g.sessions.values().filter(|s| s.done) {
            out.push(FileOffset {
                path: String::new(),
                offset: st.size,
                size: st.size,
            });
        }
        // Rebuild with paths (kept separate so the borrow above stays simple).
        out.clear();
        for (rel, st) in &g.sessions {
            if st.done {
                out.push(FileOffset {
                    path: rel.clone(),
                    offset: st.size,
                    size: st.size,
                });
            }
        }
        for (rel, st) in &g.messages {
            if st.done {
                out.push(FileOffset {
                    path: rel.clone(),
                    offset: st.size,
                    size: st.size,
                });
            }
        }
        for (rel, st) in &g.pending {
            if st.done {
                out.push(FileOffset {
                    path: rel.clone(),
                    offset: st.size,
                    size: st.size,
                });
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out.dedup_by(|a, b| a.path == b.path);
        out
    }

    fn restore_offsets(&self, offsets: Vec<FileOffset>) {
        let mut g = self.inner.lock().expect("opencode lock");
        g.sessions.clear();
        g.messages.clear();
        g.pending.clear();
        g.consumed = offsets.iter().map(|o| o.offset).sum();
        g.diag.clear();
        g.pending = offsets
            .into_iter()
            .filter(|o| o.offset >= o.size)
            .map(|o| {
                let session = if supported_rel(&o.path) {
                    o.path.split('/').nth(1).map(str::to_string)
                } else {
                    None
                };
                (
                    o.path.clone(),
                    JFile {
                        size: o.size,
                        done: true,
                        session,
                        ..JFile::default()
                    },
                )
            })
            .collect();
        g.sweep = Sweep::default();
        g.sweep_due = true;
        g.probe = None;
        g.restored = true;
        g.visit_phase = 0;
        g.visit_cursor = None;
    }

    fn checkpoint(&self) -> SourceCheckpoint {
        let g = self.inner.lock().expect("opencode lock");
        let mut merged: BTreeMap<String, &JFile> = BTreeMap::new();
        for (rel, st) in &g.sessions {
            merged.insert(rel.clone(), st);
        }
        for (rel, st) in &g.messages {
            merged.insert(rel.clone(), st);
        }
        for (rel, st) in &g.pending {
            merged.entry(rel.clone()).or_insert(st);
        }
        let mut files = Vec::with_capacity(merged.len());
        let mut revisions = BTreeMap::new();
        for (path, st) in merged {
            let session = st.session.clone().or_else(|| {
                if supported_rel(&path) {
                    path.split('/').nth(1).map(str::to_string)
                } else {
                    None
                }
            });
            if st.done {
                revisions.insert(path.clone(), st.revision.to_string());
            }
            // `sample` (never contains `|`) | plain content hash | versioned witness state.
            let mut fingerprint = if st.content_hash.is_empty() {
                st.sample.clone()
            } else {
                format!("{}|{}", st.sample, st.content_hash)
            };
            let mut extra = serde_json::Map::new();
            if !st.witness_hash.is_empty() {
                extra.insert("w".into(), Value::String(st.witness_hash.clone()));
            }
            if let Some(w) = &st.verify {
                extra.insert(
                    "v".into(),
                    json!({"at": w.at, "ch": w.chain, "sz": w.size, "mm": w.mtime_ms, "g": w.generation}),
                );
            }
            // A completed witness whose payload read is deferred is persisted with the version evidence it
            // proves, so the work of verifying a near-ceiling document survives a turn *and* a restart.
            if let Some(c) = &st.candidate {
                extra.insert(
                    "c".into(),
                    json!({"ch": c.chain, "sz": c.size, "mm": c.mtime_ms, "g": c.generation}),
                );
            }
            if !extra.is_empty() {
                fingerprint.push('|');
                fingerprint.push_str(&Value::Object(extra).to_string());
            }
            // A plain integer stays the legacy revision format; witness progress is versioned JSON.
            let revision = match &st.verify {
                None => Some(st.revision.to_string()),
                Some(w) => Some(
                    json!({"n": st.revision, "v": {"at": w.at, "ch": w.chain, "sz": w.size,
                                                  "mm": w.mtime_ms, "g": w.generation}})
                    .to_string(),
                ),
            };
            files.push(FileCheckpoint {
                path,
                generation: st.generation,
                offset: st.size,
                size: st.size,
                mtime_ms: millis(st.mtime).unwrap_or(0),
                fingerprint,
                session,
                model: st.model.clone(),
                announced: st.done,
                discarded_bytes: 0,
                incomplete: !st.done,
                revision,
            });
        }
        // A path a completed sweep proved absent keeps its accepted-revision high-water here (never as a file
        // row, so it stays absent from `paths()`), so a reappearance is a new observation instead of a recycled
        // producer key.
        for (rel, rev) in &g.retired_rev {
            revisions
                .entry(rel.clone())
                .or_insert_with(|| rev.to_string());
        }
        SourceCheckpoint { files, revisions }
    }

    fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
        let mut g = self.inner.lock().expect("opencode lock");
        g.sessions.clear();
        g.messages.clear();
        g.pending.clear();
        g.diag.clear();
        g.retired_rev.clear();
        g.identities.clear();
        g.consumed = checkpoint.files.iter().map(|f| f.offset).sum();
        for f in checkpoint.files {
            let mtime = if f.mtime_ms == 0 {
                None
            } else {
                std::time::SystemTime::UNIX_EPOCH
                    .checked_add(std::time::Duration::from_millis(f.mtime_ms))
            };
            // `sample` | plain hash | versioned witness JSON | legacy `sample|hash`.
            let mut parts = f.fingerprint.splitn(3, '|');
            let sample = parts.next().unwrap_or_default().to_string();
            let second = parts.next();
            let third = parts.next();
            let (content_hash, extra) = match (second, third) {
                (Some(sec), Some(third))
                    if sec.len() == 64 && sec.chars().all(|c| c.is_ascii_hexdigit()) =>
                {
                    (sec.to_string(), Some(third))
                }
                (Some(sec), Some(third)) => (sec.to_string(), Some(third)),
                (Some(sec), None) => (sec.to_string(), None),
                (None, _) => (String::new(), None),
            };
            let mut witness_hash = String::new();
            let mut verify = None;
            let mut candidate = None;
            if let Some(extra) = extra {
                if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(extra) {
                    if let Some(w) = m.get("w").and_then(Value::as_str) {
                        witness_hash = w.to_string();
                    }
                    if let Some(v) = m.get("v") {
                        verify = Some(Witness {
                            at: v.get("at").and_then(Value::as_u64).unwrap_or(0),
                            chain: v
                                .get("ch")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            size: v.get("sz").and_then(Value::as_u64).unwrap_or(0),
                            mtime_ms: v.get("mm").and_then(Value::as_u64).unwrap_or(0),
                            generation: v.get("g").and_then(Value::as_u64).unwrap_or(0),
                        });
                    }
                    // A malformed/truncated candidate is ignored (verified again) instead of trusted.
                    if let Some(c) = m.get("c") {
                        let chain = c
                            .get("ch")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let size = c.get("sz").and_then(Value::as_u64).unwrap_or(0);
                        if !chain.is_empty() && size > 0 {
                            candidate = Some(Candidate {
                                chain,
                                size,
                                mtime_ms: c.get("mm").and_then(Value::as_u64).unwrap_or(0),
                                generation: c.get("g").and_then(Value::as_u64).unwrap_or(0),
                            });
                        }
                    }
                }
            }
            // Legacy plain-integer revision, or versioned `{"n":..,"v":..}` witness progress.
            let mut revision = 0u64;
            if let Some(rev) = &f.revision {
                if let Ok(n) = rev.parse::<u64>() {
                    revision = n;
                } else if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(rev) {
                    revision = m.get("n").and_then(Value::as_u64).unwrap_or(0);
                    if verify.is_none() {
                        if let Some(v) = m.get("v") {
                            verify = Some(Witness {
                                at: v.get("at").and_then(Value::as_u64).unwrap_or(0),
                                chain: v
                                    .get("ch")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                size: v.get("sz").and_then(Value::as_u64).unwrap_or(0),
                                mtime_ms: v.get("mm").and_then(Value::as_u64).unwrap_or(0),
                                generation: v.get("g").and_then(Value::as_u64).unwrap_or(0),
                            });
                        }
                    }
                }
            }
            let st = JFile {
                size: f.size,
                mtime,
                sample,
                content_hash,
                witness_hash,
                generation: f.generation,
                revision,
                done: f.announced,
                session: f.session.clone(),
                model: f.model.clone(),
                epoch: 0,
                verify,
                candidate,
            };
            g.pending.insert(f.path, st);
        }
        for (path, rev) in checkpoint.revisions {
            if let Some(st) = g.pending.get_mut(&path) {
                if let Ok(n) = rev.parse::<u64>() {
                    st.revision = n;
                }
                continue;
            }
            // A revision entry with no file row belongs to a path the last completed sweep proved absent.
            if let Ok(n) = rev.parse::<u64>() {
                g.retired_rev.insert(path, n);
            }
        }
        g.sweep = Sweep::default();
        g.sweep_due = true;
        g.probe = None;
        g.restored = true;
        g.visit_phase = 0;
        g.visit_cursor = None;
    }
}

/// Reasons for "not detected" when the JSON layout is absent; SQLite is explicitly unsupported.
fn unupported_or_missing(root: &Path) -> Detection {
    if root
        .parent()
        .map(|p| p.join("opencode.db"))
        .unwrap_or_else(|| PathBuf::from("opencode.db"))
        .exists()
    {
        return Detection::NotDetected {
            reason: "opencode SQLite store not supported in this build".into(),
        };
    }
    if !root.exists() {
        return Detection::NotDetected {
            reason: "~/.local/share/opencode/storage not found".into(),
        };
    }
    Detection::NotDetected {
        reason: "opencode storage layout not found or empty".into(),
    }
}

/// Wall-clock capture used by the poller diagnostics of one turn (kept for API parity).
pub fn now() -> u64 {
    now_ms()
}

#[allow(dead_code)]
const _UNUSED_DISCOVERY_BOUND: usize = MAX_DISCOVERY_ENTRIES_PER_PASS;

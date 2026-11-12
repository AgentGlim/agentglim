//! Shared types and the adapter traits (PLAN section 5.1). Only the core worker edits this file.

pub mod bus;
pub mod lock;
pub mod poller;
pub mod tasks;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::ops::BitOr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Boxed, sendable future used by the object-safe async trait methods.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Size of one scheduled source-service turn's work allowance, in source-content bytes.
///
/// A turn is `detect` **and** `poll` for one source: both draw from the same [`TurnBudget`], so detection plus
/// polling of one turn are jointly bounded by this value (never two independent 4 MiB counters in one turn).
/// A standalone `detect` or a direct `poll` call is itself capped at this same value.
pub const TURN_ALLOWANCE_BYTES: u64 = 4 * 1024 * 1024;

/// Directory entries one scheduled source turn may return, across every enumerator it uses (detect **and**
/// poll): matching and non-matching names, files, directories and iterator errors all count one entry.
pub const TURN_ALLOWANCE_ENTRIES: u64 = 200;

/// Per-item work visits one scheduled source turn may perform (detect **and** poll): opening a directory,
/// visiting a known file, adopting a discovered file, reconciling one absent candidate, adopting one restored
/// checkpoint entry, or comparing one saved path in core's checkpoint diff.
pub const TURN_ALLOWANCE_VISITS: u64 = 200;

/// One dimension of a turn's allowance: what was spent and what was available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnDimension {
    pub used: u64,
    pub limit: u64,
}

impl TurnDimension {
    pub fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.used)
    }
    pub fn exhausted(&self) -> bool {
        self.remaining() == 0
    }
}

/// Cumulative usage of one turn's allowance, across every phase (detect and poll) of that turn.
///
/// This is the reportable per-turn accounting: it is monotone while the turn is open and is never reset on a
/// phase transition, because one [`TurnBudget`] instance belongs to one turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnUsage {
    pub bytes: TurnDimension,
    pub entries: TurnDimension,
    pub visits: TurnDimension,
}

/// One scheduled source turn's shared work allowance (detect + poll together).
///
/// Core creates one of these per source per turn and hands it to [`Source::begin_turn`]; the adapter charges
/// every source-content byte it reads (and any other accounted work) against it. [`TurnBudget::charge`] clamps
/// the request to what is left **before** the read executes and returns the grant, so a reader must not exceed
/// it. [`TurnBudget::release`] gives back charged bytes that were not actually read (short read/EOF).
///
/// Entries ([`TurnBudget::charge_entries`]) and work visits ([`TurnBudget::charge_visits`]) are the other two
/// dimensions: they are charged *before* the operation too, so a failed enumeration/stat/open/read attempt
/// consumes its allowance instead of creating an unbounded retry loop inside one turn.
#[derive(Debug)]
pub struct TurnBudget {
    limit: u64,
    used: AtomicU64,
    entry_limit: u64,
    entries: AtomicU64,
    visit_limit: u64,
    visits: AtomicU64,
    read_calls: AtomicU64,
    returned: AtomicU64,
}

/// Charge up to `want` of one dimension, clamped to what is left, before the operation happens.
fn take(counter: &AtomicU64, limit: u64, want: u64) -> u64 {
    let mut used = counter.load(Ordering::Acquire);
    loop {
        let grant = want.min(limit.saturating_sub(used));
        if grant == 0 {
            return 0;
        }
        match counter.compare_exchange_weak(used, used + grant, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => return grant,
            Err(now) => used = now,
        }
    }
}

fn give_back(counter: &AtomicU64, want: u64) {
    let mut used = counter.load(Ordering::Acquire);
    loop {
        let next = used.saturating_sub(want);
        match counter.compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return,
            Err(now) => used = now,
        }
    }
}

impl TurnBudget {
    /// A fresh allowance of `limit` bytes, shared between the detection and the polling of one turn.
    /// The entry and visit dimensions default to [`TURN_ALLOWANCE_ENTRIES`] / [`TURN_ALLOWANCE_VISITS`].
    pub fn new(limit: u64) -> Arc<Self> {
        Self::bounded(limit, TURN_ALLOWANCE_ENTRIES, TURN_ALLOWANCE_VISITS)
    }

    /// A fresh allowance with an explicit budget in every dimension (tests, calibration, non-default callers).
    pub fn bounded(limit: u64, entries: u64, visits: u64) -> Arc<Self> {
        Arc::new(Self {
            limit,
            used: AtomicU64::new(0),
            entry_limit: entries,
            entries: AtomicU64::new(0),
            visit_limit: visits,
            visits: AtomicU64::new(0),
            read_calls: AtomicU64::new(0),
            returned: AtomicU64::new(0),
        })
    }

    /// A fresh allowance of [`TURN_ALLOWANCE_BYTES`], the default for one scheduled source turn.
    pub fn default_allowance() -> Arc<Self> {
        Self::new(TURN_ALLOWANCE_BYTES)
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    pub fn used(&self) -> u64 {
        self.used.load(Ordering::Acquire)
    }

    pub fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.used())
    }

    /// The byte dimension is spent (the historical meaning of `exhausted`, kept for existing callers).
    pub fn exhausted(&self) -> bool {
        self.remaining() == 0
    }

    /// Charges up to `want` bytes and returns how many were granted (`0` once the allowance is spent).
    /// The caller must clamp the byte count it actually requests/reads to the grant.
    pub fn charge(&self, want: u64) -> u64 {
        take(&self.used, self.limit, want)
    }

    /// Returns charged bytes that were not read after all (short read at EOF), so accounting stays honest.
    pub fn release(&self, bytes: u64) {
        give_back(&self.used, bytes);
    }

    pub fn entry_limit(&self) -> u64 {
        self.entry_limit
    }

    pub fn visit_limit(&self) -> u64 {
        self.visit_limit
    }

    pub fn entries_used(&self) -> u64 {
        self.entries.load(Ordering::Acquire)
    }

    pub fn visits_used(&self) -> u64 {
        self.visits.load(Ordering::Acquire)
    }

    pub fn remaining_entries(&self) -> u64 {
        self.entry_limit.saturating_sub(self.entries_used())
    }

    pub fn remaining_visits(&self) -> u64 {
        self.visit_limit.saturating_sub(self.visits_used())
    }

    /// Charges up to `want` returned directory entries (before the enumerator advances) and returns the grant.
    pub fn charge_entries(&self, want: u64) -> u64 {
        take(&self.entries, self.entry_limit, want)
    }

    /// Charges up to `want` work visits (before the work happens) and returns the grant.
    pub fn charge_visits(&self, want: u64) -> u64 {
        take(&self.visits, self.visit_limit, want)
    }

    /// One returned entry, charged before the enumerator advances again.
    pub fn try_entry(&self) -> bool {
        self.charge_entries(1) == 1
    }

    /// One work visit, charged before the work happens.
    pub fn try_visit(&self) -> bool {
        self.charge_visits(1) == 1
    }

    /// The entry or visit dimension is spent (traversal must stop before advancing again).
    pub fn work_exhausted(&self) -> bool {
        self.remaining_entries() == 0 || self.remaining_visits() == 0
    }

    /// Records one successful I/O-boundary read and the bytes it actually returned.
    ///
    /// The shared `adapters::io` boundary calls this for every read it performs, so a turn can be reported as
    /// `charged = used()`, `returned = returned_bytes()`, `released = charged - returned`. Application
    /// accounting only: this is not kernel evidence.
    pub fn note_read(&self, returned_bytes: u64) {
        self.read_calls.fetch_add(1, Ordering::AcqRel);
        self.returned.fetch_add(returned_bytes, Ordering::AcqRel);
    }

    /// Successful reads performed through the shared I/O boundary in this turn.
    pub fn read_calls(&self) -> u64 {
        self.read_calls.load(Ordering::Acquire)
    }

    /// Bytes those reads actually returned this turn (short reads excluded, failed reads contribute nothing).
    pub fn returned_bytes(&self) -> u64 {
        self.returned.load(Ordering::Acquire)
    }

    /// Cumulative usage of this turn, across every phase it has run. Never resets mid-turn.
    pub fn usage(&self) -> TurnUsage {
        TurnUsage {
            bytes: TurnDimension {
                used: self.used(),
                limit: self.limit,
            },
            entries: TurnDimension {
                used: self.entries_used(),
                limit: self.entry_limit,
            },
            visits: TurnDimension {
                used: self.visits_used(),
                limit: self.visit_limit,
            },
        }
    }
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One event on the bus; `seq` is global and monotonic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub seq: u64,
    pub kind: String,
    pub source: String,
    pub ts: u64,
    pub data: serde_json::Value,
}

/// Adapter capabilities (bit flags).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Caps(pub u32);

impl Caps {
    pub const NONE: Caps = Caps(0);
    pub const WATCH: Caps = Caps(1);
    pub const SEND: Caps = Caps(1 << 1);
    pub const ANSWER: Caps = Caps(1 << 2);
    pub const PAUSE: Caps = Caps(1 << 3);
    pub const KILL: Caps = Caps(1 << 4);
    pub const RESUME: Caps = Caps(1 << 5);

    pub fn contains(self, other: Caps) -> bool {
        self.0 & other.0 == other.0
    }

    /// Names of the set flags, for JSON output.
    pub fn names(self) -> Vec<&'static str> {
        [
            (Caps::WATCH, "watch"),
            (Caps::SEND, "send"),
            (Caps::ANSWER, "answer"),
            (Caps::PAUSE, "pause"),
            (Caps::KILL, "kill"),
            (Caps::RESUME, "resume"),
        ]
        .iter()
        .filter(|(c, _)| self.contains(*c))
        .map(|(_, n)| *n)
        .collect()
    }
}

impl BitOr for Caps {
    type Output = Caps;
    fn bitor(self, rhs: Caps) -> Caps {
        Caps(self.0 | rhs.0)
    }
}

/// A control verb sent to an adapter session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "verb", content = "text")]
pub enum Verb {
    Send(String),
    Answer(String),
    Pause,
    Resume,
    Kill,
}

impl Verb {
    /// Capability an adapter must declare for this verb.
    pub fn required_cap(&self) -> Caps {
        match self {
            Verb::Send(_) => Caps::SEND,
            Verb::Answer(_) => Caps::ANSWER,
            Verb::Pause => Caps::PAUSE,
            Verb::Resume => Caps::RESUME,
            Verb::Kill => Caps::KILL,
        }
    }
}

/// Token scopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Read,
    Control,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    CodingAgent,
    ChatBot,
    Harness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum Detection {
    Detected { paths: Vec<PathBuf> },
    NotDetected { reason: String },
}

/// What adapters may look at when detecting: home dir and selected env vars (never the whole env).
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: PathBuf,
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Cursor(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Run,
    Child,
    Step,
    Spend,
    Error,
    Heartbeat,
    Session,
    Prompt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BatchItem {
    pub kind: ItemKind,
    pub session: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Batch {
    pub items: Vec<BatchItem>,
    pub next: Cursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum RuntimeState {
    Up {
        models: Vec<String>,
        vram_bytes: u64,
        ram_bytes: u64,
        slots: u32,
        ctx: u32,
        tps: f32,
    },
    Down,
    OwnerOff,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CoreError {
    #[error("verb not supported by this adapter")]
    Unsupported,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("io: {0}")]
    Io(String),
    /// A checkpoint delta larger than the per-commit row ceiling: refused before any work is done.
    #[error("checkpoint delta too large: {0} rows exceeds {MAX_CHECKPOINT_DELTA_ROWS}")]
    CheckpointDeltaTooLarge(usize),
}

/// Per-commit ceiling on checkpoint-delta rows (changed file states + changed revisions + removal
/// candidates). One turn can visit at most [`TURN_ALLOWANCE_VISITS`] files and one revision key per
/// changed file, so 256 (one changed file plus one 200-entry turn allowance of continuation work,
/// as stated in `tests/v6_recovery.rs`) bounds every legitimate delta while refusing a whole-
/// population delta before any allocation/commit work happens.
pub const MAX_CHECKPOINT_DELTA_ROWS: usize = 256;

/// A bounded, resumable checkpoint delta: only what changed since the last delta was taken.
///
/// * `upserts` — changed or newly discovered file parser states, ordered by `path`;
/// * `revisions` — changed source-level revision keys;
/// * `removed` — removal candidates proved absent by a *complete* discovery sweep (a path whose
///   absence is unproven is never in this list).
///
/// A delta is applied by [`crate::store::Store::commit_delta`] in one transaction together with its
/// batch's events and tombstones: upserted rows are written, removed paths lose their file-state rows
/// and gain their tombstone atomically, and nothing else is touched. Unchanged resident files are
/// never copied, compared or rewritten.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CheckpointDelta {
    pub upserts: Vec<FileCheckpoint>,
    pub revisions: std::collections::BTreeMap<String, String>,
    pub removed: Vec<RemovedPath>,
}

impl CheckpointDelta {
    /// Total rows this delta would write (file states + revisions + removals).
    pub fn row_count(&self) -> usize {
        self.upserts.len() + self.revisions.len() + self.removed.len()
    }
    pub fn is_empty(&self) -> bool {
        self.row_count() == 0
    }
    /// Validates the row ceiling **before** any commit work: a delta over the ceiling is refused
    /// wholesale, never partially applied.
    pub fn check_bounds(&self) -> Result<(), CoreError> {
        let n = self.row_count();
        if n > MAX_CHECKPOINT_DELTA_ROWS {
            Err(CoreError::CheckpointDeltaTooLarge(n))
        } else {
            Ok(())
        }
    }
}

/// Read position of one source file, relative to the adapter root (forward slashes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileOffset {
    pub path: String,
    pub offset: u64,
    pub size: u64,
}

/// Durable per-file parser/tail state for one watched file. This is the checkpoint contract used by the
/// poller and by adapters; adapters may extend it by overriding `Source::checkpoint`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct FileCheckpoint {
    pub path: String,
    pub generation: u64,
    pub offset: u64,
    pub size: u64,
    pub mtime_ms: u64,
    pub fingerprint: String,
    pub session: Option<String>,
    pub model: Option<String>,
    pub announced: bool,
    pub discarded_bytes: u64,
    pub incomplete: bool,
    pub revision: Option<String>,
}

/// Durable checkpoint for one source: its files plus any source-level revisions (e.g. snapshot rounds).
///
/// `files` must be **ordered by `path`** (strictly increasing, no duplicates): core reconciles removals and
/// reappearances with an ordered, charged, resumable merge walk against it, never with a full path index. Core
/// verifies the order as it walks; a list that violates it aborts the round without certifying any absence
/// (no tombstone, no dropped parser state), so an adapter bug cannot silently delete paths.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SourceCheckpoint {
    pub files: Vec<FileCheckpoint>,
    pub revisions: std::collections::BTreeMap<String, String>,
}

impl SourceCheckpoint {
    /// Paths this checkpoint still reports (relative, forward slashes). Test/read helper only: core no longer
    /// calls it, because building the whole set is exactly the pre-cap materialization the bounded
    /// reconciliation replaced.
    pub fn paths(&self) -> std::collections::BTreeSet<String> {
        self.files.iter().map(|f| f.path.clone()).collect()
    }
}

/// A path the source used to report and no longer does: persisted when a completed discovery sweep proved it
/// absent, cleared when the path reappears.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemovedPath {
    pub path: String,
    pub generation: u64,
    pub removed_ms: u64,
}

/// Side-effect-free candidate for the next logical generation of one `(source, path)`.
///
/// Reading a candidate persists nothing: the durable compare-and-advance happens only inside the batch
/// transaction that commits it (see [`GenerationClaim`]). `observed` is the high-water the candidate was
/// derived from; `generation == observed + 1` (minimum 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationCandidate {
    pub path: String,
    pub observed: u64,
    pub generation: u64,
}

impl GenerationCandidate {
    /// The claim to commit together with the batch that uses this generation.
    pub fn claim(&self) -> GenerationClaim {
        GenerationClaim {
            path: self.path.clone(),
            base: self.observed,
            generation: self.generation,
        }
    }
}

/// A claim on the next logical generation of one `(source, path)`, committed atomically with its batch.
///
/// The claim succeeds only if the durable high-water still equals `base` at commit time, and it advances the
/// high-water to `generation` in the same SQLite transaction as the events, checkpoint, revisions and
/// tombstones. Two candidates derived from the same observation can therefore never both commit: the loser
/// gets `StoreError::GenerationConflict`, writes nothing and publishes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationClaim {
    pub path: String,
    pub base: u64,
    pub generation: u64,
}

/// Stable identity of ONE emitted observation, supplied by the producer (adapter).
///
/// Offset-based producers identify a record by `(path, logical generation, record position, emitted-item index)`;
/// snapshot producers by `(namespace, durable semantic revision, emitted-item index)`. Neither is a content hash
/// nor a per-batch index, so the identity survives bounded batching, repartitioning and a restart, while a
/// genuine A -> B -> A sequence keeps three distinct identities.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RecordKey {
    Offset {
        path: String,
        generation: u64,
        position: u64,
        item: u32,
    },
    Revision {
        namespace: String,
        revision: String,
        item: u32,
    },
}

impl RecordKey {
    pub fn offset(path: impl Into<String>, generation: u64, position: u64, item: u32) -> Self {
        RecordKey::Offset {
            path: path.into(),
            generation,
            position,
            item,
        }
    }

    pub fn revision(namespace: impl Into<String>, revision: impl Into<String>, item: u32) -> Self {
        RecordKey::Revision {
            namespace: namespace.into(),
            revision: revision.into(),
            item,
        }
    }

    /// Opaque, stable, storable form (persisted in `events.producer`). Field separator 0x1f cannot appear in a
    /// relative path on any supported OS and is never produced by an adapter revision token.
    pub fn key(&self) -> String {
        match self {
            RecordKey::Offset {
                path,
                generation,
                position,
                item,
            } => format!("off\u{1f}{path}\u{1f}{generation}\u{1f}{position}\u{1f}{item}"),
            RecordKey::Revision {
                namespace,
                revision,
                item,
            } => format!("rev\u{1f}{namespace}\u{1f}{revision}\u{1f}{item}"),
        }
    }
}

/// An agent or harness that the daemon watches (and maybe controls).
pub trait Source: Send + Sync {
    fn id(&self) -> &'static str;
    fn kind(&self) -> SourceKind;
    fn detect(&self, env: &Env) -> Detection;
    fn capabilities(&self) -> Caps;
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>>;
    /// Current consumed offsets per file (empty for sources without file offsets).
    fn offsets(&self) -> Vec<FileOffset> {
        Vec::new()
    }
    /// Restores offsets saved earlier: "already consumed up to here".
    fn restore_offsets(&self, _offsets: Vec<FileOffset>) {}

    /// Whether this adapter produces bounded [`CheckpointDelta`]s via [`Source::checkpoint_delta`]
    /// (changed entries since the last delta was taken) instead of a whole checkpoint. When `true`,
    /// core commits only the delta (incremental upserts + transactional removals); when `false`, core
    /// keeps the legacy whole-checkpoint path (ordered merge walk + whole replacement). Adapters flip
    /// this only together with a real delta implementation — never as a label over a full copy.
    fn supports_checkpoint_delta(&self) -> bool {
        false
    }

    /// Bounded delta of the checkpoint since the last delta was taken: changed file states, changed
    /// revisions and removal candidates proved by a complete sweep. Taking a delta drains the
    /// adapter's pending changes; a failed commit keeps the delta in the poller's pending batch for
    /// exact retry, so draining here is safe. Default: the whole [`Source::checkpoint`] as upserts
    /// (legacy adapters, whose core path is the whole-checkpoint one).
    fn checkpoint_delta(&self) -> CheckpointDelta {
        let cp = self.checkpoint();
        CheckpointDelta {
            upserts: cp.files,
            revisions: cp.revisions,
            removed: Vec::new(),
        }
    }

    /// The adapter's complete checkpoint (all known files + revisions), for restore/serialization
    /// callers that need the full state. Default: [`Source::checkpoint`] (legacy full adapters).
    /// Delta-capable adapters override this with their full iteration; their `checkpoint()` returns
    /// the delta instead.
    fn full_checkpoint(&self) -> SourceCheckpoint {
        self.checkpoint()
    }

    /// Durable checkpoint for this source (defaults to the offset list).
    ///
    /// For legacy adapters this is the whole checkpoint; for delta-capable adapters
    /// (`supports_checkpoint_delta() == true`) it is the pending delta as a `SourceCheckpoint`
    /// (changed files + changed revisions, ordered by `path`), and [`Source::full_checkpoint`] is
    /// the whole state. `files` must be ordered by `path` (strictly increasing): core's
    /// removal/reappearance reconciliation is an ordered merge walk, not a path index. The default
    /// implementation sorts, so an adapter that overrides this must keep (or restore) that order.
    fn checkpoint(&self) -> SourceCheckpoint {
        let mut files: Vec<FileCheckpoint> = self
            .offsets()
            .into_iter()
            .map(|o| FileCheckpoint {
                path: o.path,
                offset: o.offset,
                size: o.size,
                ..Default::default()
            })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        SourceCheckpoint {
            files,
            revisions: std::collections::BTreeMap::new(),
        }
    }

    /// Stable identities of the items returned by the most recent [`Source::poll`], aligned 1:1 with
    /// `Batch::items`. Empty (the default) means this adapter does not supply producer identity yet, and the
    /// poller keeps the legacy identity policy. See `_build/v2-r3/NOTES.md` for the producer rules.
    fn identities(&self) -> Vec<RecordKey> {
        Vec::new()
    }

    /// Called once after [`Source::restore_checkpoint`], before the first poll, with the tombstones core
    /// persisted for paths this adapter stopped reporting. Lets an adapter keep a removed path's generation
    /// distinct when it reappears.
    fn restore_removed(&self, _removed: &[RemovedPath]) {}

    /// Starts one scheduled source turn: the allowance is shared by the `detect` and the `poll` that follow.
    /// Core creates exactly one allowance per source per turn; the adapter must charge every source-content
    /// read to it (and clamp each read to the granted bytes) instead of starting its own counter. A standalone
    /// `detect`/`poll` (no `begin_turn`) keeps the adapter's own ≤[`TURN_ALLOWANCE_BYTES`] cap.
    fn begin_turn(&self, _allowance: Arc<TurnBudget>) {}

    /// Ends the turn; core calls this even when the poll was cancelled or failed. Do not advance discovery
    /// completion or drop partial progress here: durable progress belongs in the checkpoint.
    fn end_turn(&self) {}

    /// Whether this adapter's checkpoint keeps every path it has not yet proven absent, so core does not have to
    /// merge the previous checkpoint's unseen paths back into an incomplete sweep's checkpoint. `false` (the
    /// default) keeps the defensive merge, now bounded and charged, for adapters that cannot promise it.
    fn retains_unseen_paths(&self) -> bool {
        false
    }

    /// Monotonic count of *completed, error-free* discovery sweeps this source has finished.
    ///
    /// Core uses it to decide whether a checkpoint diff (removal/reappearance reconciliation) can possibly
    /// differ from the previous one: only a completed sweep may drop a path. `None` (the default) means the
    /// adapter does not report epochs, so core diffs on every committed checkpoint exactly as before.
    fn discovery_epoch(&self) -> Option<u64> {
        None
    }

    /// Whether the checkpoint returned by the most recent [`Source::poll`] came from a *complete* successful
    /// discovery sweep. Only then may core tombstone paths that disappeared from the checkpoint; an incomplete,
    /// failed, still-running or cancelled sweep must leave prior tombstones and parser state untouched and
    /// return `false` here. Never treat "I saw nothing" as absence proof. Defaults to `true` so legacy adapters
    /// and restored checkpoints keep their existing complete-sweep behaviour.
    fn discovery_complete(&self) -> bool {
        true
    }

    /// Restores a durable checkpoint (defaults to restoring its offsets).
    fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
        self.restore_offsets(
            checkpoint
                .files
                .into_iter()
                .map(|f| FileOffset {
                    path: f.path,
                    offset: f.offset,
                    size: f.size,
                })
                .collect(),
        );
    }
    fn control<'a>(
        &'a self,
        _sid: &'a SessionId,
        _verb: Verb,
    ) -> BoxFut<'a, Result<Ack, CoreError>> {
        Box::pin(async { Err(CoreError::Unsupported) })
    }
}

/// A local model server (read-only: never starts, stops or loads models).
pub trait Runtime: Send + Sync {
    fn id(&self) -> &'static str;
    fn probe(&self) -> BoxFut<'_, RuntimeState>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_flags() {
        let c = Caps::WATCH | Caps::KILL;
        assert!(c.contains(Caps::WATCH));
        assert!(!c.contains(Caps::SEND));
        assert_eq!(c.names(), vec!["watch", "kill"]);
        assert_eq!(Verb::Kill.required_cap(), Caps::KILL);
        assert!(Scope::Admin > Scope::Read);
    }

    #[test]
    fn turn_budget_clamps_and_never_overspends() {
        let b = TurnBudget::new(10);
        assert_eq!(b.limit(), 10);
        assert_eq!(b.charge(4), 4, "granted in full while it fits");
        assert_eq!(b.used(), 4);
        assert_eq!(b.remaining(), 6);
        assert_eq!(b.charge(100), 6, "clamped to the remaining allowance");
        assert!(b.exhausted());
        assert_eq!(b.charge(1), 0, "nothing left to grant");
        b.release(3);
        assert_eq!(b.remaining(), 3, "unread bytes are returned");
        assert_eq!(b.charge(1), 1);
        assert_eq!(b.used(), 8);
    }

    #[test]
    fn default_turn_allowance_is_one_4_mib_budget() {
        assert_eq!(TURN_ALLOWANCE_BYTES, 4_194_304);
        let b = TurnBudget::default_allowance();
        assert_eq!(b.limit(), TURN_ALLOWANCE_BYTES);
        // One shared counter: detection and polling draw from the same object.
        assert_eq!(b.charge(TURN_ALLOWANCE_BYTES / 2), 2_097_152);
        assert_eq!(b.charge(TURN_ALLOWANCE_BYTES), 2_097_152);
        assert_eq!((b.used(), b.remaining()), (TURN_ALLOWANCE_BYTES, 0));
    }

    #[test]
    fn candidate_claims_the_next_generation_only() {
        let c = GenerationCandidate {
            path: "a.jsonl".into(),
            observed: 4,
            generation: 5,
        };
        let claim = c.claim();
        assert_eq!(claim.path, "a.jsonl");
        assert_eq!(claim.base, 4, "claim is based on the observed high-water");
        assert_eq!(claim.generation, 5);
    }
}

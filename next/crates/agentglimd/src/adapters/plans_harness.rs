//! Plans harness adapter: scans `projects/dev/plans/<plan>/_build/<round>/` (read-only).
//! A round is a `Run`; each `workers/<name>/` is a `Child` (done = DONE file exists).
//!
//! Observation is bounded, charged and resumable. One scheduled turn draws from the one shared
//! `Allowance` core creates (`detect` + `poll` together): directory entries, per-item visits and
//! source-content bytes. No directory is materialised or sorted, no level restarts finished work and
//! no whole known set is copied or re-scanned per capped turn:
//!
//! * the plan/round traversal is a bounded depth-limited walk (plans root -> `<plan>/_build` ->
//!   round dirs). Its open iterators are in-process state; a restart rewalks from the root in
//!   bounded turns rather than pretending an OS iterator is durable;
//! * each round keeps a durable *sweep* (window counter, incremental ordered candidate queue, durable
//!   continuation cursor, observed/done counters) plus a durable BUILD-LOG offset/line count. A sweep a
//!   page could not finish continues on the next page; a sweep interrupted by a restart rewalks from the
//!   root in bounded turns and re-observes the whole population (so a change made below the previous
//!   cursor while the process was down is still observed);
//! * removals are reconciled only after a complete, error-free enumeration, in a bounded ordered-range
//!   pass that charges one visit per candidate and resumes across pages. Nothing is copied out of a map
//!   to build a candidate list, and a full `retain`/`gone` vector never happens;
//! * the BUILD-LOG is witnessed by its **whole content**, not a prefix: a pass hashes `[0, size)` of one
//!   snapshot (SHA-256) and counts its lines with the `tail` rule, every byte charged to the turn's
//!   allowance and resumable across pages. Only a completed pass publishes its digest, line count and
//!   identity, so a same-size edit anywhere is seen and a partial pass is never visible;
//! * discovery is paced: a new plan/round walk and a new census window of a round may start only once
//!   [`CENSUS_FLOOR`] of wall clock has passed since the previous start of that scope. Work already in
//!   progress and BUILD-LOG witnesses continue on every turn;
//! * the adapter is delta-capable: `checkpoint_delta()` drains at most `MAX_CHECKPOINT_DELTA_ROWS` changed
//!   rows, revision keys and proven removal candidates per take (the rest carries to the next take), and
//!   `full_checkpoint()` is the whole state. A removal candidate comes only from a complete sweep or walk,
//!   or from a stat that reported the one path missing.
//!
//! Truthfulness: any `read_dir`/entry/stat failure on a plan, on a `_build` directory or on a worker
//! (`DONE`/`REPORT.md` included) marks the current discovery **unproven**. An unproven sweep reconciles
//! nothing, keeps every known round/worker and the committed flags, and retries from the root later, so
//! state is discoverable again once the error clears. `Source::discovery_complete()` reports `true` only
//! after a complete, error-free traversal in this process whose every round also finished a complete,
//! error-free census. An incomplete census is emitted as `"partial": true` with an explicit `coverage`
//! object (observed window, durable known totals, total-known flag, error/stale evidence); a total
//! population is never claimed before a completed sweep has actually observed it.
//!
//! Ordering and identity: within one batch the changed `Child` observations come **before** the `Run`
//! aggregate that counts them, so an event-order consumer never sees a population claim ahead of its
//! evidence (a completion-only aggregate with no changed child is still valid). Every emitted item gets
//! one `RecordKey::revision` identity, aligned 1:1 with `Batch::items`, from a persisted monotone counter
//! per `Run`/`Child` namespace of the round, so A->B->A keeps three distinct identities, the store can
//! deduplicate exactly, and an unchanged poll or restart emits nothing at all.
//!
//! Items are emitted when a round or a worker is new or changed since the last committed revision.
//! An unchanged restart stays silent at any revision, a genuine change after a restore is reported
//! exactly once, and DONE/report are independent presence flags (an empty DONE is meaningful).

use super::io::{self, Allowance, ReadOutcome};
use super::tail;
use super::RootSpec;
use super::{WorkStats, MAX_FILES_PER_PASS};
use crate::core::{
    now_ms, Batch, BatchItem, BoxFut, Caps, CheckpointDelta, CoreError, Cursor, Detection, Env,
    FileCheckpoint, FileOffset, ItemKind, RecordKey, RemovedPath, Source, SourceCheckpoint,
    SourceKind, TurnBudget, MAX_CHECKPOINT_DELTA_ROWS,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::ReadDir;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub const ID: &str = "plans-harness";

const HISTORY_DEFAULT: u32 = 30;
/// Wall-clock floor between two census starts of the same round, and between two plan/round walks. Discovery
/// (directory enumeration, new plans/rounds/workers) cannot run again before this much time has passed; work that
/// is already in progress continues on later turns, and BUILD-LOG witnesses are not gated by it.
pub const CENSUS_FLOOR: Duration = Duration::from_secs(15);
/// Version tag of the adapter-private round token carried in an existing `FileCheckpoint`.
/// v2 tokens (and older bare numbers) decode with zeroed counters, so a v1..v2 checkpoint still
/// restores and every revision identity from here on is newer than anything it already committed.
const ROUND_TOKEN_VERSION: u64 = 3;
/// Entries one page may spend discovering plans and rounds (the rest is left to round censuses).
const WALK_ENTRIES_PER_PAGE: u64 = 96;
/// Round-removal candidates one page may reconcile (they are charged as visits, not entries).
const WALK_RECONCILE_VISITS_PER_PAGE: u64 = 32;
/// A finished round waits for the source to reach a quiescent census before re-sweeping, so a census can
/// actually *finish* for the whole tree (a per-page restart race would never let every round be complete at
/// the same moment). This bound keeps one busy or erroring round from starving the others.
const SWEEP_RESTART_IDLE_PAGES: u64 = 16;
/// Entries one round may enumerate in its `workers/` directory per page.
const ROUND_ENTRIES_PER_PAGE: u64 = 96;
/// Worker observations one round may make per page.
const ROUND_VISITS_PER_PAGE: u64 = 64;
/// BUILD-LOG bytes one round may read per page.
const ROUND_LOG_BYTES_PER_PAGE: u64 = 512 * 1024;
/// Namespace prefix of a *retired* round's durable high-water entry in `SourceCheckpoint::revisions`.
/// A retired entry is not a path and not a round: it carries only the Run/Child revision counters of a
/// round that is gone, so a reappearing round can never reuse a producer key the store already
/// deduplicated. Plan/round names never contain `@` in this harness, and a live round token is keyed by
/// the bare `<plan>/<round>` session, so the two namespaces cannot collide.
const RETIRED_REVISION_PREFIX: &str = "retired@";

/// Published witness of a round's `BUILD-LOG.md`: the last *completed* full-content pass.
///
/// `offset == size` once a witness is published; `lines` and `fingerprint` describe exactly those bytes.
/// `fingerprint` is the lowercase hex SHA-256 of the whole content (empty = log absent). `pass` is the one
/// in-progress pass; it lives in memory only, so a restart begins a new pass from byte 0.
#[derive(Clone, Default)]
struct LogProgress {
    offset: u64,
    size: u64,
    lines: usize,
    mtime: Option<SystemTime>,
    generation: u64,
    fingerprint: String,
    pass: Option<LogPass>,
}

/// One full-content witness pass: hashes `[0, size)` of the snapshot it started with.
#[derive(Clone)]
struct LogPass {
    size: u64,
    generation: u64,
    mtime: Option<SystemTime>,
    pos: u64,
    scan: LineScan,
    hasher: Sha256,
}

impl LogPass {
    fn begin(size: u64, generation: u64, mtime: Option<SystemTime>) -> Self {
        LogPass {
            size,
            generation,
            mtime,
            pos: 0,
            scan: LineScan::default(),
            hasher: Sha256::new(),
        }
    }
}

/// Streaming line count with the same rule as `tail::read_new_lines`: a `\n`-terminated line counts when it
/// is shorter than `MAX_PARTIAL_LINE_BYTES` and has content after `\r`/ASCII-blank trimming. The count is
/// carried across chunk boundaries, so a pass split over pages counts exactly what one read would.
/// Known residual: a line made only of non-ASCII Unicode whitespace is counted here but not by `tail`.
#[derive(Clone, Default)]
struct LineScan {
    len: u64,
    content: bool,
    lines: usize,
}

impl LineScan {
    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if b == b'\n' {
                if self.content && self.len < tail::MAX_PARTIAL_LINE_BYTES as u64 {
                    self.lines += 1;
                }
                self.len = 0;
                self.content = false;
            } else {
                self.len += 1;
                if !matches!(b, b' ' | b'\t' | b'\r' | 0x0b | 0x0c) {
                    self.content = true;
                }
            }
        }
    }
}

enum PassStep {
    Pending,
    Complete,
    Restart,
    Unproven,
}

/// Hashes the next bounded slice of a pass. Every byte is charged to the shared allowance before it is read,
/// and a page never reads more than [`ROUND_LOG_BYTES_PER_PAGE`].
fn advance_log_pass(
    pass: &mut LogPass,
    path: &Path,
    al: &Allowance,
    work: &mut WorkStats,
) -> PassStep {
    let mut read_now = 0u64;
    while pass.pos < pass.size {
        if read_now >= ROUND_LOG_BYTES_PER_PAGE || al.bytes_exhausted() {
            return PassStep::Pending;
        }
        let want = (ROUND_LOG_BYTES_PER_PAGE - read_now).min(pass.size - pass.pos) as usize;
        match io::read_bytes(path, pass.pos, want, al, work) {
            Ok(ReadOutcome::Data(bytes)) => {
                // Zero bytes at a position below the snapshot size: the file was truncated under the pass.
                if bytes.is_empty() {
                    return PassStep::Restart;
                }
                // `io::read_bytes` leaves payload accounting to the caller.
                work.payload_bytes += bytes.len() as u64;
                read_now += bytes.len() as u64;
                pass.pos += bytes.len() as u64;
                pass.hasher.update(&bytes);
                pass.scan.feed(&bytes);
            }
            Ok(ReadOutcome::NoBudget) => return PassStep::Pending,
            Err(_) => return PassStep::Unproven,
        }
    }
    PassStep::Complete
}

/// Whether a completed witness differs from the published one. A checkpoint written before the full-content
/// witness stores a 256-byte prefix (hex, longer than a digest): it is compared by size and line count once,
/// and the first completed witness then replaces it with a digest.
fn log_witness_changed(prior: &LogProgress, digest: &str, lines: usize, size: u64) -> bool {
    if prior.fingerprint.is_empty() {
        return true;
    }
    if prior.fingerprint.len() != 64 {
        return prior.size != size || prior.lines != lines;
    }
    prior.fingerprint != digest
}

/// Durable observation of one `workers/<name>/` directory.
///
/// `done` and `report` are independent presence flags (an empty `DONE` is meaningful and is never
/// inferred from a byte size). `announced` records whether this exact observation has been
/// delivered; a change that could not be emitted this pass stays pending. `seen_sweep` is the
/// in-process stamp of the sweep that last enumerated this worker (never persisted: a restart
/// re-enumerates everything, which is what proves the population again).
#[derive(Clone, Default)]
struct WorkerState {
    done: bool,
    report: bool,
    mtime: Option<SystemTime>,
    size: u64,
    generation: u64,
    announced: bool,
    seen_sweep: u64,
}

/// One bounded census of a round's `workers/` directory.
///
/// Completion and coverage belong to one stated sweep window (`id`). The candidate queue is filled
/// incrementally by the enumeration (`unvisited`), so a sweep never copies the whole known map, and
/// removals are decided by an ordered-range pass (`reconcile` cursor) that only runs after a complete,
/// error-free enumeration.
#[derive(Clone, Default)]
struct Sweep {
    /// Monotone counter: completion and coverage belong to one stated sweep window.
    id: u64,
    /// The enumeration pass of this sweep still has entries to return.
    active: bool,
    /// The enumeration pass reached the end of `workers/` without an error.
    enum_done: bool,
    /// Enumeration/stat/marker failure: absence is unproven for this sweep.
    error: bool,
    /// Known names this sweep must still observe, filled by the enumeration in sorted order.
    unvisited: BTreeSet<String>,
    /// Last worker name observed in this sweep.
    cursor: Option<String>,
    /// Ordered-range continuation of the removal pass (`None` = pass not started / finished).
    reconcile: Option<String>,
    /// The removal pass is in progress.
    reconciling: bool,
    /// Worker observations charged to this sweep.
    observed: u64,
    /// How many of those observations had a DONE file.
    done_observed: u64,
    /// The last emitted aggregate for this round was partial, so completion is still owed.
    emitted_partial: bool,
    /// This sweep's completion was already counted into the durable epoch.
    counted: bool,
    /// Pages this sweep stayed idle without restarting (bounded wait for a quiescent census).
    idle_pages: u64,
    /// Names the enumeration returned that were already known.
    enumerated_known: u64,
    /// Names the enumeration returned that were new.
    new_found: u64,
}

#[derive(Default)]
struct RoundState {
    log: LogProgress,
    workers: BTreeMap<String, WorkerState>,
    /// Durable count of known workers with a DONE marker (`workers` scan-free aggregate count).
    done_known: u64,
    /// Round accepted-revision counter (monotone, durable in the round token).
    generation: u64,
    /// Persisted monotone semantic counters: one namespace for this round's Run aggregates and one
    /// for its Child observations. Every emitted item consumes the next value of its namespace.
    run_rev: u64,
    child_rev: u64,
    /// Completed, error-free sweeps of this round (durable coverage epoch component).
    sweeps_done: u64,
    /// The round was observed by at least one poll (never suppress a reported round).
    seen: bool,
    /// In-process stamp of the walk that last enumerated this round.
    seen_walk: u64,
    sweep: Sweep,
    /// Counted in `Inner.live_sweeps` (a sweep that is running, queued or reconciling).
    sweep_live: bool,
    /// Earliest instant this round may start its next census window (in-process, never persisted).
    census_next_at: Option<Instant>,
    /// In-process `workers/` directory iterator (never persisted: a restart rewalks).
    enum_dir: Option<ReadDir>,
    /// Page sequence that last serviced this round (one bounded slice per round per page).
    last_page: u64,
}

impl Clone for RoundState {
    /// Durable snapshot only: in-process iterators and page bookkeeping are never cloned.
    fn clone(&self) -> Self {
        Self {
            log: self.log.clone(),
            workers: self.workers.clone(),
            done_known: self.done_known,
            generation: self.generation,
            run_rev: self.run_rev,
            child_rev: self.child_rev,
            sweeps_done: self.sweeps_done,
            seen: self.seen,
            seen_walk: self.seen_walk,
            sweep: self.sweep.clone(),
            sweep_live: self.sweep_live,
            census_next_at: self.census_next_at,
            enum_dir: None,
            last_page: 0,
        }
    }
}

/// Bounded depth-limited traversal of `<root>/<plan>/_build/<round>/`.
#[derive(Default)]
struct Walk {
    /// In-process id of this traversal: rounds stamped with a different id were not seen by it.
    id: u64,
    /// The traversal still has plan/`_build` entries to return.
    active: bool,
    /// The traversal reached the end of the plans root (and its builds).
    enum_done: bool,
    /// Enumeration plus the bounded round-removal pass finished without an error.
    complete: bool,
    /// A read-dir/entry/stat error: absence is unproven for this traversal.
    error: bool,
    plans: Option<ReadDir>,
    plan: Option<String>,
    build: Option<ReadDir>,
    /// Ordered-range continuation of the round-removal pass.
    reconcile: Option<String>,
    reconciling: bool,
    /// Rounds the enumeration returned that were already known / that were new.
    enumerated_known: u64,
    new_found: u64,
}

impl Walk {
    fn start(id: u64) -> Self {
        Walk {
            id,
            active: true,
            ..Walk::default()
        }
    }

    /// A traversal that never started (or was reset after completing/failing).
    fn idle(&self) -> bool {
        !self.active
            && !self.enum_done
            && !self.complete
            && !self.error
            && !self.reconciling
            && self.reconcile.is_none()
            && self.plans.is_none()
            && self.build.is_none()
    }

    fn fail(&mut self) {
        self.active = false;
        self.enum_done = false;
        self.complete = false;
        self.error = true;
        self.plans = None;
        self.build = None;
        self.plan = None;
        self.reconciling = false;
        self.reconcile = None;
    }
}

/// Bounded, resumable layout detection (runs at most once per detection tick).
#[derive(Default)]
struct DetectWalk {
    active: bool,
    found: bool,
    plans: Option<ReadDir>,
    plan: Option<String>,
    build: Option<ReadDir>,
}

/// Durable high-water of a round that is no longer present.
///
/// Deliberately separate from [`RoundState`]: a retired round keeps **no** path, worker, log or sweep
/// state, so an absent round is never resurrected as active state just to remember its counters. The
/// values only ever rise, and a reappearing round starts above them (fresh, monotonically increasing
/// producer identities).
#[derive(Clone, Copy, Default)]
struct RetiredRound {
    /// Accepted-revision counter (never reused, so a reappearance is never mistaken for a restored
    /// unchanged baseline).
    generation: u64,
    /// Highest Run aggregate revision emitted for that round namespace.
    run_rev: u64,
    /// Highest Child revision emitted for that round namespace.
    child_rev: u64,
}

impl RetiredRound {
    /// Raises the high-water from a live round's counters (never lowers it).
    fn absorb(&mut self, state: &RoundState) {
        self.generation = self.generation.max(state.generation);
        self.run_rev = self.run_rev.max(state.run_rev);
        self.child_rev = self.child_rev.max(state.child_rev);
    }
}

#[derive(Default)]
struct Inner {
    rounds: BTreeMap<String, RoundState>,
    /// Durable Run/Child revision high-water of rounds that are no longer present (keyed by session).
    retired: BTreeMap<String, RetiredRound>,
    /// Rounds this process discovered but has not served yet: the priority selection is this queue, so
    /// it never scans the known population (the §2.3 uncharged all-round scan).
    fresh: VecDeque<String>,
    /// Known rounds whose most recent census ended in an error (`traversal_certifies` reads this
    /// counter instead of scanning every round on every poll).
    error_rounds: u64,
    walk: Walk,
    /// Traversal id source (monotone for this process).
    walk_seq: u64,
    /// Completed, error-free round sweeps in this process: core's discovery epoch.
    epoch: u64,
    /// Round sweeps that are running, queued or reconciling right now (`0` = quiescent census).
    live_sweeps: u64,
    /// Pages a completed traversal has been held while some round is still mid-sweep (stall guard).
    walk_hold: u64,
    /// Earliest instant the next plan/round walk may start (in-process).
    walk_next_at: Option<Instant>,
    /// Pending checkpoint-delta marks and removal candidates (drained by `checkpoint_delta`).
    delta: DeltaQueue,
    /// Last taken row per path and last taken revision per key: a take emits only real changes.
    acked_files: BTreeMap<String, FileCheckpoint>,
    acked_revs: BTreeMap<String, String>,
    detect: DetectWalk,
    /// A supported round has been found by detection at least once in this process.
    detect_found: bool,
    gen: u64,
    committed_rounds: BTreeMap<String, RoundState>,
    committed_gen: u64,
    restored: bool,
    baseline: bool,
    /// Producer identities emitted during the most recent poll, aligned 1:1 with `Batch::items`.
    identities: Vec<RecordKey>,
    /// Fair continuation across rounds: the last round serviced.
    next_session: Option<String>,
    page_seq: u64,
}

/// One page's worth of emitted items and their producer identities (both bounded by
/// [`MAX_FILES_PER_PASS`]).
#[derive(Default)]
struct Page {
    items: Vec<BatchItem>,
    ids: Vec<RecordKey>,
}

impl Page {
    fn full(&self) -> bool {
        self.items.len() >= MAX_FILES_PER_PASS
    }

    /// Pushes one item together with its producer identity (always the same call, so the two vectors
    /// can never drift apart).
    fn push(&mut self, item: BatchItem, id: RecordKey) {
        self.items.push(item);
        self.ids.push(id);
    }
}

/// What one directory entry turned out to be.
enum EntryKind {
    Dir(String),
    Other,
    /// `file_type`/metadata failed: the entry proves nothing either way.
    Unproven,
    /// No entry allowance left: the iterator was not advanced.
    Budget,
    End,
    ReadError,
}

/// Charges one entry before advancing a directory iterator, then classifies what it returned.
///
/// A metadata call made to classify an entry is counted in `WorkStats.stats` (honest, not folded
/// into the entry charge).
fn next_entry(rd: &mut ReadDir, al: &Allowance, work: &mut WorkStats) -> EntryKind {
    if !al.entry() {
        return EntryKind::Budget;
    }
    work.entries += 1;
    match rd.next() {
        None => EntryKind::End,
        Some(Err(_)) => EntryKind::ReadError,
        Some(Ok(entry)) => {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                return EntryKind::Unproven;
            };
            match entry.file_type() {
                Ok(t) if t.is_dir() => EntryKind::Dir(name),
                Ok(t) if t.is_file() => EntryKind::Other,
                Ok(t) if t.is_symlink() => {
                    work.stats += 1;
                    match std::fs::metadata(entry.path()) {
                        Ok(m) if m.is_dir() => EntryKind::Dir(name),
                        Ok(_) => EntryKind::Other,
                        Err(_) => EntryKind::Unproven,
                    }
                }
                Ok(_) => EntryKind::Other,
                Err(_) => {
                    work.stats += 1;
                    match std::fs::metadata(entry.path()) {
                        Ok(m) if m.is_dir() => EntryKind::Dir(name),
                        Ok(_) => EntryKind::Other,
                        Err(_) => EntryKind::Unproven,
                    }
                }
            }
        }
    }
}

fn plan_visible(name: &str) -> bool {
    !name.starts_with('.') && !name.starts_with('_')
}

fn round_visible(name: &str) -> bool {
    !name.starts_with('.')
}

pub struct PlansHarness {
    spec: RootSpec,
    home: PathBuf,
    history_days: u32,
    inner: Mutex<Inner>,
    turn: Mutex<Option<Arc<TurnBudget>>>,
    work: Mutex<WorkStats>,
    /// Candidate rounds inspected by the priority selection (application counter, never kernel evidence).
    priority_inspections: AtomicU64,
    census_floor: Duration,
}

/// Application counters for the bounded selection/certification work of this adapter.
///
/// These are *not* a measurement of filesystem work and never substitute for kernel evidence: they
/// count how many resident rounds a page inspected before applying its cap, which is exactly what the
/// §2.3 defect (an uncharged all-round scan) inflated.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SelectionStats {
    /// Rounds examined by the priority selection (queue pops, including stale names). A page with a
    /// large known population but nothing newly discovered inspects none of them.
    pub priority_inspections: u64,
    /// Known rounds whose most recent census ended in an error (maintained counter, so certification
    /// never re-scans the population).
    pub error_rounds: u64,
}

impl PlansHarness {
    pub fn new(root: Option<PathBuf>, home: &Path, history_days: u32) -> Self {
        let hd = if (1..=365).contains(&history_days) {
            history_days
        } else {
            HISTORY_DEFAULT
        };
        Self {
            spec: RootSpec {
                over: root,
                default_rel: "projects/dev/plans",
            },
            home: home.to_path_buf(),
            history_days: hd,
            inner: Mutex::new(Inner::default()),
            turn: Mutex::new(None),
            work: Mutex::new(WorkStats::default()),
            priority_inspections: AtomicU64::new(0),
            census_floor: CENSUS_FLOOR,
        }
    }

    /// Overrides the census floor (tests and fixtures; production keeps [`CENSUS_FLOOR`]).
    pub fn with_census_floor(mut self, floor: Duration) -> Self {
        self.census_floor = floor;
        self
    }

    /// The one allowance of this scheduled turn, or a private bounded one for a standalone call.
    fn allowance(&self) -> Allowance {
        match self.turn.lock().expect("turn lock").clone() {
            Some(b) => Allowance::new(b),
            None => Allowance::standalone(),
        }
    }

    /// Narrow application counters for the independent oracle (never physical evidence).
    pub fn work_stats(&self) -> WorkStats {
        *self.work.lock().expect("work lock")
    }

    /// Application counters for the bounded round selection/certification work.
    pub fn selection_stats(&self) -> SelectionStats {
        let error_rounds = self.inner.lock().expect("plans lock").error_rounds;
        SelectionStats {
            priority_inspections: self.priority_inspections.load(Ordering::Relaxed),
            error_rounds,
        }
    }

    /// True only after a complete error-free traversal in this process whose every round also
    /// finished a complete error-free census. Anything less never certifies absence.
    pub fn discovery_complete_now(&self) -> bool {
        let g = self.inner.lock().expect("plans lock");
        traversal_certifies(&g)
    }

    /// Accumulates one call's counters and records the last-pass values.
    fn publish_work(&self, pass: &WorkStats) {
        let mut w = self.work.lock().expect("work lock");
        w.entries += pass.entries;
        w.stats += pass.stats;
        w.dirs += pass.dirs;
        w.opens += pass.opens;
        w.file_visits += pass.file_visits;
        w.payload_bytes += pass.payload_bytes;
        w.verify_bytes += pass.verify_bytes;
        w.sweeps += pass.sweeps;
        w.sweeps_errored += pass.sweeps_errored;
        w.verifications_started += pass.verifications_started;
        w.verifications_completed += pass.verifications_completed;
        w.last_pass_entries = pass.entries;
        w.last_pass_file_visits = pass.file_visits;
    }
}

/// The census clock of one turn: `now` is read once per turn, `floor` is the configured discovery floor.
#[derive(Clone, Copy)]
struct CensusClock {
    now: Instant,
    floor: Duration,
}

impl CensusClock {
    /// Whether a census may start given the instant it was last allowed to start (`None` = never).
    fn open(&self, next_at: Option<Instant>) -> bool {
        next_at.is_none_or(|t| self.now >= t)
    }

    /// The earliest instant the next census of the same scope may start.
    fn next_after_start(&self) -> Instant {
        self.now + self.floor
    }
}

fn traversal_certifies(g: &Inner) -> bool {
    // Quiescent (no sweep running/queued/reconciling), the traversal finished error-free, and no round's most
    // recent census ended in an error. The error evidence is a maintained counter, so certification costs
    // O(1) instead of scanning every known round on every poll.
    g.walk.complete && !g.walk.error && !g.walk.active && g.live_sweeps == 0 && g.error_rounds == 0
}

/// Pending checkpoint-delta state, drained by `checkpoint_delta()`.
///
/// `paths` are BUILD-LOG/DONE rows that may have changed since the last take, `revs` are revision keys that may have
/// changed, and `removed` holds removal candidates (path -> generation) that a complete sweep or walk proved absent,
/// or that a definite stat of the path reported missing. Marks cost one entry per visit, and a take compares each
/// marked row with its last taken value, so an unchanged visit emits nothing.
#[derive(Default)]
struct DeltaQueue {
    paths: BTreeSet<String>,
    revs: BTreeSet<String>,
    removed: BTreeMap<String, u64>,
}

fn log_path_of(plan: &str, round: &str) -> String {
    format!("{plan}/_build/{round}/BUILD-LOG.md")
}

fn worker_path_of(plan: &str, round: &str, worker: &str) -> String {
    format!("{plan}/_build/{round}/workers/{worker}/DONE")
}

/// The BUILD-LOG row of one round. The whole-state checkpoint and the delta build it the same way, so a row
/// compares equal across both.
fn log_row(plan: &str, round: &str, session: &str, state: &RoundState) -> FileCheckpoint {
    FileCheckpoint {
        path: log_path_of(plan, round),
        generation: state.log.generation,
        offset: state.log.offset,
        size: state.log.size,
        mtime_ms: mtime_ms(state.log.mtime),
        fingerprint: state.log.fingerprint.clone(),
        session: Some(session.to_string()),
        model: None,
        announced: state.seen,
        discarded_bytes: 0,
        incomplete: state.log.offset < state.log.size,
        revision: Some(encode_round_token(state)),
    }
}

/// The DONE row of one worker (same construction for the whole state and for the delta).
fn worker_row(
    plan: &str,
    round: &str,
    session: &str,
    name: &str,
    w: &WorkerState,
) -> FileCheckpoint {
    FileCheckpoint {
        path: worker_path_of(plan, round, name),
        generation: w.generation,
        offset: w.size,
        size: w.size,
        mtime_ms: mtime_ms(w.mtime),
        fingerprint: encode_worker_flags(w.done, w.report),
        session: Some(session.to_string()),
        model: None,
        announced: w.announced,
        discarded_bytes: 0,
        incomplete: false,
        revision: None,
    }
}

/// The current row of a path this adapter reports, or `None` when the path is not live.
fn resolve_row(rounds: &BTreeMap<String, RoundState>, path: &str) -> Option<FileCheckpoint> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 4 || parts[1] != "_build" {
        return None;
    }
    let (plan, round) = (parts[0], parts[2]);
    let session = format!("{plan}/{round}");
    let state = rounds.get(&session)?;
    if parts.len() == 4 && parts[3] == "BUILD-LOG.md" {
        return Some(log_row(plan, round, &session, state));
    }
    if parts.len() == 6 && parts[3] == "workers" && parts[5] == "DONE" {
        return state
            .workers
            .get(parts[4])
            .map(|w| worker_row(plan, round, &session, parts[4], w));
    }
    None
}

/// The stored revision of a key: a live round's token, or a retired round's high-water.
fn revision_of(
    rounds: &BTreeMap<String, RoundState>,
    retired: &BTreeMap<String, RetiredRound>,
    key: &str,
) -> Option<String> {
    match key.strip_prefix(RETIRED_REVISION_PREFIX) {
        Some(session) => retired.get(session).map(encode_retired),
        None => rounds.get(key).map(encode_round_token),
    }
}

/// Drains at most [`MAX_CHECKPOINT_DELTA_ROWS`] rows of pending change. Whatever does not fit stays marked for the
/// next take, so one delta never exceeds the commit ceiling and no change is dropped.
fn take_delta(g: &mut Inner) -> CheckpointDelta {
    let mut upserts: Vec<FileCheckpoint> = Vec::new();
    let mut revisions: BTreeMap<String, String> = BTreeMap::new();
    let mut removed: Vec<RemovedPath> = Vec::new();
    let now = now_ms();
    while upserts.len() + revisions.len() + removed.len() < MAX_CHECKPOINT_DELTA_ROWS {
        let Some((path, generation)) = g.delta.removed.pop_first() else {
            break;
        };
        if resolve_row(&g.rounds, &path).is_some() {
            // Live again before the take: the current row is upserted instead of tombstoned.
            g.delta.paths.insert(path);
        } else if g.acked_files.remove(&path).is_some() {
            // Only a path this adapter committed before needs a tombstone; a never-committed one needs none.
            removed.push(RemovedPath {
                path,
                generation,
                removed_ms: now,
            });
        }
    }
    while upserts.len() + revisions.len() + removed.len() < MAX_CHECKPOINT_DELTA_ROWS {
        let Some(path) = g.delta.paths.pop_first() else {
            break;
        };
        // A path that is no longer live is carried by its removal candidate, never by an upsert.
        let Some(row) = resolve_row(&g.rounds, &path) else {
            continue;
        };
        if g.acked_files.get(&path) != Some(&row) {
            g.acked_files.insert(path, row.clone());
            upserts.push(row);
        }
    }
    while upserts.len() + revisions.len() + removed.len() < MAX_CHECKPOINT_DELTA_ROWS {
        let Some(key) = g.delta.revs.pop_first() else {
            break;
        };
        // A round that left after its live token was committed clears that key with an empty value: a delta can
        // only upsert, and an empty token decodes as "no live round". A key that was never committed is skipped.
        let token = match revision_of(&g.rounds, &g.retired, &key) {
            Some(token) => token,
            None if g.acked_revs.get(&key).is_some_and(|t| !t.is_empty()) => String::new(),
            None => continue,
        };
        if g.acked_revs.get(&key) != Some(&token) {
            g.acked_revs.insert(key.clone(), token.clone());
            revisions.insert(key, token);
        }
    }
    upserts.sort_by(|a, b| a.path.cmp(&b.path));
    CheckpointDelta {
        upserts,
        revisions,
        removed,
    }
}

fn encode_round_token(state: &RoundState) -> String {
    json!({
        "v": ROUND_TOKEN_VERSION,
        "g": state.generation,
        "l": state.log.lines,
        "c": state.sweep.cursor,
        "s": state.sweep.id,
        "o": state.sweep.observed,
        "p": state.sweep.emitted_partial,
        "d": state.sweeps_done,
        "rv": state.run_rev,
        "cv": state.child_rev,
    })
    .to_string()
}

#[derive(Default)]
struct RoundToken {
    generation: u64,
    lines: usize,
    sweep: u64,
    emitted_partial: bool,
    sweeps_done: u64,
    run_rev: u64,
    child_rev: u64,
    /// Decoded for format compatibility only: the sweep continuation and window counters restart in a
    /// fresh window after a restore (a restart cannot resume an OS directory iterator).
    #[allow(dead_code)]
    cursor: Option<String>,
    #[allow(dead_code)]
    observed: u64,
}

/// Serialises a retired round's durable high-water. It uses the same field names as a live round token,
/// so one decoder reads both; the entry is told apart by its `RETIRED_REVISION_PREFIX` key.
fn encode_retired(state: &RetiredRound) -> String {
    json!({
        "v": ROUND_TOKEN_VERSION,
        "g": state.generation,
        "rv": state.run_rev,
        "cv": state.child_rev,
    })
    .to_string()
}

/// Decodes a retired high-water entry (missing keys default to zero, like a legacy token).
fn decode_retired(raw: &str) -> Option<RetiredRound> {
    decode_round_token(raw).map(|t| RetiredRound {
        generation: t.generation,
        run_rev: t.run_rev,
        child_rev: t.child_rev,
    })
}

fn decode_round_token(raw: &str) -> Option<RoundToken> {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        if v.is_object() {
            // Missing keys (a v1/v2 token) default to zero: legacy state restores and the next
            // revision identity is newer than anything that checkpoint already committed.
            return Some(RoundToken {
                generation: v.get("g").and_then(Value::as_u64).unwrap_or(0),
                lines: v.get("l").and_then(Value::as_u64).unwrap_or(0) as usize,
                cursor: v.get("c").and_then(Value::as_str).map(str::to_string),
                sweep: v.get("s").and_then(Value::as_u64).unwrap_or(0),
                observed: v.get("o").and_then(Value::as_u64).unwrap_or(0),
                emitted_partial: v.get("p").and_then(Value::as_bool).unwrap_or(false),
                sweeps_done: v.get("d").and_then(Value::as_u64).unwrap_or(0),
                run_rev: v.get("rv").and_then(Value::as_u64).unwrap_or(0),
                child_rev: v.get("cv").and_then(Value::as_u64).unwrap_or(0),
            });
        }
    }
    // Checkpoints written before the token existed stored the bare revision number.
    raw.parse::<u64>().ok().map(|generation| RoundToken {
        generation,
        ..RoundToken::default()
    })
}

/// Adapter-private DONE/report presence flags, carried in the worker `FileCheckpoint::fingerprint`
/// field so presence survives a restart independently of any byte size.
fn encode_worker_flags(done: bool, report: bool) -> String {
    format!("d{}r{}", u8::from(done), u8::from(report))
}

fn decode_worker_flags(raw: &str) -> Option<(bool, bool)> {
    let (done, report) = raw.strip_prefix('d')?.split_once('r')?;
    Some((done == "1", report == "1"))
}

fn normalize_mtime(m: Option<SystemTime>) -> Option<SystemTime> {
    m.map(|t| {
        let ms = t
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        std::time::UNIX_EPOCH + Duration::from_millis(ms)
    })
}

fn mtime_ms(m: Option<SystemTime>) -> u64 {
    m.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ms_to_time(ms: u64) -> Option<SystemTime> {
    if ms == 0 {
        None
    } else {
        SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(ms))
    }
}

fn history_cutoff(history_days: u32) -> SystemTime {
    SystemTime::now() - Duration::from_secs(history_days as u64 * 86400)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
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

/// What one `DONE`/`REPORT` stat says. Absence is a real observation only when the file is really
/// `NotFound`; any other error is unproven and never becomes a `false` flag.
enum Marker {
    Present {
        mtime: Option<SystemTime>,
        size: u64,
        generation: u64,
    },
    Absent,
    Unproven,
}

fn stat_marker(path: &Path) -> Marker {
    match std::fs::metadata(path) {
        Ok(meta) => Marker::Present {
            mtime: normalize_mtime(meta.modified().ok()),
            size: meta.len(),
            generation: file_generation(&meta),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Marker::Absent,
        Err(_) => Marker::Unproven,
    }
}

/// `(mtime, size, generation)` for a definite observation, `None` while it is unproven.
fn marker_parts(m: &Marker) -> Option<(Option<SystemTime>, u64, u64)> {
    match m {
        Marker::Present {
            mtime,
            size,
            generation,
        } => Some((*mtime, *size, *generation)),
        Marker::Absent => Some((None, 0, 0)),
        Marker::Unproven => None,
    }
}

/// Round-removal candidates still unreconciled in this walk: known rounds the traversal did not
/// enumerate. Derived from counters only (no map scan, no candidate vector).
fn stale_rounds(rounds: &BTreeMap<String, RoundState>, walk: &Walk) -> u64 {
    (rounds.len() as u64)
        .saturating_sub(walk.new_found)
        .saturating_sub(walk.enumerated_known)
}

/// One bounded slice of the round-removal pass. Returns `true` when the pass is finished.
///
/// Only reached after a complete, error-free enumeration: a round that vanished is dropped from the
/// checkpoint here (and only here), one charged visit per candidate, resuming across pages. Dropping a
/// round moves its Run/Child revision high-water into [`Inner::retired`] first, so its identity
/// counters outlive the round without keeping any of its paths active.
fn reconcile_rounds(
    walk: &mut Walk,
    rounds: &mut BTreeMap<String, RoundState>,
    retired: &mut BTreeMap<String, RetiredRound>,
    error_rounds: &mut u64,
    al: &Allowance,
    work: &mut WorkStats,
    delta: &mut DeltaQueue,
) -> bool {
    if !walk.reconciling {
        if stale_rounds(rounds, walk) == 0 {
            walk.reconcile = None;
            return true;
        }
        walk.reconciling = true;
        walk.reconcile = None;
    }
    let mut budget = WALK_RECONCILE_VISITS_PER_PAGE;
    loop {
        if budget == 0 {
            return false;
        }
        let next = match walk.reconcile.clone() {
            Some(cursor) => rounds
                .range((Bound::Excluded(cursor), Bound::Unbounded))
                .next()
                .map(|(k, _)| k.clone()),
            None => rounds.keys().next().cloned(),
        };
        let Some(session) = next else {
            walk.reconciling = false;
            walk.reconcile = None;
            return true;
        };
        if !al.visit() {
            return false;
        }
        work.file_visits += 1;
        budget -= 1;
        if rounds.get(&session).is_some_and(|r| r.seen_walk != walk.id) {
            if let Some(state) = rounds.remove(&session) {
                if state.sweep.error {
                    *error_rounds = error_rounds.saturating_sub(1);
                }
                // A proven round removal: every row it had is a removal candidate, and its high-water changes.
                if let Some((plan, round)) = session.split_once('/') {
                    delta
                        .removed
                        .insert(log_path_of(plan, round), state.log.generation);
                    for (name, w) in &state.workers {
                        delta
                            .removed
                            .insert(worker_path_of(plan, round, name), w.generation);
                    }
                }
                delta.revs.insert(session.clone());
                delta
                    .revs
                    .insert(format!("{RETIRED_REVISION_PREFIX}{session}"));
                retired.entry(session.clone()).or_default().absorb(&state);
            }
        }
        walk.reconcile = Some(session);
    }
}

/// Advances the plan/round traversal for at most one bounded slice of this page's entries.
#[allow(clippy::too_many_arguments)]
fn walk_step(
    walk: &mut Walk,
    rounds: &mut BTreeMap<String, RoundState>,
    retired: &mut BTreeMap<String, RetiredRound>,
    fresh: &mut VecDeque<String>,
    error_rounds: &mut u64,
    root: &Path,
    al: &Allowance,
    work: &mut WorkStats,
    limit: u64,
    delta: &mut DeltaQueue,
) {
    let start_entries = work.entries;
    loop {
        if walk.error {
            walk.fail();
            return;
        }
        if walk.enum_done {
            // A complete, error-free enumeration happened: only now may a round be proven absent.
            if reconcile_rounds(walk, rounds, retired, error_rounds, al, work, delta) {
                walk.complete = true;
            }
            return;
        }
        if !walk.active || work.entries - start_entries >= limit {
            return;
        }
        // Drain the current `_build` iterator one entry at a time.
        if let Some(mut rd) = walk.build.take() {
            match next_entry(&mut rd, al, work) {
                EntryKind::Budget => {
                    walk.build = Some(rd);
                    return;
                }
                EntryKind::End => {
                    walk.build = None;
                    walk.plan = None;
                    continue;
                }
                EntryKind::ReadError | EntryKind::Unproven => {
                    walk.build = Some(rd);
                    walk.error = true;
                    walk.fail();
                    return;
                }
                EntryKind::Other => {
                    walk.build = Some(rd);
                    continue;
                }
                EntryKind::Dir(name) => {
                    walk.build = Some(rd);
                    if !round_visible(&name) {
                        continue;
                    }
                    if let Some(plan) = walk.plan.clone() {
                        let session = format!("{plan}/{name}");
                        match rounds.get_mut(&session) {
                            Some(state) => {
                                state.seen_walk = walk.id;
                                walk.enumerated_known += 1;
                            }
                            None => {
                                // A newly discovered round starts above any retired high-water of the
                                // same session, so a round that reappears after a committed removal can
                                // never reuse a Run/Child producer key the store already stored.
                                let mut state = RoundState {
                                    seen_walk: walk.id,
                                    ..Default::default()
                                };
                                if let Some(retired) = retired.get(&session) {
                                    state.generation = retired.generation;
                                    state.run_rev = retired.run_rev;
                                    state.child_rev = retired.child_rev;
                                }
                                rounds.insert(session.clone(), state);
                                fresh.push_back(session);
                                walk.new_found += 1;
                            }
                        }
                    }
                    continue;
                }
            }
        }
        // No build iterator: take the next visible plan and open its `_build`.
        if walk.plans.is_none() {
            if !al.visit() {
                return;
            }
            work.dirs += 1;
            match std::fs::read_dir(root) {
                Ok(rd) => walk.plans = Some(rd),
                Err(_) => {
                    walk.error = true;
                    walk.fail();
                    return;
                }
            }
        }
        let Some(mut rd) = walk.plans.take() else {
            return;
        };
        match next_entry(&mut rd, al, work) {
            EntryKind::Budget => {
                walk.plans = Some(rd);
                return;
            }
            EntryKind::End => {
                walk.plans = None;
                walk.active = false;
                walk.enum_done = true;
                continue;
            }
            EntryKind::ReadError | EntryKind::Unproven => {
                walk.plans = Some(rd);
                walk.error = true;
                walk.fail();
                return;
            }
            EntryKind::Other => {
                walk.plans = Some(rd);
                continue;
            }
            EntryKind::Dir(name) => {
                walk.plans = Some(rd);
                if !plan_visible(&name) {
                    continue;
                }
                if !al.visit() {
                    return;
                }
                work.dirs += 1;
                let build = root.join(&name).join("_build");
                match std::fs::read_dir(&build) {
                    Ok(b) => {
                        walk.plan = Some(name);
                        walk.build = Some(b);
                    }
                    // A plan without `_build/` is ordinary, not an error.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    // Anything else leaves this plan's rounds unproven: keep them and retry.
                    Err(_) => {
                        walk.error = true;
                        walk.fail();
                        return;
                    }
                }
            }
        }
    }
}

/// A sweep is startable when it is neither running, queued nor reconciling (fresh, finished or errored).
fn sweep_startable(sweep: &Sweep) -> bool {
    !sweep.active && sweep.unvisited.is_empty() && !sweep.reconciling
}

/// A sweep finished a complete, error-free census: enumeration end, empty queue, finished removal pass.
fn sweep_finished(sweep: &Sweep) -> bool {
    !sweep.active
        && sweep.enum_done
        && !sweep.error
        && sweep.unvisited.is_empty()
        && !sweep.reconciling
}

/// Worker-removal candidates still unreconciled in this sweep, derived from counters only.
fn stale_workers(workers: &BTreeMap<String, WorkerState>, sweep: &Sweep) -> u64 {
    (workers.len() as u64)
        .saturating_sub(sweep.new_found)
        .saturating_sub(sweep.enumerated_known)
}

/// One bounded slice of the worker-removal pass over the known map in sorted order.
///
/// Returns `(finished, removed_any)`. Never called from an incomplete or errored enumeration.
fn reconcile_workers(
    workers: &mut BTreeMap<String, WorkerState>,
    done_known: &mut u64,
    sweep: &mut Sweep,
    al: &Allowance,
    work: &mut WorkStats,
    delta: &mut DeltaQueue,
    workers_prefix: &str,
) -> (bool, bool) {
    let mut removed_any = false;
    if !sweep.reconciling {
        // Cheap exact check: every known worker was enumerated, so nothing can be stale. This keeps
        // the common (nothing disappeared) sweep free of a full known-map pass.
        if stale_workers(workers, sweep) == 0 {
            sweep.reconcile = None;
            return (true, false);
        }
        sweep.reconciling = true;
        sweep.reconcile = None;
    }
    loop {
        let next = match sweep.reconcile.clone() {
            Some(cursor) => workers
                .range((Bound::Excluded(cursor), Bound::Unbounded))
                .next()
                .map(|(k, _)| k.clone()),
            None => workers.keys().next().cloned(),
        };
        let Some(name) = next else {
            sweep.reconciling = false;
            sweep.reconcile = None;
            return (true, removed_any);
        };
        if !al.visit() {
            return (false, removed_any);
        }
        work.file_visits += 1;
        let stale = workers.get(&name).is_some_and(|w| w.seen_sweep != sweep.id);
        if stale {
            if let Some(w) = workers.remove(&name) {
                if w.done {
                    *done_known = done_known.saturating_sub(1);
                }
                // Proven by the complete enumeration of this sweep: a removal candidate.
                delta
                    .removed
                    .insert(format!("{workers_prefix}/{name}/DONE"), w.generation);
            }
            removed_any = true;
        }
        sweep.reconcile = Some(name);
    }
}

/// What one `service_round` slice did: a sweep that just finished, and how the count of live
/// (running/queued/reconciling) sweeps changed.
struct ServiceOutcome {
    finished: bool,
    live_delta: i32,
}

impl ServiceOutcome {
    fn idle() -> Self {
        Self {
            finished: false,
            live_delta: 0,
        }
    }
}

/// Observes one round for at most one bounded slice of this page's allowance.
#[allow(clippy::too_many_arguments)]
fn service_round(
    state: &mut RoundState,
    session: &str,
    root: &Path,
    al: &Allowance,
    work: &mut WorkStats,
    page: &mut Page,
    baseline: bool,
    cutoff: SystemTime,
    page_seq: u64,
    may_restart: bool,
    witness_only: bool,
    clock: CensusClock,
    delta: &mut DeltaQueue,
) -> ServiceOutcome {
    let Some((plan, round)) = session.split_once('/') else {
        return ServiceOutcome::idle();
    };
    let dir = root.join(plan).join("_build").join(round);

    let RoundState {
        log,
        workers,
        done_known,
        generation,
        run_rev,
        child_rev,
        sweeps_done,
        seen: round_seen,
        seen_walk: _,
        sweep,
        sweep_live,
        census_next_at,
        enum_dir,
        last_page,
    } = state;
    let prev_seen = *round_seen;

    // ---- BUILD-LOG witness (one visit; every content byte charged; resumable) ---------
    // Witness-only slices serve a round with an open pass and nothing else: no visit, no census, no sweep state.
    if witness_only && log.pass.is_none() {
        return ServiceOutcome::idle();
    }
    if !witness_only {
        if !al.visit() {
            *last_page = page_seq;
            return ServiceOutcome::idle();
        }
        work.file_visits += 1;
    }
    let log_path = dir.join("BUILD-LOG.md");
    let mut log_unproven = false;
    work.stats += 1;
    let (log_exists, log_mtime, log_size, log_gen) = match std::fs::metadata(&log_path) {
        Ok(m) if m.is_file() => (
            true,
            normalize_mtime(m.modified().ok()),
            m.len(),
            file_generation(&m),
        ),
        Ok(_) => (false, None, 0, 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None, 0, 0),
        Err(_) => {
            log_unproven = true;
            (false, None, 0, 0)
        }
    };

    let round_old = log_mtime.map(|m| m < cutoff).unwrap_or(false) && !prev_seen;
    let baseline_this = baseline && log.size == log_size && !prev_seen && *generation <= 1;
    let suppress = round_old || baseline_this;

    // The witness covers the whole content, not a prefix: every pass re-hashes `[0, size)` of the snapshot
    // it started with, so a same-size rewrite that keeps inode and mtime is seen. Charged bytes come from the
    // shared turn allowance and a pass resumes on later pages. Only a completed pass publishes its digest,
    // line count, size and identity; a partial pass is never visible in the checkpoint or the emitted Run.
    let mut log_changed = false;
    if log_unproven {
        // Unreadable is not absent: keep the last proven state and drop the pass that cannot be trusted.
        log.pass = None;
    } else if !log_exists {
        log.pass = None;
        if !log.fingerprint.is_empty() {
            log_changed = prev_seen;
            log.offset = 0;
            log.size = 0;
            log.lines = 0;
            log.mtime = None;
            log.generation = log_gen;
            log.fingerprint.clear();
        }
    } else {
        // A pass whose file was replaced, or truncated below its snapshot, restarts from byte 0. A file that
        // grew keeps its snapshot: the pass covers exactly the bytes it started with.
        let fresh = match &log.pass {
            Some(p) => p.generation != log_gen || log_size < p.size,
            None => true,
        };
        if fresh {
            log.pass = Some(LogPass::begin(log_size, log_gen, log_mtime));
        }
        let step = match log.pass.as_mut() {
            Some(pass) => advance_log_pass(pass, &log_path, al, work),
            None => PassStep::Pending,
        };
        match step {
            PassStep::Pending => {}
            PassStep::Restart => log.pass = None,
            PassStep::Unproven => {
                log_unproven = true;
                log.pass = None;
            }
            PassStep::Complete => {
                if let Some(pass) = log.pass.take() {
                    let digest = to_hex(&pass.hasher.finalize());
                    let lines = pass.scan.lines;
                    log_changed = prev_seen && log_witness_changed(log, &digest, lines, pass.size);
                    log.offset = pass.size;
                    log.size = pass.size;
                    log.lines = lines;
                    log.mtime = pass.mtime;
                    log.generation = pass.generation;
                    log.fingerprint = digest;
                }
            }
        }
    }

    // ---- census lifecycle -----------------------------------------------------------
    // A finished (or not yet started) sweep opens a fresh window only once the source has reached a
    // quiescent census or this round waited out the bounded stall guard: restarting every page would mean
    // no round is ever complete at the same moment, so no census could ever be certified. The candidate
    // queue starts empty and is filled by the enumeration below: the known map is never copied out.
    let may_start = may_restart || sweep.error || sweep.idle_pages >= SWEEP_RESTART_IDLE_PAGES;
    // The discovery floor: a new census window of this round may open only once the floor since its previous
    // window start has passed. Continuation of an open window is never gated.
    if !witness_only
        && sweep_startable(sweep)
        && !log_unproven
        && may_start
        && clock.open(*census_next_at)
    {
        *census_next_at = Some(clock.next_after_start());
        sweep.id = sweep.id.saturating_add(1);
        sweep.active = true;
        sweep.enum_done = false;
        sweep.error = false;
        sweep.unvisited.clear();
        sweep.observed = 0;
        sweep.done_observed = 0;
        sweep.cursor = None;
        sweep.reconciling = false;
        sweep.reconcile = None;
        sweep.counted = false;
        sweep.enumerated_known = 0;
        sweep.new_found = 0;
        sweep.idle_pages = 0;
        *enum_dir = None;
    }
    if log_unproven {
        // The row cannot be re-observed this sweep: absence of anything is unproven, nothing is
        // reconciled, every known worker and every committed flag stays exactly as it was.
        sweep.error = true;
        sweep.active = false;
        sweep.enum_done = false;
        sweep.unvisited.clear();
        sweep.reconciling = false;
        sweep.reconcile = None;
        *enum_dir = None;
        work.sweeps_errored += 1;
    }

    // ---- worker enumeration (bounded by the shared entry allowance) ------------------
    let mut removed = false;
    if sweep.active && !sweep.error && !witness_only {
        let mut slice = ROUND_ENTRIES_PER_PAGE.min(al.remaining_entries());
        if enum_dir.is_none() && slice > 0 {
            if !al.visit() {
                slice = 0;
            } else {
                work.dirs += 1;
                let workers_dir = dir.join("workers");
                match std::fs::read_dir(&workers_dir) {
                    Ok(rd) => *enum_dir = Some(rd),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // No `workers/` directory: the census is empty and honestly complete (the removal
                        // pass below then proves every known worker gone).
                        sweep.active = false;
                        sweep.enum_done = true;
                        work.sweeps += 1;
                        slice = 0;
                    }
                    Err(_) => {
                        sweep.error = true;
                        sweep.active = false;
                        sweep.enum_done = false;
                        sweep.unvisited.clear();
                        work.sweeps_errored += 1;
                        slice = 0;
                    }
                }
            }
        }
        while sweep.active && slice > 0 {
            let Some(rd) = enum_dir.as_mut() else { break };
            match next_entry(rd, al, work) {
                EntryKind::Budget => break,
                EntryKind::End => {
                    *enum_dir = None;
                    sweep.active = false;
                    sweep.enum_done = true;
                    work.sweeps += 1;
                    break;
                }
                EntryKind::ReadError | EntryKind::Unproven => {
                    *enum_dir = None;
                    sweep.error = true;
                    sweep.active = false;
                    sweep.enum_done = false;
                    sweep.unvisited.clear();
                    work.sweeps_errored += 1;
                    break;
                }
                EntryKind::Other => {
                    slice = slice.saturating_sub(1);
                    continue;
                }
                EntryKind::Dir(name) => {
                    slice = slice.saturating_sub(1);
                    match workers.get_mut(&name) {
                        Some(w) => {
                            w.seen_sweep = sweep.id;
                            sweep.enumerated_known += 1;
                        }
                        None => {
                            workers.insert(
                                name.clone(),
                                WorkerState {
                                    seen_sweep: sweep.id,
                                    ..Default::default()
                                },
                            );
                            sweep.new_found += 1;
                        }
                    }
                    // Candidate for this sweep's observation window: ordered, incremental, no copy.
                    sweep.unvisited.insert(name);
                }
            }
        }
    }

    // ---- worker observations (bounded by the shared visit allowance) -----------------
    let mut changed: Vec<(String, WorkerState)> = Vec::new();
    let mut visits_this_slice = 0u64;
    while !witness_only
        && !sweep.unvisited.is_empty()
        && !sweep.error
        && visits_this_slice < ROUND_VISITS_PER_PAGE
        && al.remaining_visits() > 0
        && page.items.len() + changed.len() + 1 < MAX_FILES_PER_PASS
    {
        let Some(name) = sweep.unvisited.pop_first() else {
            break;
        };
        if !al.visit() {
            sweep.unvisited.insert(name);
            break;
        }
        work.file_visits += 1;
        visits_this_slice += 1;
        let wdir = dir.join("workers").join(&name);
        work.stats += 1;
        match std::fs::metadata(&wdir) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The worker directory genuinely does not exist: drop that stale observation. This is
                // one definite absence, not a census conclusion; the aggregate is still owed because
                // the population changed.
                if let Some(w) = workers.remove(&name) {
                    if w.done {
                        *done_known = done_known.saturating_sub(1);
                    }
                    // A stat reported this one path missing: a definite absence, so it is a removal candidate.
                    delta
                        .removed
                        .insert(worker_path_of(plan, round, &name), w.generation);
                }
                removed = true;
                continue;
            }
            Err(_) => {
                // Unreadable (permissions, I/O error): unproven. This sweep reconciles nothing and a
                // later complete sweep must re-prove the population; prior durable state is kept.
                sweep.error = true;
                sweep.active = false;
                sweep.enum_done = false;
                sweep.unvisited.clear();
                sweep.reconciling = false;
                sweep.reconcile = None;
                *enum_dir = None;
                work.sweeps_errored += 1;
                break;
            }
        }
        work.stats += 2;
        let done_stat = stat_marker(&wdir.join("DONE"));
        let report_stat = stat_marker(&wdir.join("REPORT.md"));
        let (Some((dm, ds, dg)), Some((rm, rs, rg))) =
            (marker_parts(&done_stat), marker_parts(&report_stat))
        else {
            // A marker that cannot be inspected is unproven, never "absent": `done:false` is a claim.
            sweep.error = true;
            sweep.active = false;
            sweep.enum_done = false;
            sweep.unvisited.clear();
            sweep.reconciling = false;
            sweep.reconcile = None;
            *enum_dir = None;
            work.sweeps_errored += 1;
            break;
        };
        sweep.observed += 1;
        if dm.is_some() {
            sweep.done_observed += 1;
        }
        let observed = WorkerState {
            done: dm.is_some(),
            report: rm.is_some(),
            mtime: dm.max(rm),
            size: ds + rs,
            generation: dg.max(rg),
            announced: true,
            seen_sweep: sweep.id,
        };
        let changed_this = match workers.get(&name) {
            Some(prev) => {
                !prev.announced
                    || prev.done != observed.done
                    || prev.report != observed.report
                    || prev.mtime != observed.mtime
                    || prev.size != observed.size
                    || prev.generation != observed.generation
            }
            None => true,
        };
        if changed_this && !suppress {
            changed.push((name.clone(), observed.clone()));
        }
        sweep.cursor = Some(name.clone());
        let had_done = workers.get(&name).map(|w| w.done).unwrap_or(false);
        if had_done != observed.done {
            if observed.done {
                *done_known = done_known.saturating_add(1);
            } else {
                *done_known = done_known.saturating_sub(1);
            }
        }
        if changed_this {
            delta.paths.insert(worker_path_of(plan, round, &name));
        }
        workers.insert(name, observed);
    }

    // ---- removal reconciliation (only after a complete, error-free enumeration) ------
    if !witness_only && sweep.enum_done && sweep.unvisited.is_empty() && !sweep.error {
        let workers_prefix = format!("{plan}/_build/{round}/workers");
        let (finished, any) =
            reconcile_workers(workers, done_known, sweep, al, work, delta, &workers_prefix);
        removed |= any;
        let _ = finished;
    }

    // ---- run aggregate (children first, the aggregate that counts them last) ---------
    let finished = sweep_finished(sweep);
    let complete = finished && sweep.enum_done && !sweep.error;
    if complete {
        // A completed sweep leaves no partial continuation: the next sweep re-verifies from the
        // start, so a change made to a worker this sweep already visited is still observed.
        sweep.cursor = None;
    }
    let became_complete = !witness_only && complete && sweep.emitted_partial;
    let dirty = !prev_seen || log_changed || removed || !changed.is_empty() || became_complete;

    if !suppress && dirty {
        // The aggregate is emitted in the same batch as the last children of its window, after them.
        let room = MAX_FILES_PER_PASS.saturating_sub(page.items.len());
        if changed.len() < room {
            for (name, observed) in changed {
                *child_rev = child_rev.saturating_add(1);
                let id = RecordKey::revision(format!("{session}/child"), child_rev.to_string(), 0);
                page.push(
                    BatchItem {
                        kind: ItemKind::Child,
                        session: session.to_string(),
                        data: json!({
                            "worker": name,
                            "done": observed.done,
                            "report": observed.report,
                        }),
                    },
                    id,
                );
            }
            // A partial aggregate reports the observations of its own sweep window; a complete one
            // reports the reconciled population. Never the other way round.
            let (worker_count, done_count) = if complete {
                (workers.len() as u64, *done_known)
            } else {
                (sweep.observed, sweep.done_observed)
            };
            let mut data = json!({
                "plan": plan,
                "round": round,
                "workers": worker_count,
                "done": done_count,
                "build_log_lines": if log_exists { Value::from(log.lines as u64) } else { Value::Null },
            });
            if complete {
                sweep.emitted_partial = false;
            } else {
                sweep.emitted_partial = true;
                data["partial"] = Value::Bool(true);
                data["coverage"] = json!({
                    "sweep": sweep.id,
                    "observed": sweep.observed,
                    "done_observed": sweep.done_observed,
                    "known": workers.len(),
                    "known_done": *done_known,
                    "total_known": sweep.enum_done,
                    "enumeration_complete": !sweep.active && sweep.enum_done,
                    "stale_reconciled": sweep.enum_done && !sweep.reconciling,
                    "errors": sweep.error,
                    "sweep_complete": complete,
                });
            }
            *run_rev = run_rev.saturating_add(1);
            let id = RecordKey::revision(format!("{session}/run"), run_rev.to_string(), 0);
            page.push(
                BatchItem {
                    kind: ItemKind::Run,
                    session: session.to_string(),
                    data,
                },
                id,
            );
            *generation += 1;
        }
    }
    let mut just_finished = false;
    if finished && !sweep.counted {
        sweep.counted = true;
        *sweeps_done = sweeps_done.saturating_add(1);
        just_finished = true;
    }
    let idle = sweep_startable(sweep);
    if !witness_only && idle {
        if !*sweep_live {
            sweep.idle_pages = sweep.idle_pages.saturating_add(1);
        }
    } else if !witness_only {
        sweep.idle_pages = 0;
    }
    let live_delta = if witness_only {
        0
    } else if *sweep_live && idle {
        *sweep_live = false;
        -1
    } else if !*sweep_live && !idle {
        *sweep_live = true;
        1
    } else {
        0
    };

    // The BUILD-LOG row and the round token may have changed on this visit; a take compares them with the last
    // taken values, so an unchanged visit emits nothing.
    delta.paths.insert(log_path_of(plan, round));
    delta.revs.insert(session.to_string());
    *round_seen = true;
    *last_page = page_seq;

    ServiceOutcome {
        finished: just_finished,
        live_delta,
    }
}

/// Serves rounds in fair rotation: every round at most one bounded slice per page.
///
/// Returns the number of round sweeps that finished in this page (core's discovery epoch advances by it).
#[allow(clippy::too_many_arguments)]
fn service_rounds(
    g: &mut Inner,
    root: &Path,
    al: &Allowance,
    work: &mut WorkStats,
    page: &mut Page,
    baseline: bool,
    cutoff: SystemTime,
    page_seq: u64,
    may_restart: bool,
    priority_inspections: &AtomicU64,
    witness_only: bool,
    clock: CensusClock,
) -> u64 {
    let mut completed = 0u64;
    let mut live_delta = 0i32;
    let mut error_delta = 0i32;
    // Priority selection: rounds this process discovered are queued when the walk inserts them, so a
    // new round is served first without inspecting every already-seen round (the §2.3 uncharged scan).
    // A queued round is served at most once here (its first aggregate); later pages continue it in the
    // fair rotation below, so the queue can never starve or duplicate service.
    while let Some(session) = if witness_only {
        None
    } else {
        g.fresh.pop_front()
    } {
        priority_inspections.fetch_add(1, Ordering::Relaxed);
        if page.full() || al.exhausted() {
            g.fresh.push_front(session);
            break;
        }
        let Some(state) = g.rounds.get_mut(&session) else {
            // The round was removed by the bounded removal pass before it could be served.
            continue;
        };
        if state.last_page == page_seq {
            continue;
        }
        let was_error = state.sweep.error;
        let outcome = service_round(
            state,
            &session,
            root,
            al,
            work,
            page,
            baseline,
            cutoff,
            page_seq,
            may_restart,
            witness_only,
            clock,
            &mut g.delta,
        );
        if state.sweep.error != was_error {
            error_delta += if state.sweep.error { 1 } else { -1 };
        }
        if outcome.finished {
            completed += 1;
        }
        live_delta += outcome.live_delta;
        g.next_session = Some(session);
    }
    macro_rules! serve {
        ($iter:expr) => {
            for (session, state) in $iter {
                if page.full() || al.exhausted() {
                    g.live_sweeps = apply_live_delta(g.live_sweeps, live_delta);
                    g.error_rounds = apply_live_delta(g.error_rounds, error_delta);
                    return completed;
                }
                if state.last_page == page_seq {
                    continue;
                }
                let was_error = state.sweep.error;
                let outcome = service_round(
                    state,
                    session,
                    root,
                    al,
                    work,
                    page,
                    baseline,
                    cutoff,
                    page_seq,
                    may_restart,
                    witness_only,
                    clock,
                    &mut g.delta,
                );
                if state.sweep.error != was_error {
                    error_delta += if state.sweep.error { 1 } else { -1 };
                }
                if outcome.finished {
                    completed += 1;
                }
                live_delta += outcome.live_delta;
                g.next_session = Some(session.clone());
            }
        };
    }
    // Fair rotation over every round: one bounded slice each, continuing where the last page stopped.
    let start = g.next_session.clone();
    match start {
        None => serve!(g.rounds.iter_mut()),
        Some(cursor) => {
            serve!(g
                .rounds
                .range_mut((Bound::Excluded(cursor.clone()), Bound::Unbounded)));
            serve!(g
                .rounds
                .range_mut((Bound::Unbounded, Bound::Included(cursor))));
        }
    }
    g.live_sweeps = apply_live_delta(g.live_sweeps, live_delta);
    g.error_rounds = apply_live_delta(g.error_rounds, error_delta);
    completed
}

/// Applies one page's live-sweep count changes, keeping the counter exact and non-negative.
fn apply_live_delta(current: u64, delta: i32) -> u64 {
    if delta >= 0 {
        current.saturating_add(delta as u64)
    } else {
        current.saturating_sub(delta.unsigned_abs() as u64)
    }
}

fn detect_step(detect: &mut DetectWalk, root: &Path, al: &Allowance, work: &mut WorkStats) {
    loop {
        if !detect.active {
            return;
        }
        if let Some(mut rd) = detect.build.take() {
            match next_entry(&mut rd, al, work) {
                EntryKind::Budget => {
                    detect.build = Some(rd);
                    return;
                }
                EntryKind::End => {
                    detect.build = None;
                    detect.plan = None;
                    continue;
                }
                EntryKind::ReadError | EntryKind::Unproven | EntryKind::Other => {
                    detect.build = Some(rd);
                    continue;
                }
                EntryKind::Dir(name) => {
                    detect.build = Some(rd);
                    if !round_visible(&name) {
                        continue;
                    }
                    if let Some(plan) = &detect.plan {
                        let round_dir = root.join(plan).join("_build").join(&name);
                        work.stats += 2;
                        if round_dir.join("workers").is_dir()
                            || round_dir.join("BUILD-LOG.md").is_file()
                        {
                            detect.found = true;
                            return;
                        }
                    }
                    continue;
                }
            }
        }
        if detect.plans.is_none() {
            if !al.visit() {
                return;
            }
            work.dirs += 1;
            match std::fs::read_dir(root) {
                Ok(rd) => detect.plans = Some(rd),
                Err(_) => {
                    detect.active = false;
                    return;
                }
            }
        }
        let Some(mut rd) = detect.plans.take() else {
            return;
        };
        match next_entry(&mut rd, al, work) {
            EntryKind::Budget => {
                detect.plans = Some(rd);
                return;
            }
            EntryKind::End => {
                detect.active = false;
                detect.plans = None;
                detect.build = None;
                detect.plan = None;
                return;
            }
            EntryKind::ReadError | EntryKind::Unproven | EntryKind::Other => {
                detect.plans = Some(rd);
                continue;
            }
            EntryKind::Dir(name) => {
                detect.plans = Some(rd);
                if !plan_visible(&name) {
                    continue;
                }
                if !al.visit() {
                    return;
                }
                work.dirs += 1;
                let build = root.join(&name).join("_build");
                // A plan without `_build/` is ordinary; a transient error cannot prove anything for
                // detection either, so detection simply keeps surveying.
                if let Ok(b) = std::fs::read_dir(&build) {
                    detect.plan = Some(name);
                    detect.build = Some(b);
                }
            }
        }
    }
}

impl Source for PlansHarness {
    fn id(&self) -> &'static str {
        ID
    }

    fn kind(&self) -> SourceKind {
        SourceKind::Harness
    }

    fn detect(&self, env: &Env) -> Detection {
        let root = self.spec.resolve(&env.home);
        if !root.is_dir() {
            let mut g = self.inner.lock().expect("plans lock");
            g.detect = DetectWalk::default();
            return Detection::NotDetected {
                reason: "~/projects/dev/plans not found".into(),
            };
        }
        let al = self.allowance();
        let mut work = WorkStats::default();
        let mut g = self.inner.lock().expect("plans lock");
        if !g.detect_found {
            if !g.detect.active {
                g.detect = DetectWalk {
                    active: true,
                    ..DetectWalk::default()
                };
            }
            detect_step(&mut g.detect, &root, &al, &mut work);
            if g.detect.found {
                g.detect_found = true;
                g.detect = DetectWalk::default();
            }
        }
        let found = g.detect_found;
        drop(g);
        self.publish_work(&work);
        if found {
            Detection::Detected { paths: vec![root] }
        } else {
            Detection::NotDetected {
                reason: "plans harness layout not found (no valid _build rounds)".into(),
            }
        }
    }

    fn capabilities(&self) -> Caps {
        Caps::WATCH
    }

    fn begin_turn(&self, allowance: Arc<TurnBudget>) {
        *self.turn.lock().expect("turn lock") = Some(allowance);
    }

    fn end_turn(&self) {
        *self.turn.lock().expect("turn lock") = None;
    }

    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        Box::pin(async move {
            let root = self.spec.resolve(&self.home);
            let al = self.allowance();
            let mut work = WorkStats::default();
            let mut page = Page::default();
            let mut g = self.inner.lock().expect("plans lock");

            if since.0 == 0 {
                if g.restored {
                    g.restored = false;
                    g.baseline = true;
                } else {
                    *g = Inner::default();
                }
            } else if g.restored {
                g.restored = false;
                g.baseline = true;
            }
            // One census clock per turn: every floor decision of this turn reads the same instant.
            let clock = CensusClock {
                now: Instant::now(),
                floor: self.census_floor,
            };
            // A finished traversal is re-walked once the census is quiescent (so a completed walk can
            // actually coincide with every round being complete: that is the only state that certifies
            // discovery), and an errored one is retried immediately. The hold is bounded so one long or
            // erroring round cannot stop new plans/rounds from being discovered.
            if g.walk.complete && g.live_sweeps > 0 {
                g.walk_hold = g.walk_hold.saturating_add(1);
            }
            // A completed walk keeps its certified state until the floor allows the next walk: resetting it early
            // would make `discovery_complete()` read false for the whole floor interval.
            if (g.walk.error
                || (g.walk.complete
                    && (g.live_sweeps == 0 || g.walk_hold >= SWEEP_RESTART_IDLE_PAGES)))
                && clock.open(g.walk_next_at)
            {
                g.walk = Walk::default();
                g.walk_hold = 0;
            }
            // Plan/round discovery is a census too: a new walk starts only once the floor since the previous one has
            // passed. A walk that is in progress is never gated.
            if g.walk.idle() && clock.open(g.walk_next_at) {
                g.walk_next_at = Some(clock.next_after_start());
                g.walk_seq = g.walk_seq.saturating_add(1);
                let seq = g.walk_seq;
                g.walk = Walk::start(seq);
            }
            g.identities.clear();
            g.page_seq += 1;
            let page_seq = g.page_seq;
            // Quiescent at the start of this turn: every round chose to re-sweep together, which is the only
            // state in which the whole tree can be complete at the same moment (see `may_start`).
            let may_restart = g.live_sweeps == 0;
            let baseline = g.baseline;
            let cutoff = history_cutoff(self.history_days);

            let mut walk_spent = 0u64;
            let mut completed = 0u64;
            loop {
                if page.full() || al.exhausted() {
                    break;
                }
                let before = (work.entries, work.file_visits);
                if !g.walk.complete && !g.walk.error {
                    let limit = WALK_ENTRIES_PER_PAGE.saturating_sub(walk_spent);
                    let entries_before = work.entries;
                    let Inner {
                        walk,
                        rounds,
                        retired,
                        fresh,
                        error_rounds,
                        delta,
                        ..
                    } = &mut *g;
                    walk_step(
                        walk,
                        rounds,
                        retired,
                        fresh,
                        error_rounds,
                        &root,
                        &al,
                        &mut work,
                        limit,
                        delta,
                    );
                    walk_spent += work.entries - entries_before;
                }
                completed += service_rounds(
                    &mut g,
                    &root,
                    &al,
                    &mut work,
                    &mut page,
                    baseline,
                    cutoff,
                    page_seq,
                    may_restart,
                    &self.priority_inspections,
                    false,
                    clock,
                );
                if (work.entries, work.file_visits) == before {
                    break;
                }
            }
            // Witness continuation: rounds with an open full-content pass take their next slices on the turn's
            // remaining bytes. This touches no census state and emits only a completed, changed witness, so the
            // batching of ordinary pages is unchanged. It stops when the allowance or the page is spent, or when a
            // slice reads nothing.
            loop {
                if page.full() || al.bytes_exhausted() {
                    break;
                }
                let bytes_before = work.payload_bytes;
                g.page_seq += 1;
                let witness_seq = g.page_seq;
                completed += service_rounds(
                    &mut g,
                    &root,
                    &al,
                    &mut work,
                    &mut page,
                    baseline,
                    cutoff,
                    witness_seq,
                    may_restart,
                    &self.priority_inspections,
                    true,
                    clock,
                );
                if work.payload_bytes == bytes_before {
                    break;
                }
            }
            g.epoch = g.epoch.saturating_add(completed);

            if !page.items.is_empty() {
                g.gen += page.items.len() as u64;
            }
            let next = if page.items.is_empty() {
                Cursor(since.0)
            } else {
                Cursor(g.gen)
            };
            g.identities = std::mem::take(&mut page.ids);
            drop(g);
            self.publish_work(&work);
            Ok(Batch {
                items: page.items,
                next,
            })
        })
    }

    fn identities(&self) -> Vec<RecordKey> {
        self.inner.lock().expect("plans lock").identities.clone()
    }

    fn offsets(&self) -> Vec<FileOffset> {
        let mut g = self.inner.lock().expect("plans lock");
        let mut out = Vec::new();
        for (session, state) in &g.rounds {
            let Some((plan, round)) = session.split_once('/') else {
                continue;
            };
            out.push(FileOffset {
                path: format!("{plan}/_build/{round}/BUILD-LOG.md"),
                offset: state.log.offset,
                size: state.log.size,
            });
        }
        g.committed_rounds = g.rounds.clone();
        g.committed_gen = g.gen;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    fn restore_offsets(&self, offsets: Vec<FileOffset>) {
        let mut g = self.inner.lock().expect("plans lock");
        g.rounds.clear();
        for o in offsets {
            let p = o.path.replace('\\', "/");
            let parts: Vec<&str> = p.split('/').collect();
            if parts.len() >= 4 && parts[1] == "_build" {
                let session = format!("{}/{}", parts[0], parts[2]);
                let round_state = g.rounds.entry(session).or_default();
                round_state.log = LogProgress {
                    offset: o.offset,
                    size: o.size,
                    ..LogProgress::default()
                };
            }
        }
        if !g.committed_rounds.is_empty() || g.committed_gen > 0 {
            g.rounds = g.committed_rounds.clone();
            g.gen = g.committed_gen;
        } else {
            g.gen = 0;
        }
        g.restored = true;
        g.baseline = false;
        g.next_session = None;
        g.walk = Walk::default();
        g.epoch = 0;
        g.live_sweeps = 0;
    }

    fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
        let mut g = self.inner.lock().expect("plans lock");
        g.rounds.clear();
        g.retired.clear();
        g.fresh.clear();
        // The restored checkpoint is what is already committed: these rows are acked, nothing is pending.
        g.acked_files = checkpoint
            .files
            .iter()
            .map(|f| (f.path.clone(), f.clone()))
            .collect();
        g.acked_revs = checkpoint.revisions.clone();
        g.delta = DeltaQueue::default();
        g.error_rounds = 0;
        let mut tokens: BTreeMap<String, RoundToken> = BTreeMap::new();
        for f in checkpoint.files {
            let p = f.path.replace('\\', "/");
            let parts: Vec<&str> = p.split('/').collect();
            if parts.len() < 4 || parts[1] != "_build" {
                continue;
            }
            let session = format!("{}/{}", parts[0], parts[2]);
            let round_state = g.rounds.entry(session.clone()).or_default();
            if parts.len() >= 5 && parts[3] == "workers" {
                let (done, report) = decode_worker_flags(&f.fingerprint)
                    .unwrap_or((f.offset > 0 || f.size > 0, false));
                if done {
                    round_state.done_known = round_state.done_known.saturating_add(1);
                }
                round_state.workers.insert(
                    parts[4].to_string(),
                    WorkerState {
                        done,
                        report,
                        mtime: ms_to_time(f.mtime_ms),
                        size: f.size,
                        generation: f.generation,
                        announced: f.announced,
                        seen_sweep: 0,
                    },
                );
            } else {
                let token = f.revision.as_deref().and_then(decode_round_token);
                round_state.log = LogProgress {
                    offset: f.offset,
                    size: f.size,
                    lines: token.as_ref().map(|t| t.lines).unwrap_or(0),
                    mtime: ms_to_time(f.mtime_ms),
                    generation: f.generation,
                    fingerprint: f.fingerprint,
                    pass: None,
                };
                round_state.generation = token.as_ref().map(|t| t.generation).unwrap_or(0);
                round_state.seen = f.announced;
                if let Some(token) = token {
                    tokens.insert(session, token);
                }
            }
        }
        for (name, raw) in checkpoint.revisions {
            // Retired-round high-water: a durable counter for a round that is not present, kept out of
            // active round/path state. It survives any restart while the round is absent, so the
            // reappearance continues above every identity this store already committed.
            if let Some(session) = name.strip_prefix(RETIRED_REVISION_PREFIX) {
                if let Some(entry) = decode_retired(&raw) {
                    let slot = g.retired.entry(session.to_string()).or_default();
                    slot.generation = slot.generation.max(entry.generation);
                    slot.run_rev = slot.run_rev.max(entry.run_rev);
                    slot.child_rev = slot.child_rev.max(entry.child_rev);
                }
                continue;
            }
            if let Some(token) = decode_round_token(&raw) {
                tokens.entry(name).or_insert(token);
            }
        }
        let mut epoch = 0u64;
        for (session, token) in tokens {
            let Some(round_state) = g.rounds.get_mut(&session) else {
                continue;
            };
            if round_state.log.lines == 0 && round_state.log.offset == 0 {
                round_state.log.lines = token.lines;
            }
            if round_state.generation == 0 {
                round_state.generation = token.generation;
            }
            round_state.sweeps_done = token.sweeps_done;
            round_state.run_rev = token.run_rev;
            round_state.child_rev = token.child_rev;
            epoch = epoch.saturating_add(token.sweeps_done);
            // A restart cannot resume an OS directory iterator, so the interrupted sweep is replaced by
            // a fresh window that re-enumerates and re-observes the whole population in bounded turns.
            // That is what makes a change made below the old cursor while the process was down visible,
            // and it never re-delivers an unchanged observation (the durable flags say it was announced).
            round_state.sweep = Sweep {
                id: token.sweep.saturating_add(1),
                active: true,
                enum_done: false,
                error: false,
                unvisited: BTreeSet::new(),
                cursor: None,
                reconcile: None,
                reconciling: false,
                observed: 0,
                done_observed: 0,
                emitted_partial: token.emitted_partial,
                counted: false,
                idle_pages: 0,
                enumerated_known: 0,
                new_found: 0,
            };
            round_state.sweep_live = true;
            round_state.enum_dir = None;
            round_state.last_page = 0;
        }
        // Rounds without a durable token (e.g. a v1 checkpoint) still resume: the default sweep is
        // startable and its first service opens a fresh census window.
        g.error_rounds = g.rounds.values().filter(|r| r.sweep.error).count() as u64;
        g.epoch = epoch;
        g.live_sweeps = g.rounds.values().filter(|r| r.sweep_live).count() as u64;
        g.restored = true;
        g.baseline = false;
        g.next_session = None;
        g.walk = Walk::default();
        g.identities.clear();
        g.detect = DetectWalk::default();
    }

    fn supports_checkpoint_delta(&self) -> bool {
        true
    }

    /// Bounded delta since the last take: changed rows, changed revisions and proven removal candidates.
    fn checkpoint_delta(&self) -> CheckpointDelta {
        let mut g = self.inner.lock().expect("plans lock");
        take_delta(&mut g)
    }

    /// The whole state, **not drained**. A `SourceCheckpoint` cannot carry removal candidates, so a draining
    /// `checkpoint()` would silently drop tombstones; the poller commits [`Source::checkpoint_delta`] instead.
    fn checkpoint(&self) -> SourceCheckpoint {
        self.full_checkpoint()
    }

    fn full_checkpoint(&self) -> SourceCheckpoint {
        let g = self.inner.lock().expect("plans lock");
        let mut files = Vec::new();
        let mut revisions = BTreeMap::new();
        for (session, state) in &g.rounds {
            let Some((plan, round)) = session.split_once('/') else {
                continue;
            };
            files.push(log_row(plan, round, session, state));
            revisions.insert(session.clone(), encode_round_token(state));
            for (worker, w) in &state.workers {
                files.push(worker_row(plan, round, session, worker, w));
            }
        }
        // Retired rounds are not paths: they live only in the source revision map, so an absent round
        // keeps its Run/Child high-water without any file/offset/tombstone row being retained for it.
        for (session, retired) in &g.retired {
            revisions.insert(
                format!("{RETIRED_REVISION_PREFIX}{session}"),
                encode_retired(retired),
            );
        }
        SourceCheckpoint { files, revisions }
    }

    fn discovery_complete(&self) -> bool {
        let g = self.inner.lock().expect("plans lock");
        traversal_certifies(&g)
    }

    fn discovery_epoch(&self) -> Option<u64> {
        Some(self.inner.lock().expect("plans lock").epoch)
    }

    fn retains_unseen_paths(&self) -> bool {
        // A known worker/round is dropped only by the bounded removal pass after a complete,
        // error-free sweep, so an incomplete checkpoint never omits a still-existing path.
        true
    }
}

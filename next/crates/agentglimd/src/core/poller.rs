//! Poll loop (sources -> store -> bus), runtime probes and the status cache.

use super::bus::Bus;
use super::{
    now_ms, Cursor, Detection, Env, FileCheckpoint, RemovedPath, Runtime, RuntimeState, Source,
    SourceCheckpoint, TurnBudget,
};
use crate::store::Store;
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{interval, MissedTickBehavior};

/// Tail interval for sources.
pub const POLL_EVERY: Duration = Duration::from_secs(2);
/// Discovery/detect interval for sources and probe interval for runtimes.
pub const DISCOVER_EVERY: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatus {
    pub id: String,
    pub kind: String,
    pub detected: bool,
    pub reason: Option<String>,
    pub paths: Vec<String>,
    pub sessions: u64,
}

#[derive(Default)]
struct Inner {
    sources: Vec<SourceStatus>,
    runtimes: Vec<(String, RuntimeState)>,
    updated_ms: u64,
}

#[derive(Default)]
pub struct StatusCache {
    inner: RwLock<Inner>,
}

impl StatusCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn sources(&self) -> Vec<SourceStatus> {
        self.inner.read().expect("status lock").sources.clone()
    }
    pub fn runtimes(&self) -> Vec<(String, RuntimeState)> {
        self.inner.read().expect("status lock").runtimes.clone()
    }
    pub fn set_sources(&self, v: Vec<SourceStatus>) {
        let mut i = self.inner.write().expect("status lock");
        i.sources = v;
        i.updated_ms = now_ms();
    }
    pub fn set_runtimes(&self, v: Vec<(String, RuntimeState)>) {
        let mut i = self.inner.write().expect("status lock");
        i.runtimes = v;
        i.updated_ms = now_ms();
    }
    /// 0 = never refreshed.
    pub fn updated_ms(&self) -> u64 {
        self.inner.read().expect("status lock").updated_ms
    }
}

/// Poll intervals; overridable by env `AG_POLL_MS` / `AG_DISCOVER_MS` (tests).
#[derive(Debug, Clone, Copy)]
pub struct Intervals {
    pub poll: Duration,
    pub discover: Duration,
}

impl Intervals {
    pub fn from_env() -> Self {
        let get = |k: &str, d: Duration| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v > 0)
                .map(Duration::from_millis)
                .unwrap_or(d)
        };
        Self {
            poll: get("AG_POLL_MS", POLL_EVERY),
            discover: get("AG_DISCOVER_MS", DISCOVER_EVERY),
        }
    }
}

pub struct PollerDeps {
    pub store: Store,
    pub bus: Arc<Bus>,
    pub sources: Arc<Vec<Arc<dyn Source>>>,
    pub runtimes: Arc<Vec<Arc<dyn Runtime>>>,
    pub status: Arc<StatusCache>,
    pub env: Env,
    pub intervals: Intervals,
    /// Bumped by the `status-refresh` task; each bump triggers one immediate pass.
    pub refresh: watch::Receiver<u64>,
}

/// Runs `on_fast` every `fast` and `on_slow` every `slow` (both skip missed ticks, so a long suspend yields one
/// run, not a burst), plus both on every `refresh` bump. First pass runs at once. Stops on `shutdown` and
/// **cancels an in-flight pass**: a poll that hangs or is still reading loses its future on shutdown, so the
/// source loop can always exit (its turn guard still runs `Source::end_turn`).
async fn until_shutdown<F>(shutdown: &mut watch::Receiver<bool>, fut: F) -> bool
where
    F: Future<Output = ()>,
{
    tokio::select! {
        biased;
        _ = async { let _ = shutdown.wait_for(|v| *v).await; } => false,
        _ = fut => true,
    }
}

pub async fn run_loop<F1, Fut1, F2, Fut2>(
    fast: Duration,
    slow: Duration,
    mut refresh: watch::Receiver<u64>,
    mut shutdown: watch::Receiver<bool>,
    mut on_fast: F1,
    mut on_slow: F2,
) where
    F1: FnMut() -> Fut1 + Send,
    Fut1: Future<Output = ()> + Send,
    F2: FnMut() -> Fut2 + Send,
    Fut2: Future<Output = ()> + Send,
{
    let mut f = interval(fast);
    f.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut s = interval(slow);
    s.set_missed_tick_behavior(MissedTickBehavior::Skip);
    refresh.mark_unchanged();
    // The select's shutdown future owns this clone, so the pass bodies can still borrow `shutdown`.
    let mut sd = shutdown.clone();
    loop {
        tokio::select! {
            biased;
            _ = async { let _ = sd.wait_for(|v| *v).await; } => return,
            _ = s.tick() => {
                if !until_shutdown(&mut shutdown, on_slow()).await { return; }
                if !until_shutdown(&mut shutdown, on_fast()).await { return; }
                f.reset();
            }
            _ = f.tick() => {
                if !until_shutdown(&mut shutdown, on_fast()).await { return; }
            }
            r = refresh.changed() => {
                if r.is_err() { return; }
                if !until_shutdown(&mut shutdown, on_slow()).await { return; }
                if !until_shutdown(&mut shutdown, on_fast()).await { return; }
            }
        }
    }
}

/// One polled but not yet committed batch. Kept verbatim across a failed commit so the retry is the exact same
/// input, including producer identities, checkpoint and tombstones.
struct PendingBatch {
    batch: super::Batch,
    checkpoint: SourceCheckpoint,
    identities: Vec<super::RecordKey>,
    removed: Vec<RemovedPath>,
    reappeared: Vec<String>,
}

/// One polled but not yet committed delta batch (delta-capable sources). The delta — including its
/// removal candidates — is kept verbatim until the commit succeeds, so a failed commit, a restart
/// boundary inside one process, or an incomplete later sweep can never drop a path without its
/// tombstone: the prior committed file state stays durable until this commits.
struct PendingDelta {
    batch: super::Batch,
    delta: super::CheckpointDelta,
    identities: Vec<super::RecordKey>,
    reappeared: Vec<String>,
}

struct SourceState {
    src: Arc<dyn Source>,
    detected: bool,
    first: bool,
    cursor: u64,
    saved_checkpoint: SourceCheckpoint,
    /// Paths this source removed and that have not reappeared yet (mirrors `source_removed`).
    tombstones: BTreeMap<String, RemovedPath>,
    pending: Option<PendingBatch>,
    /// Delta-capable sources only: the uncommitted delta batch (mutually exclusive with `pending`).
    pending_delta: Option<PendingDelta>,
    /// Delta-capable sources only: committed file states by path (the durable checkpoint, indexed).
    /// Delta application is O(delta log N); the whole map is never copied or compared per turn.
    saved_map: BTreeMap<String, FileCheckpoint>,
    /// Bounded checkpoint reconciliation round for the pending batch, continued across turns.
    diff: Option<PathDiff>,
    /// Discovery epoch of the last completed checkpoint diff (`None` = no diff has run yet in this process).
    last_epoch: Option<u64>,
    /// The one allowance of the current turn, also charged for core-side bookkeeping.
    budget: Option<Arc<TurnBudget>>,
    status: SourceStatus,
}

/// Whole durable checkpoint for one source: file parser state, source revisions and legacy offset-only rows.
/// File state wins over offsets because it is the richer record of the same cursors.
fn load_checkpoint(store: &Store, source: &str) -> SourceCheckpoint {
    let offsets = store.load_offsets(source).unwrap_or_else(|e| {
        tracing::warn!(source, error = %e, "load offsets failed");
        Vec::new()
    });
    let file_states = store.load_file_state(source).unwrap_or_else(|e| {
        tracing::warn!(source, error = %e, "load file state failed");
        Vec::new()
    });
    let revisions = store.load_revisions(source).unwrap_or_else(|e| {
        tracing::warn!(source, error = %e, "load source revisions failed");
        BTreeMap::new()
    });
    let files = if !file_states.is_empty() {
        file_states
            .iter()
            .map(|st| FileCheckpoint {
                path: st.path.clone(),
                generation: st.generation,
                offset: st.offset,
                size: st.size,
                mtime_ms: st.mtime_ms,
                fingerprint: st.fingerprint.clone(),
                session: st.session.clone(),
                model: st.model.clone(),
                announced: st.announced,
                discarded_bytes: st.discarded_bytes,
                incomplete: st.incomplete,
                revision: st.revision.clone(),
            })
            .collect()
    } else {
        offsets
            .iter()
            .map(|o| FileCheckpoint {
                path: o.path.clone(),
                offset: o.offset,
                size: o.size,
                ..Default::default()
            })
            .collect()
    };
    SourceCheckpoint { files, revisions }
}

/// How a bounded reconciliation round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiffStep {
    /// The whole round was decided (every saved path and every new checkpoint path was compared once).
    Complete,
    /// The round stopped because the turn's shared visit allowance was spent; it resumes next turn.
    Incomplete,
    /// A checkpoint list violated the ordered-files contract. Nothing is certified absent and the round is
    /// dropped (parser state kept, no tombstone) instead of guessing membership with an unbounded index.
    Aborted(&'static str),
}

/// One bounding checkpoint reconciliation round: which saved paths the new checkpoint no longer reports
/// (tombstones) and which tombstoned paths came back.
///
/// The round is a single ordered merge walk over the previous checkpoint's file list (moved, not copied, out of
/// `saved_checkpoint`) and the new checkpoint's file list, with the tombstone map consulted per new path. Setup
/// is O(1): no path set, no tombstone snapshot vector, no sorted copy. One charged work visit pays for each
/// candidate inspection *before* it happens, so the round advances by at most the turn's remaining visits and
/// resumes next turn. Every iteration consumes one saved path or one new-checkpoint path, so a whole round costs
/// at most `saved + next` charged visits; both lists are order-verified as they are walked, because without a
/// complete ordered walk there is no proof that a path is gone — a violation aborts the round instead of
/// tombstoning.
///
/// Resident state (`saved_checkpoint`, `tombstones`, the moved `saved` list) still grows with the discovered
/// sources; what this replaces is the per-round fresh O(known paths + tombstones) index/vector that used to run
/// before any cap was checked.
struct PathDiff {
    /// The previous checkpoint's file list, moved out of `saved_checkpoint` (an O(1) move, never a copy).
    saved: Vec<super::FileCheckpoint>,
    /// Next saved path to compare.
    si: usize,
    /// Next new-checkpoint path to compare.
    ni: usize,
    /// Saved paths the new checkpoint does not report, in saved (path) order.
    missing: Vec<super::FileCheckpoint>,
    /// Tombstoned paths the new checkpoint reports again, in checkpoint (path) order.
    reappeared: Vec<String>,
    /// Discovery is still incomplete: keep the unseen saved paths instead of tombstoning them.
    merge_only: bool,
    /// Set when a checkpoint list broke the ordered-files contract.
    abort: Option<&'static str>,
}

impl PathDiff {
    fn new(saved: Vec<super::FileCheckpoint>, merge_only: bool) -> Self {
        Self {
            saved,
            si: 0,
            ni: 0,
            missing: Vec::new(),
            reappeared: Vec::new(),
            merge_only,
            abort: None,
        }
    }

    /// `true` when the list is still strictly increasing at `i` (O(1) contract check; duplicates fail it).
    fn ordered(next: &[super::FileCheckpoint], i: usize) -> bool {
        i == 0 || next[i - 1].path < next[i].path
    }

    /// Advances the round by at most the turn's remaining shared visits; resumable and order-verifying.
    fn step(
        &mut self,
        budget: &TurnBudget,
        next: &[super::FileCheckpoint],
        tombstones: &BTreeMap<String, RemovedPath>,
    ) -> DiffStep {
        if let Some(why) = self.abort {
            return DiffStep::Aborted(why);
        }
        while self.si < self.saved.len() || self.ni < next.len() {
            // Charge before inspecting the next candidate; a spent allowance stops here and keeps the cursors.
            if !budget.try_visit() {
                return DiffStep::Incomplete;
            }
            if self.si > 0
                && self.si < self.saved.len()
                && self.saved[self.si - 1].path >= self.saved[self.si].path
            {
                self.abort = Some("previous checkpoint file list is not ordered by path");
                return DiffStep::Aborted(self.abort.unwrap());
            }
            match next.get(self.ni) {
                Some(n) => {
                    if !Self::ordered(next, self.ni) {
                        self.abort = Some("new checkpoint file list is not ordered by path");
                        return DiffStep::Aborted(self.abort.unwrap());
                    }
                    // Reappearance is decided from the same pass: a tombstoned path that the new checkpoint
                    // reports again. Checked exactly once, where this new path is consumed (O(log tombstones)).
                    let returns = !tombstones.is_empty() && tombstones.contains_key(&n.path);
                    match self.saved.get(self.si) {
                        Some(s) => match n.path.cmp(&s.path) {
                            // A path the new checkpoint added: nothing to remove or clear.
                            std::cmp::Ordering::Less => {
                                if returns {
                                    self.reappeared.push(n.path.clone());
                                }
                                self.ni += 1;
                            }
                            std::cmp::Ordering::Equal => {
                                self.si += 1;
                                self.ni += 1;
                            }
                            // The saved path is gone; the new path stays the current candidate.
                            std::cmp::Ordering::Greater => {
                                self.missing.push(s.clone());
                                self.si += 1;
                            }
                        },
                        None => {
                            if returns {
                                self.reappeared.push(n.path.clone());
                            }
                            self.ni += 1;
                        }
                    }
                }
                // The new checkpoint has no further paths: the rest of the saved list is absent.
                None => {
                    self.missing.push(self.saved[self.si].clone());
                    self.si += 1;
                }
            }
        }
        DiffStep::Complete
    }

    /// Applies the finished round to `checkpoint`: tombstones, or (partial/aborted round) keep unseen parser
    /// state instead of certifying absence.
    ///
    /// The keep-state merge is O(known files) and runs once per finished round, only for adapters whose
    /// checkpoint does not already retain unseen paths (`Source::retains_unseen_paths() == false`) or for the
    /// defensive abort path; all six production adapters retain their own unseen paths, so the charged merge
    /// walk above is their whole reconciliation cost.
    fn finish(
        self,
        checkpoint: &mut SourceCheckpoint,
        now: u64,
    ) -> (Vec<RemovedPath>, Vec<String>) {
        if let Some(why) = self.abort {
            tracing::warn!(
                reason = why,
                "checkpoint reconciliation aborted: keeping parser state, publishing no removal"
            );
            let known: std::collections::BTreeSet<String> =
                checkpoint.files.iter().map(|f| f.path.clone()).collect();
            for f in self.saved {
                if !known.contains(&f.path) {
                    checkpoint.files.push(f);
                }
            }
            checkpoint.files.sort_by(|a, b| a.path.cmp(&b.path));
            checkpoint.files.dedup_by(|a, b| a.path == b.path);
            return (Vec::new(), Vec::new());
        }
        if self.merge_only {
            // An incomplete sweep may only add back the parser state it could not see; never tombstone.
            checkpoint.files.extend(self.missing);
            checkpoint.files.sort_by(|a, b| a.path.cmp(&b.path));
            return (Vec::new(), Vec::new());
        }
        let removed = self
            .missing
            .into_iter()
            .map(|f| RemovedPath {
                path: f.path,
                generation: f.generation,
                removed_ms: now,
            })
            .collect();
        (removed, self.reappeared)
    }
}

struct SourceLoop {
    st: Vec<SourceState>,
    env: Env,
    store: Store,
    bus: Arc<Bus>,
    cache: Arc<StatusCache>,
    /// Set by the discovery tick; consumed by the next [`SourceLoop::turn`], which runs detection and polling
    /// of every source against ONE shared allowance per source.
    discovery_due: bool,
}

/// Ends a source turn even when the poll future is cancelled (shutdown) or an error path returns early, so an
/// adapter always sees exactly one `begin_turn`/`end_turn` pair and never a half-open turn.
struct TurnGuard {
    src: Arc<dyn Source>,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.src.end_turn();
    }
}

impl SourceLoop {
    fn new(d: &PollerDeps) -> Self {
        let st = d
            .sources
            .iter()
            .map(|src| {
                let saved_checkpoint = load_checkpoint(&d.store, src.id());
                if !saved_checkpoint.files.is_empty() || !saved_checkpoint.revisions.is_empty() {
                    src.restore_checkpoint(saved_checkpoint.clone());
                }
                let removed_rows = d.store.load_removed(src.id()).unwrap_or_else(|e| {
                    tracing::warn!(source = src.id(), error = %e, "load tombstones failed");
                    Vec::new()
                });
                let tombstones: BTreeMap<String, RemovedPath> = removed_rows
                    .iter()
                    .map(|r| (r.path.clone(), r.clone()))
                    .collect();
                if !removed_rows.is_empty() {
                    // Lets an adapter keep a reappearing path's generation distinct from the removed one.
                    src.restore_removed(&removed_rows);
                }
                let saved_map: BTreeMap<String, FileCheckpoint> = if src.supports_checkpoint_delta()
                {
                    saved_checkpoint
                        .files
                        .iter()
                        .map(|f| (f.path.clone(), f.clone()))
                        .collect()
                } else {
                    BTreeMap::new()
                };
                SourceState {
                    src: src.clone(),
                    detected: false,
                    first: true,
                    cursor: 0,
                    saved_checkpoint,
                    tombstones,
                    pending: None,
                    pending_delta: None,
                    saved_map,
                    diff: None,
                    last_epoch: None,
                    budget: None,
                    status: SourceStatus {
                        id: src.id().to_string(),
                        kind: kind_name(src.as_ref()),
                        detected: false,
                        reason: None,
                        paths: Vec::new(),
                        sessions: 0,
                    },
                }
            })
            .collect();
        Self {
            st,
            env: d.env.clone(),
            store: d.store.clone(),
            bus: d.bus.clone(),
            cache: d.status.clone(),
            discovery_due: true,
        }
    }

    /// The discovery tick: mark that the next turn must run `detect` before `poll` for every source. Detection
    /// is not a separate pass, so one turn's detection and polling share one [`TurnBudget`] per source.
    fn mark_discovery_due(&mut self) {
        self.discovery_due = true;
    }

    /// One scheduled source-service turn: per source, `detect` (when due) and `poll` draw from one allowance.
    async fn turn(&mut self) {
        let discover = std::mem::take(&mut self.discovery_due);
        let Self {
            st,
            env,
            store,
            bus,
            ..
        } = self;
        let mut changed = false;
        for s in st.iter_mut() {
            let allowance = TurnBudget::default_allowance();
            // Created before `begin_turn` so the guard is in place for every early return and for cancellation.
            let _turn = TurnGuard { src: s.src.clone() };
            s.budget = Some(allowance.clone());
            s.src.begin_turn(allowance.clone());
            if discover {
                detect_source(s, store, env);
            }
            if poll_source(s, store, bus).await {
                changed = true;
            }
            s.budget = None;
            let usage = allowance.usage();
            tracing::debug!(
                source = s.src.id(),
                discover,
                bytes = usage.bytes.used,
                byte_limit = usage.bytes.limit,
                entries = usage.entries.used,
                entry_limit = usage.entries.limit,
                visits = usage.visits.used,
                visit_limit = usage.visits.limit,
                "source turn finished"
            );
        }
        if changed || discover {
            // A detection pass always refreshes the cached status (detected flag, reason, paths, sessions), even
            // when it commits nothing.
            self.publish_status();
        }
    }

    fn publish_status(&self) {
        self.cache
            .set_sources(self.st.iter().map(|s| s.status.clone()).collect());
    }
}

/// Runs `detect` for one source and records the honest result. A not-detected or failed detection is never
/// treated as a completed discovery sweep: the poll (and therefore any tombstone reconciliation) is skipped.
fn detect_source(s: &mut SourceState, store: &Store, env: &Env) {
    match s.src.detect(env) {
        Detection::Detected { paths } => {
            s.detected = true;
            s.status.detected = true;
            s.status.reason = None;
            s.status.paths = paths.iter().map(|p| p.display().to_string()).collect();
        }
        Detection::NotDetected { reason } => {
            s.detected = false;
            s.status.detected = false;
            s.status.reason = Some(reason);
            s.status.paths.clear();
        }
    }
    s.status.sessions = store.session_count(s.src.id()).unwrap_or(0);
}

/// Polls one detected source into the store; returns whether events were committed.
async fn poll_source(s: &mut SourceState, store: &Store, bus: &Bus) -> bool {
    if !s.detected {
        return false;
    }
    if s.src.supports_checkpoint_delta() {
        return poll_source_delta(s, store, bus).await;
    }
    let mut changed = false;
    let empty_budget = TurnBudget::default_allowance();
    let budget = s.budget.clone().unwrap_or(empty_budget);
    // Create the pending batch only when there is no uncommitted one: a failed commit keeps the
    // exact same items/identities/checkpoint for retry instead of re-polling an advanced source.
    if s.pending.is_none() {
        let since = if s.first && s.saved_checkpoint.files.is_empty() {
            0
        } else {
            s.cursor.max(1)
        };
        s.first = false;
        let batch = match s.src.poll(Cursor(since)).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(source = s.src.id(), error = %e, "poll failed");
                tokio::task::yield_now().await;
                return false;
            }
        };
        // Taken right after the poll: `identities` describes exactly this batch's items.
        let identities = s.src.identities();
        let checkpoint = s.src.checkpoint();
        let complete = s.src.discovery_complete();
        let epoch = s.src.discovery_epoch();
        // A removal/reappearance diff can only differ after a completed sweep (the only event that may drop a
        // path). Adapters that do not report an epoch keep the historical diff-on-every-commit behaviour.
        let epoch_changed = match epoch {
            Some(e) => s.last_epoch != Some(e),
            None => true,
        };
        let merge_only = !complete && !s.src.retains_unseen_paths();
        let need_diff = if complete { epoch_changed } else { merge_only };
        if !need_diff
            && batch.items.is_empty()
            && checkpoint == s.saved_checkpoint
            && s.tombstones.is_empty()
        {
            tokio::task::yield_now().await;
            return false;
        }
        if need_diff {
            // Move the previous file list into the round (O(1), no copy and no path index); the round itself is an
            // ordered merge walk charged against this turn's shared visits.
            let saved = std::mem::take(&mut s.saved_checkpoint.files);
            s.diff = Some(PathDiff::new(saved, merge_only));
            if complete {
                s.last_epoch = epoch;
            }
        } else if batch.items.is_empty() && checkpoint == s.saved_checkpoint {
            tokio::task::yield_now().await;
            return false;
        }
        s.pending = Some(PendingBatch {
            batch,
            checkpoint,
            identities,
            removed: Vec::new(),
            reappeared: Vec::new(),
        });
    }

    // Finish the bounded reconciliation round: at most the turn's remaining visits per turn, resuming next turn.
    if let Some(mut diff) = s.diff.take() {
        let outcome = match s.pending.as_ref() {
            Some(p) => diff.step(&budget, &p.checkpoint.files, &s.tombstones),
            None => DiffStep::Aborted("reconciliation round without a pending batch"),
        };
        match outcome {
            DiffStep::Incomplete => {
                s.diff = Some(diff);
                tokio::task::yield_now().await;
                return false;
            }
            DiffStep::Aborted(why) => {
                // Not a removal proof: keep the parser state and publish no tombstone. `last_epoch` stays where
                // the completed sweep put it, so a broken list is not re-walked every turn.
                tracing::warn!(
                    source = s.src.id(),
                    reason = why,
                    "dropping checkpoint diff"
                );
                if let Some(p) = s.pending.as_mut() {
                    let _ = diff.finish(&mut p.checkpoint, now_ms());
                }
            }
            DiffStep::Complete => {
                let now = now_ms();
                if let Some(p) = s.pending.as_mut() {
                    let (removed, reappeared) = diff.finish(&mut p.checkpoint, now);
                    p.removed = removed;
                    p.reappeared = reappeared;
                }
            }
        }
    }

    let p = match &s.pending {
        Some(p) => p,
        None => {
            tokio::task::yield_now().await;
            return false;
        }
    };
    let items = p.batch.items.clone();
    let next = p.batch.next.0;
    let checkpoint = p.checkpoint.clone();
    let identities = p.identities.clone();
    let removed = p.removed.clone();
    let reappeared = p.reappeared.clone();
    match bus.commit(
        s.src.id(),
        &items,
        &checkpoint,
        &removed,
        &reappeared,
        &identities,
    ) {
        Ok(evs) => {
            s.cursor = next;
            s.saved_checkpoint = checkpoint;
            for r in &removed {
                s.tombstones.insert(r.path.clone(), r.clone());
            }
            for path in &reappeared {
                s.tombstones.remove(path);
            }
            s.pending = None;
            if evs.is_empty() {
                tracing::debug!(
                    source = s.src.id(),
                    removed = removed.len(),
                    "committed checkpoint-only progress"
                );
            }
            if !evs.is_empty() {
                s.status.sessions = store.session_count(s.src.id()).unwrap_or(0);
                changed = true;
            }
        }
        Err(e) => {
            tracing::error!(
                source = s.src.id(),
                items = items.len(),
                error = %e,
                "append batch failed; no input consumed (pending kept for exact retry)"
            );
            // Keep pending for exact retry; source state stays aligned with the pending batch.
        }
    }
    tokio::task::yield_now().await;
    changed
}

/// Delta path for delta-capable sources: poll once, take the bounded delta, and commit exactly
/// that delta (changed file states + revisions + removal candidates) in one transaction. The
/// pending delta is kept verbatim across a failed commit for exact retry; the committed state
/// (`saved_map`, tombstones, cursor) advances only after the commit succeeds, so a removal
/// candidate keeps its prior committed file state until its tombstone commits with it.
async fn poll_source_delta(s: &mut SourceState, store: &Store, bus: &Bus) -> bool {
    let mut changed = false;
    if s.pending_delta.is_none() {
        let since = if s.first && s.saved_map.is_empty() {
            0
        } else {
            s.cursor.max(1)
        };
        s.first = false;
        let batch = match s.src.poll(Cursor(since)).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(source = s.src.id(), error = %e, "poll failed");
                tokio::task::yield_now().await;
                return false;
            }
        };
        let identities = s.src.identities();
        let delta = s.src.checkpoint_delta();
        // Validate the delta ceiling before creating any pending state or doing commit work.
        if delta.check_bounds().is_err() {
            tracing::error!(
                source = s.src.id(),
                rows = delta.row_count(),
                "checkpoint delta exceeds the per-commit ceiling; refusing the turn"
            );
            tokio::task::yield_now().await;
            return false;
        }
        // Reappearance is decided from the delta itself: a tombstoned path the delta upserts again
        // gets its tombstone cleared in the same transaction (O(delta log tombstones)).
        let reappeared: Vec<String> = if s.tombstones.is_empty() {
            Vec::new()
        } else {
            delta
                .upserts
                .iter()
                .filter(|f| s.tombstones.contains_key(&f.path))
                .map(|f| f.path.clone())
                .collect()
        };
        if batch.items.is_empty() && delta.is_empty() && reappeared.is_empty() {
            tokio::task::yield_now().await;
            return false;
        }
        s.pending_delta = Some(PendingDelta {
            batch,
            delta,
            identities,
            reappeared,
        });
    }
    let p = match &s.pending_delta {
        Some(p) => p,
        None => {
            tokio::task::yield_now().await;
            return false;
        }
    };
    let items = p.batch.items.clone();
    let next = p.batch.next.0;
    let delta = p.delta.clone();
    let identities = p.identities.clone();
    let reappeared = p.reappeared.clone();
    match bus.commit_delta(s.src.id(), &items, &delta, &reappeared, &identities) {
        Ok(evs) => {
            s.cursor = next;
            for f in &delta.upserts {
                s.saved_map.insert(f.path.clone(), f.clone());
            }
            for r in &delta.removed {
                s.saved_map.remove(&r.path);
                s.tombstones.insert(r.path.clone(), r.clone());
            }
            for path in &reappeared {
                s.tombstones.remove(path);
            }
            s.pending_delta = None;
            if evs.is_empty() {
                tracing::debug!(
                    source = s.src.id(),
                    upserts = delta.upserts.len(),
                    removed = delta.removed.len(),
                    "committed checkpoint-delta progress"
                );
            }
            if !evs.is_empty() {
                s.status.sessions = store.session_count(s.src.id()).unwrap_or(0);
                changed = true;
            }
        }
        Err(e) => {
            tracing::error!(
                source = s.src.id(),
                items = items.len(),
                error = %e,
                "append batch failed (delta commit); no input consumed (pending delta kept for exact retry)"
            );
            // Keep the pending delta verbatim for exact retry; committed state stays put.
        }
    }
    tokio::task::yield_now().await;
    changed
}

fn kind_name(s: &dyn Source) -> String {
    serde_json::to_value(s.kind())
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Probes every runtime concurrently (one tokio task each, 5 s cap) and stores the results.
async fn probe_all(runtimes: &Arc<Vec<Arc<dyn Runtime>>>, cache: &StatusCache) {
    let handles: Vec<_> = runtimes
        .iter()
        .map(|r| {
            let r = r.clone();
            tokio::spawn(async move {
                let st = tokio::time::timeout(PROBE_TIMEOUT, r.probe())
                    .await
                    .unwrap_or(RuntimeState::Down);
                (r.id().to_string(), st)
            })
        })
        .collect();
    let mut out = Vec::new();
    for h in handles {
        if let Ok(x) = h.await {
            out.push(x);
        }
    }
    cache.set_runtimes(out);
}

/// Starts the source loop and the runtime loop. Both stop once `shutdown` turns true.
pub fn spawn_poller(deps: PollerDeps, shutdown: watch::Receiver<bool>) -> JoinHandle<()> {
    let iv = deps.intervals;
    let mut sl = SourceLoop::new(&deps);
    let (runtimes, cache) = (deps.runtimes.clone(), deps.status.clone());
    let (r2, sd2) = (deps.refresh.clone(), shutdown.clone());
    let rt = tokio::spawn(async move {
        run_loop(
            iv.discover,
            iv.discover,
            r2,
            sd2,
            || async {},
            || probe_all(&runtimes, &cache),
        )
        .await;
    });
    let src = tokio::spawn(async move {
        let cell = tokio::sync::Mutex::new(&mut sl);
        let cell = &cell;
        run_loop(
            iv.poll,
            iv.discover,
            deps.refresh,
            shutdown,
            || async { cell.lock().await.turn().await },
            || async { cell.lock().await.mark_discovery_due() },
        )
        .await;
    });
    tokio::spawn(async move {
        let _ = tokio::join!(rt, src);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test(start_paused = true)]
    async fn ten_minute_jump_runs_poll_once_not_hundreds() {
        let (_rt, rr) = watch::channel(0u64);
        let (sd, sr) = watch::channel(false);
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let h = tokio::spawn(run_loop(
            Duration::from_secs(2),
            Duration::from_secs(3600),
            rr,
            sr,
            move || {
                let n = n2.clone();
                async move {
                    n.fetch_add(1, Ordering::SeqCst);
                }
            },
            || async {},
        ));
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(n.load(Ordering::SeqCst), 1, "first pass runs at once");
        tokio::time::advance(Duration::from_secs(600)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            n.load(Ordering::SeqCst),
            2,
            "one run after the jump, not ~300"
        );
        sd.send(true).unwrap();
        h.await.unwrap();
    }

    // ------------------------------- bounded checkpoint reconciliation (v5-r3: no pre-cap set materialization)

    fn ck(path: &str, generation: u64) -> FileCheckpoint {
        FileCheckpoint {
            path: path.to_string(),
            generation,
            ..Default::default()
        }
    }

    fn tomb(path: &str) -> RemovedPath {
        RemovedPath {
            path: path.to_string(),
            generation: 1,
            removed_ms: 1,
        }
    }

    /// 450 saved paths, 300 tombstones and one surviving path: the round's setup builds no index and no tombstone
    /// vector, one charged visit pays for each candidate, and the whole round is `saved + next` visits (451 here)
    /// spread over turns of 200 — never a full reconciliation before the cap is checked.
    #[test]
    fn path_diff_walks_large_saved_and_tombstone_sets_under_the_visit_cap() {
        let saved: Vec<FileCheckpoint> = (0..450).map(|i| ck(&format!("p/{i:04}"), 1)).collect();
        let next = vec![ck("keep", 1)];
        let tombstones: BTreeMap<String, RemovedPath> = (0..300)
            .map(|i| {
                let p = format!("gone/{i:04}");
                (p.clone(), tomb(&p))
            })
            .collect();
        let mut diff = PathDiff::new(saved, false);
        // The setup really is O(1): cursors at zero, no collected candidate lists.
        assert_eq!((diff.si, diff.ni), (0, 0));
        assert!(diff.missing.is_empty() && diff.reappeared.is_empty());

        // One fresh allowance per simulated turn: the round has no budget of its own.
        let mut steps = Vec::new();
        loop {
            let turn = TurnBudget::bounded(4_194_304, 200, 200);
            match diff.step(&turn, &next, &tombstones) {
                DiffStep::Incomplete => {
                    assert_eq!(
                        turn.visits_used(),
                        200,
                        "a capped turn spends exactly the remaining visits"
                    );
                    steps.push(turn.visits_used());
                }
                DiffStep::Complete => {
                    steps.push(turn.visits_used());
                    break;
                }
                DiffStep::Aborted(why) => panic!("ordered checkpoints must not abort: {why}"),
            }
        }
        assert_eq!(
            steps,
            vec![200, 200, 51],
            "the round resumes where the last turn stopped"
        );
        assert_eq!(
            steps.iter().sum::<u64>(),
            (450 + 1) as u64,
            "one charged visit per consumed saved or new-checkpoint entry, nothing more"
        );

        let mut checkpoint = SourceCheckpoint {
            files: next.clone(),
            revisions: BTreeMap::new(),
        };
        let (removed, reappeared) = diff.finish(&mut checkpoint, 7);
        assert_eq!(
            removed.len(),
            450,
            "every unseen saved path is tombstoned once"
        );
        assert_eq!(removed[0].path, "p/0000");
        assert_eq!(removed[449].path, "p/0449");
        assert_eq!(removed[0].removed_ms, 7);
        assert!(reappeared.is_empty(), "none of the tombstones came back");
        assert_eq!(
            checkpoint.files, next,
            "the committed checkpoint is the new one"
        );
    }

    /// Reappearance is decided in the same ordered pass (no second scan of the new checkpoint): the tombstone
    /// map is consulted per new path, so 5 tombstones of which 2 return are cleared and the other 3 stay.
    #[test]
    fn path_diff_detects_reappearance_in_the_same_pass() {
        let saved = vec![ck("a/old", 1)];
        let next = vec![ck("a/new", 1), ck("g/1", 3), ck("g/3", 3), ck("z/9", 1)];
        let tombstones: BTreeMap<String, RemovedPath> = ["g/1", "g/2", "g/3", "g/4", "g/5"]
            .iter()
            .map(|p| (p.to_string(), tomb(p)))
            .collect();
        let budget = TurnBudget::bounded(4_194_304, 200, 200);
        let mut diff = PathDiff::new(saved, false);
        assert_eq!(diff.step(&budget, &next, &tombstones), DiffStep::Complete);
        assert_eq!(
            budget.visits_used(),
            5,
            "4 new-checkpoint paths + 1 saved path, exactly once each"
        );
        let mut checkpoint = SourceCheckpoint {
            files: next.clone(),
            revisions: BTreeMap::new(),
        };
        let (removed, reappeared) = diff.finish(&mut checkpoint, 9);
        assert_eq!(removed.len(), 1, "only the saved path that is gone");
        assert_eq!(removed[0].path, "a/old");
        assert_eq!(reappeared, vec!["g/1".to_string(), "g/3".to_string()]);
    }

    /// A new-checkpoint list that violates the ordered-files contract cannot prove anything absent: the round
    /// aborts, publishes no tombstone and keeps every saved parser state instead of guessing membership.
    #[test]
    fn path_diff_aborts_unsorted_checkpoint_without_removal() {
        let saved = vec![ck("p/a", 1), ck("p/b", 1), ck("p/c", 1)];
        // "p/c" < "p/b": the second entry breaks the order, and "p/a" is really still present.
        let next = vec![ck("p/a", 1), ck("p/c", 1), ck("p/b", 1)];
        let budget = TurnBudget::bounded(4_194_304, 200, 200);
        let mut diff = PathDiff::new(saved.clone(), false);
        assert_eq!(
            diff.step(&budget, &next, &BTreeMap::new()),
            DiffStep::Aborted("new checkpoint file list is not ordered by path")
        );
        let mut checkpoint = SourceCheckpoint {
            files: next.clone(),
            revisions: BTreeMap::new(),
        };
        let (removed, reappeared) = diff.finish(&mut checkpoint, 11);
        assert!(
            removed.is_empty(),
            "no absence is certified from an unordered list"
        );
        assert!(reappeared.is_empty());
        assert_eq!(
            checkpoint.files.len(),
            3,
            "every saved path and every new path is kept exactly once"
        );
        assert_eq!(
            checkpoint.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
            vec!["p/a", "p/b", "p/c"],
            "the kept checkpoint stays ordered for the next round"
        );
    }

    /// An incomplete sweep only adds the unseen parser state back (no tombstone), and leaves the checkpoint
    /// ordered so the next round's merge walk stays valid.
    #[test]
    fn path_diff_incomplete_sweep_keeps_state_ordered() {
        let saved = vec![ck("p/a", 1), ck("p/c", 1), ck("p/e", 1)];
        let next = vec![ck("p/b", 1), ck("p/d", 1)];
        let budget = TurnBudget::bounded(4_194_304, 200, 200);
        let mut diff = PathDiff::new(saved, true);
        assert_eq!(
            diff.step(&budget, &next, &BTreeMap::new()),
            DiffStep::Complete
        );
        let mut checkpoint = SourceCheckpoint {
            files: next.clone(),
            revisions: BTreeMap::new(),
        };
        let (removed, reappeared) = diff.finish(&mut checkpoint, 13);
        assert!(removed.is_empty(), "an incomplete sweep never tombstones");
        assert!(reappeared.is_empty());
        assert_eq!(
            checkpoint.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
            vec!["p/a", "p/b", "p/c", "p/d", "p/e"],
            "unseen parser state is merged back in path order"
        );
    }

    /// With the shared visits already spent the round does nothing at all: no inspection, no removal, and the
    /// cursors stay put so the next turn continues from the same candidate.
    #[test]
    fn path_diff_makes_no_progress_without_visits() {
        let saved: Vec<FileCheckpoint> = (0..10).map(|i| ck(&format!("p/{i:02}"), 1)).collect();
        let next = vec![ck("keep", 1)];
        let tombstones: BTreeMap<String, RemovedPath> = ["gone/0", "gone/1"]
            .iter()
            .map(|p| (p.to_string(), tomb(p)))
            .collect();
        let budget = TurnBudget::bounded(4_194_304, 200, 200);
        assert_eq!(budget.charge_visits(200), 200, "the adapter spent the turn");
        let mut diff = PathDiff::new(saved, false);
        assert_eq!(diff.step(&budget, &next, &tombstones), DiffStep::Incomplete);
        assert_eq!((diff.si, diff.ni), (0, 0));
        assert!(diff.missing.is_empty() && diff.reappeared.is_empty());
        assert_eq!(
            budget.visits_used(),
            200,
            "a failed attempt charges nothing extra"
        );
    }
}

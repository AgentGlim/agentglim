//! v5 G07 (harness half): snapshot revision identity, coverage and durability through the REAL path.
//!
//! Every scenario here drives `plans_harness::PlansHarness` (the production adapter) through the production
//! `spawn_poller` (`Source -> Buffer -> Bus -> SQLite`), reads the rows back from the SQLite file, and asserts
//! independently specified expectations: coverage semantics of an aggregate, exact worker identities, absence
//! tombstones, checkpoint-only restart, unchanged silence and failure-free retries.
//!
//! Nothing here replaces the adapter's parser, the poller's reconciliation or the store's transaction: the only
//! test-owned code is fixture generation and row reading. Expectations are derived from BUILD-V5 T04/S1
//! (truthful partial aggregates, 250/250 completion, disappearance/reappearance, unchanged replay) — never from
//! repaired output.

use agentglimd::adapters::plans_harness;
use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{Env, Source};
use agentglimd::store::Store;
use rusqlite::Connection;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::sync::watch;

const SOURCE: &str = plans_harness::ID;
const ROUND: &str = "p/r1";
const WORKERS: usize = 250;

// ------------------------------------------------------------------------------------------------- fixture home

struct Home {
    _t: TempDir,
    home: PathBuf,
    rdir: PathBuf,
}

impl Home {
    fn new(workers: usize) -> Home {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let rdir = home.join("projects/dev/plans/p/_build/r1");
        fs::create_dir_all(rdir.join("workers")).unwrap();
        fs::write(rdir.join("BUILD-LOG.md"), "line 1\n").unwrap();
        for i in 0..workers {
            let d = rdir.join("workers").join(worker_name(i));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("DONE"), "").unwrap();
        }
        Home { _t: t, home, rdir }
    }

    /// Adds a second plan/round to the same private home, so a scenario can hold two independent durable
    /// populations and make one of them unreadable.
    fn add_plan(&self, plan: &str, workers: usize) {
        let rdir = self
            .home
            .join("projects/dev/plans")
            .join(plan)
            .join("_build/r1");
        fs::create_dir_all(rdir.join("workers")).unwrap();
        fs::write(rdir.join("BUILD-LOG.md"), "line 1\n").unwrap();
        for i in 0..workers {
            let d = rdir.join("workers").join(worker_name(i));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("DONE"), "").unwrap();
        }
    }

    /// The `_build` directory of one plan (what an unreadable plan must not turn into absence evidence).
    fn build_dir(&self, plan: &str) -> PathBuf {
        self.home
            .join("projects/dev/plans")
            .join(plan)
            .join("_build")
    }

    /// Adds one more DONE worker to an existing plan/round (a post-recovery change the adapter must observe).
    fn add_worker(&self, plan: &str, i: usize) {
        let d = self
            .home
            .join("projects/dev/plans")
            .join(plan)
            .join("_build/r1/workers")
            .join(worker_name(i));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("DONE"), "").unwrap();
    }

    fn source(&self) -> Arc<dyn Source> {
        Arc::new(
            plans_harness::PlansHarness::new(None, &self.home, 30)
                .with_census_floor(std::time::Duration::ZERO),
        )
    }

    fn env(&self) -> Env {
        Env {
            home: self.home.clone(),
            vars: Default::default(),
        }
    }

    fn worker_dir(&self, name: &str) -> PathBuf {
        self.rdir.join("workers").join(name)
    }

    fn set_done(&self, name: &str, done: bool) {
        let p = self.worker_dir(name).join("DONE");
        if done {
            fs::write(p, "").unwrap();
        } else if p.exists() {
            fs::remove_file(p).unwrap();
        }
    }
}

fn worker_name(i: usize) -> String {
    format!("w{i:03}")
}

// -------------------------------------------------------------------------------------------------- poller rig

struct Run {
    data: PathBuf,
    store: Store,
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
    src: Arc<dyn Source>,
}

impl Run {
    /// Starts the real poller over a private data directory (fresh data dir under `dir`).
    fn start(dir: &Path, home: &Home) -> Run {
        Self::start_in(
            dir.join("data"),
            home,
            Intervals {
                poll: Duration::from_millis(20),
                discover: Duration::from_millis(20),
            },
        )
    }

    /// Starts the real poller over an existing data directory with explicit intervals, so a scenario can also
    /// stop a run in the middle of a bounded sweep and restart it later against the same durable state.
    fn start_in(data: PathBuf, home: &Home, intervals: Intervals) -> Run {
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        let src = home.source();
        let (refresh_tx, refresh) = watch::channel(0u64);
        std::mem::forget(refresh_tx);
        let (stop, stop_rx) = watch::channel(false);
        let deps = PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![src.clone()]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: home.env(),
            intervals,
            refresh,
        };
        let handle = spawn_poller(deps, stop_rx);
        Run {
            data,
            store,
            stop,
            handle,
            src,
        }
    }

    /// The adapter instance the poller drives, for adapter-level assertions (e.g. `discovery_complete()`).
    fn src(&self) -> &Arc<dyn Source> {
        &self.src
    }

    async fn stop(self) -> PathBuf {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(10), self.handle).await;
        self.data
    }

    fn db(&self) -> Connection {
        Connection::open(self.data.join("state.db")).unwrap()
    }

    fn run_rows(&self) -> Vec<(u64, Value)> {
        let c = self.db();
        let mut st = c
            .prepare("SELECT seq, data FROM events WHERE source=?1 AND kind='run' ORDER BY seq")
            .unwrap();
        let rows = st
            .query_map([SOURCE], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))
            })
            .unwrap();
        rows.map(|r| {
            let (seq, raw) = r.unwrap();
            (seq, serde_json::from_str(&raw).unwrap())
        })
        .collect()
    }

    /// `(seq, worker, done)` for every stored child observation of the round.
    fn child_rows(&self) -> Vec<(u64, String, bool)> {
        self.child_rows_of(ROUND)
    }

    /// `(seq, worker, done)` for the stored child observations of one plan/round session.
    fn child_rows_of(&self, round: &str) -> Vec<(u64, String, bool)> {
        let c = self.db();
        let mut st = c
            .prepare(
                "SELECT seq, session, data FROM events WHERE source=?1 AND kind='child' ORDER BY seq",
            )
            .unwrap();
        let rows = st
            .query_map([SOURCE], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap();
        rows.filter_map(|r| {
            let (seq, session, raw) = r.unwrap();
            if session != round {
                return None;
            }
            let v: Value = serde_json::from_str(&raw).unwrap();
            Some((
                seq,
                v.get("worker")?.as_str()?.to_string(),
                v.get("done")?.as_bool()?,
            ))
        })
        .collect()
    }

    fn event_rows(&self) -> u64 {
        self.store.event_count().unwrap() as u64
    }

    /// Watermark for "only observations stored after this point count".
    fn watermark(&self) -> u64 {
        self.run_rows().last().map(|(s, _)| *s).unwrap_or(0)
    }

    /// Wait until a stored Run satisfies `f` (fresh read of the SQLite file on every attempt).
    async fn wait_run(&self, what: &str, within: Duration, f: impl Fn(&Value) -> bool) -> Value {
        self.wait_run_after(0, what, within, f).await
    }

    /// Same, but only Runs stored after `floor` may satisfy `f`, so an older identical aggregate cannot answer
    /// for a change that has not been observed yet.
    async fn wait_run_after(
        &self,
        floor: u64,
        what: &str,
        within: Duration,
        f: impl Fn(&Value) -> bool,
    ) -> Value {
        self.wait_run_row_after(floor, what, within, f).await.1
    }

    /// [`Run::wait_run_after`] that also returns the stored seq of the matching Run, for ordering assertions.
    async fn wait_run_row_after(
        &self,
        floor: u64,
        what: &str,
        within: Duration,
        f: impl Fn(&Value) -> bool,
    ) -> (u64, Value) {
        self.wait_run_row_after_with(floor, what, within, f, false)
            .await
    }

    /// The **earliest** Run stored after `floor` that satisfies `f` (truth of the first claim after a boundary,
    /// rather than the eventual state a later sweep may have corrected).
    async fn wait_first_run_row_after(
        &self,
        floor: u64,
        what: &str,
        within: Duration,
        f: impl Fn(&Value) -> bool,
    ) -> (u64, Value) {
        self.wait_run_row_after_with(floor, what, within, f, true)
            .await
    }

    async fn wait_run_row_after_with(
        &self,
        floor: u64,
        what: &str,
        within: Duration,
        f: impl Fn(&Value) -> bool,
        earliest: bool,
    ) -> (u64, Value) {
        let t0 = Instant::now();
        loop {
            let rows = self.run_rows();
            let rows = rows.iter().filter(|(s, d)| *s > floor && f(d));
            let hit = if earliest {
                rows.min_by_key(|(s, _)| *s)
            } else {
                rows.max_by_key(|(s, _)| *s)
            };
            if let Some((seq, data)) = hit {
                return (*seq, data.clone());
            }
            if t0.elapsed() > within {
                panic!(
                    "timed out waiting for {what}; stored runs: {:?}",
                    self.run_rows()
                        .iter()
                        .map(|(_, d)| d.clone())
                        .collect::<Vec<_>>()
                );
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn partial(v: &Value) -> Option<bool> {
    v.get("partial").and_then(Value::as_bool)
}

const COVERAGE_KEYS: [&str; 8] = [
    "coverage",
    "sweep",
    "sweep_complete",
    "coverage_complete",
    "observed_workers",
    "observed",
    "total_known",
    "workers_observed",
];

fn has_coverage(v: &Value) -> bool {
    COVERAGE_KEYS.iter().any(|k| v.get(*k).is_some())
}

async fn settle(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

// ------------------------------------------------------------------------------------------------- the scenarios

/// S1 through the real store: every aggregate that does not cover all 250 workers must be marked partial with
/// coverage, and the completed aggregate must be exactly 250/250 with all 250 workers stored.
#[tokio::test]
async fn harness_partial_then_complete_aggregate_is_truthful() {
    let h = Home::new(WORKERS);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);

    let complete = run
        .wait_run("complete 250/250 aggregate", Duration::from_secs(30), |d| {
            num(d, "workers") == WORKERS as u64 && num(d, "done") == WORKERS as u64
        })
        .await;
    assert_ne!(
        partial(&complete),
        Some(true),
        "the completed aggregate must not be partial: {complete}"
    );
    assert_eq!(num(&complete, "workers"), WORKERS as u64);
    assert_eq!(num(&complete, "done"), WORKERS as u64);

    // Retrospective coverage check over the stored sequence: any aggregate stored before all 250 workers had
    // been observed cannot describe the full population and must say so.
    let children = run.child_rows();
    let mut seen: std::collections::BTreeSet<String> = Default::default();
    for (seq, data) in run.run_rows() {
        for (cseq, name, _) in &children {
            if *cseq < seq {
                seen.insert(name.clone());
            }
        }
        if seen.len() < WORKERS {
            assert_eq!(
                partial(&data),
                Some(true),
                "aggregate at seq {seq} covered {}/{WORKERS} workers but is not marked partial:true: {data}",
                seen.len()
            );
            assert!(
                has_coverage(&data),
                "aggregate at seq {seq} is partial without meaningful coverage ({COVERAGE_KEYS:?}): {data}"
            );
            assert!(
                num(&data, "workers") <= WORKERS as u64,
                "a partial aggregate may not invent workers: {data}"
            );
        }
    }

    // Every worker is stored exactly once, with the DONE flag the fixture proves.
    let names: std::collections::BTreeSet<String> =
        children.iter().map(|(_, n, _)| n.clone()).collect();
    assert_eq!(
        names.len(),
        WORKERS,
        "every worker must be reported; stored {} distinct names",
        names.len()
    );
    for i in 0..WORKERS {
        assert!(
            names.contains(&worker_name(i)),
            "worker {} missing from the stored children",
            worker_name(i)
        );
    }
    assert!(
        children.iter().all(|(_, _, done)| *done),
        "every worker in the fixture has DONE, so no stored child may say done=false"
    );

    // seq strictly increases and is unique (no rewrite of stored history).
    let mut seqs: Vec<u64> = run.run_rows().iter().map(|(s, _)| *s).collect();
    let unique = {
        let mut s = seqs.clone();
        s.sort_unstable();
        s.dedup();
        s.len()
    };
    assert_eq!(unique, seqs.len(), "stored run seq values must be unique");
    seqs.sort_unstable();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq must increase");

    // Source-level revisions are durable for the round.
    let revisions = run.store.load_revisions(SOURCE).unwrap();
    assert!(
        revisions.contains_key(ROUND),
        "the round revision token must be durable; stored revisions: {revisions:?}"
    );

    // Unchanged replay: no new rows, no duplicate children.
    let before = run.event_rows();
    settle(400).await;
    assert_eq!(
        run.event_rows(),
        before,
        "unchanged harness polls must not store anything new"
    );
    run.stop().await;
}

/// Exactly-once producer identity for accepted snapshot observations (snapshot producers, BUILD-V5 T04).
#[tokio::test]
async fn harness_producer_keys_are_unique_and_durable() {
    let h = Home::new(24);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);
    run.wait_run("complete aggregate", Duration::from_secs(30), |d| {
        num(d, "workers") == 24 && num(d, "done") == 24
    })
    .await;

    let producers = run.store.producers(SOURCE).unwrap();
    assert!(
        !producers.is_empty(),
        "harness snapshot observations must carry producer identity so the store can deduplicate them"
    );
    let unique: std::collections::BTreeSet<&String> = producers.iter().collect();
    assert_eq!(
        unique.len(),
        producers.len(),
        "producer keys must be unique per accepted observation"
    );
    assert!(
        producers.iter().any(|p| p.starts_with("rev\u{1f}")),
        "snapshot producers must use the revision namespace, got {:?}",
        &producers[..1.min(producers.len())]
    );
    // Producer keys cannot outnumber the stored events that carry them.
    let items = run.store.event_count().unwrap() as usize;
    assert!(
        producers.len() <= items,
        "producer keys cannot outnumber stored events"
    );

    // Independent SQLite check of the accepted-revision identity per stored child observation: the fixture has
    // exactly 24 DONE workers, so 24 distinct child rows with 24 distinct revision-namespace producers.
    let mut child_producers = {
        let c = run.db();
        let mut st = c
            .prepare(
                "SELECT producer FROM events WHERE source=?1 AND kind='child' AND session=?2 ORDER BY seq",
            )
            .unwrap();
        let rows = st
            .query_map(rusqlite::params![SOURCE, ROUND], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap();
        rows.map(|r| r.unwrap())
            .map(|p| p.expect("every stored child needs a durable producer identity"))
            .collect::<Vec<String>>()
    };
    child_producers.sort();
    child_producers.dedup();
    assert_eq!(
        child_producers.len(),
        24,
        "the 24 DONE workers must be 24 distinct accepted child observations, got {}",
        child_producers.len()
    );
    assert!(
        child_producers.iter().all(|p| p.starts_with("rev\u{1f}")),
        "every child producer must use the revision namespace: {:?}",
        &child_producers[..1.min(child_producers.len())]
    );

    let before = producers.len();
    settle(300).await;
    assert_eq!(
        run.store.producers(SOURCE).unwrap().len(),
        before,
        "an unchanged round must not add producer identities"
    );
    run.stop().await;
}

/// Restart in the middle of a bounded sweep: the poller is stopped after the first bounded page, and a fresh
/// adapter + poller over the same durable state must finish 250/250 without losing or duplicating a worker.
#[tokio::test]
async fn harness_restart_mid_sweep_completes_without_loss() {
    let h = Home::new(WORKERS);
    let dir = tempfile::tempdir().unwrap();
    // One turn only: the tick intervals are far longer than the scenario.
    let slow = Intervals {
        poll: Duration::from_secs(30),
        discover: Duration::from_secs(30),
    };
    let data = dir.path().join("data");
    let run = Run::start_in(data.clone(), &h, slow);
    // The first bounded sweep cannot observe all 250 workers in one page, so the page to interrupt is a
    // genuinely partial observation: explicit `partial:true` plus coverage and fewer than 250 workers. Waiting
    // for a full population in one bounded page would itself violate the shared entry/visit cap.
    let (_, page) = run
        .wait_run_row_after(0, "first partial page", Duration::from_secs(15), |d| {
            partial(d) == Some(true) && has_coverage(d) && num(d, "workers") < WORKERS as u64
        })
        .await;
    let observed = run.child_rows().len();
    assert!(
        observed > 0 && observed < WORKERS,
        "the first bounded turn must observe a page, not the whole population; saw {observed} children ({page})"
    );
    assert!(
        num(&page, "workers") <= observed as u64,
        "a partial aggregate may never claim more workers than it has already observed evidence for: {page}"
    );
    run.stop().await;

    // Fresh process state, same durable store: the poller restores the checkpoint before polling.
    let restarted = Run::start_in(
        data,
        &h,
        Intervals {
            poll: Duration::from_millis(20),
            discover: Duration::from_millis(20),
        },
    );
    let complete = restarted
        .wait_run(
            "250/250 after mid-sweep restart",
            Duration::from_secs(30),
            |d| num(d, "workers") == WORKERS as u64 && num(d, "done") == WORKERS as u64,
        )
        .await;
    assert_ne!(
        partial(&complete),
        Some(true),
        "completed restart run: {complete}"
    );

    let counts = {
        let mut m: std::collections::BTreeMap<String, usize> = Default::default();
        for (_, name, _) in restarted.child_rows() {
            *m.entry(name).or_default() += 1;
        }
        m
    };
    assert_eq!(
        counts.len(),
        WORKERS,
        "a mid-sweep restart must still account for all {WORKERS} workers across both runs, saw {}",
        counts.len()
    );
    assert!(
        counts.values().all(|n| *n <= 1),
        "an already delivered, unchanged worker must not be re-delivered after restart: {:?}",
        counts.iter().filter(|(_, n)| **n > 1).collect::<Vec<_>>()
    );
    restarted.stop().await;
}

/// A DONE marker that goes away and comes back is two distinct accepted observations of the same worker.
#[tokio::test]
async fn harness_done_removal_and_recreation_is_observed() {
    const N: usize = 8;
    let h = Home::new(N);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);
    run.wait_run("initial completion", Duration::from_secs(20), |d| {
        num(d, "workers") == N as u64 && num(d, "done") == N as u64
    })
    .await;

    h.set_done("w003", false);
    let floor = run.watermark();
    let without = run
        .wait_run_after(
            floor,
            "DONE removal observed",
            Duration::from_secs(20),
            |d| num(d, "workers") == N as u64 && num(d, "done") == (N - 1) as u64,
        )
        .await;
    assert_ne!(
        partial(&without),
        Some(true),
        "a complete sweep that simply finds one fewer DONE marker is not a partial aggregate: {without}"
    );
    let child = run
        .child_rows()
        .into_iter()
        .rev()
        .find(|(_, n, _)| n == "w003")
        .expect("the changed worker must be reported");
    assert!(!child.2, "the DONE removal must be reported as done=false");

    h.set_done("w003", true);
    let floor = run.watermark();
    let back = run
        .wait_run_after(
            floor,
            "DONE recreation observed",
            Duration::from_secs(20),
            |d| num(d, "workers") == N as u64 && num(d, "done") == N as u64,
        )
        .await;
    assert_ne!(partial(&back), Some(true), "recreated DONE run: {back}");
    let child = run
        .child_rows()
        .into_iter()
        .rev()
        .find(|(_, n, _)| n == "w003")
        .expect("the recreated worker must be reported");
    assert!(child.2, "the recreated DONE must be reported as done=true");
    run.stop().await;
}

/// A worker directory that disappears is tombstoned only after a complete sweep, and reappearance clears it.
#[tokio::test]
async fn harness_worker_disappearance_and_reappearance() {
    const N: usize = 6;
    let h = Home::new(N);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);
    run.wait_run("initial completion", Duration::from_secs(20), |d| {
        num(d, "workers") == N as u64 && num(d, "done") == N as u64
    })
    .await;

    let removed_path = "p/_build/r1/workers/w002/DONE".to_string();
    fs::remove_dir_all(h.worker_dir("w002")).unwrap();
    let floor = run.watermark();
    run.wait_run_after(
        floor,
        "worker disappearance",
        Duration::from_secs(20),
        |d| num(d, "workers") == (N - 1) as u64,
    )
    .await;
    let tombstones = run.store.load_removed(SOURCE).unwrap();
    assert!(
        tombstones.iter().any(|r| r.path == removed_path),
        "a completed sweep that proved the worker absent must tombstone its path; got {:?}",
        tombstones
            .iter()
            .map(|r| r.path.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        !run.store
            .load_file_state(SOURCE)
            .unwrap()
            .iter()
            .any(|f| f.path == removed_path),
        "the tombstoned path must not keep stale parser state"
    );

    // Reappearance: the same worker comes back with DONE.
    let d = h.worker_dir("w002");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("DONE"), "").unwrap();
    let floor = run.watermark();
    run.wait_run_after(floor, "worker reappearance", Duration::from_secs(20), |d| {
        num(d, "workers") == N as u64 && num(d, "done") == N as u64
    })
    .await;
    assert!(
        run.store.load_removed(SOURCE).unwrap().is_empty(),
        "a reappeared path must clear its tombstone"
    );
    let child = run
        .child_rows()
        .into_iter()
        .rev()
        .find(|(_, n, _)| n == "w002")
        .expect("the reappeared worker must be reported");
    assert!(child.2, "the reappeared worker must report done=true");
    run.stop().await;
}

/// A round whose BUILD-LOG grows keeps its bounded log continuation: the appended line is observed once, and
/// the unchanged state afterwards is silent.
#[tokio::test]
async fn harness_log_append_advances_once_and_then_is_silent() {
    const N: usize = 4;
    let h = Home::new(N);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);
    let first = run
        .wait_run(
            "initial aggregate with one log line",
            Duration::from_secs(20),
            |d| num(d, "build_log_lines") == 1,
        )
        .await;
    assert_eq!(num(&first, "workers"), N as u64);

    fs::write(h.rdir.join("BUILD-LOG.md"), "line 1\nline 2\n").unwrap();
    let second = run
        .wait_run("appended log line", Duration::from_secs(20), |d| {
            num(d, "build_log_lines") == 2
        })
        .await;
    assert_eq!(num(&second, "workers"), N as u64);

    let before = run.event_rows();
    settle(400).await;
    assert_eq!(
        run.event_rows(),
        before,
        "an unchanged round after the append must stop storing events"
    );
    // The log summary must never go backwards.
    assert!(
        run.run_rows()
            .iter()
            .all(|(_, d)| num(d, "build_log_lines") <= 2),
        "log line counts must be monotonic"
    );
    run.stop().await;
}

// ------------------------------------------------------------------------------- r2 added integration cases

/// Restores a directory's permissions even if the scenario panics, so a failing assertion cannot leave an
/// unreadable fixture behind for the tempdir cleanup.
#[cfg(unix)]
struct ModeGuard {
    path: PathBuf,
    mode: u32,
}

#[cfg(unix)]
impl ModeGuard {
    fn set(path: &Path, mode: u32) -> ModeGuard {
        use std::os::unix::fs::PermissionsExt;
        let old = fs::metadata(path).unwrap().permissions().mode() & 0o777;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        ModeGuard {
            path: path.to_path_buf(),
            mode: old,
        }
    }
}

#[cfg(unix)]
impl Drop for ModeGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode));
    }
}

/// An unreadable plan `_build` (permission denied, not "absent") must never certify absence: no false tombstone,
/// no loss of the plan's durable rounds/workers, and full recovery once the directory is readable again.
///
/// Expectations are independent of the adapter's output: the fixture proves both rounds exist, so the store may
/// not record a removal for the plan that merely became unreadable.
#[cfg(unix)]
#[tokio::test]
async fn harness_unreadable_build_never_certifies_absence_or_tombstones() {
    const P: usize = 3;
    const Q: usize = 4;
    let h = Home::new(P);
    h.add_plan("q", Q);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);

    run.wait_run("p complete", Duration::from_secs(30), |d| {
        d.get("plan") == Some(&Value::String("p".into()))
            && num(d, "workers") == P as u64
            && num(d, "done") == P as u64
    })
    .await;
    run.wait_run("q complete", Duration::from_secs(30), |d| {
        d.get("plan") == Some(&Value::String("q".into()))
            && num(d, "workers") == Q as u64
            && num(d, "done") == Q as u64
    })
    .await;
    assert!(
        run.store.load_removed(SOURCE).unwrap().is_empty(),
        "the healthy fixture has no removals to report"
    );
    let q_state_before = run
        .store
        .load_file_state(SOURCE)
        .unwrap()
        .into_iter()
        .filter(|f| f.path.starts_with("q/_build"))
        .count();
    assert!(
        q_state_before >= Q,
        "the healthy fixture must have persisted q's workers, found {q_state_before}"
    );

    let unreadable = ModeGuard::set(&h.build_dir("q"), 0o000);
    settle(1200).await;

    assert!(
        !run.src().discovery_complete(),
        "an unreadable plan `_build` must not certify a complete sweep: absence was never proven"
    );
    let tombstones = run.store.load_removed(SOURCE).unwrap();
    assert!(
        !tombstones.iter().any(|r| r.path.starts_with("q/_build")),
        "an unreadable directory must not create removal tombstones for paths that still exist: {:?}",
        tombstones.iter().map(|r| r.path.clone()).collect::<Vec<_>>()
    );
    let q_state_during = run
        .store
        .load_file_state(SOURCE)
        .unwrap()
        .into_iter()
        .filter(|f| f.path.starts_with("q/_build"))
        .count();
    assert_eq!(
        q_state_during, q_state_before,
        "an unreadable sweep must keep the plan's committed parser state instead of dropping it"
    );

    drop(unreadable);
    // Recovery must be honest in both directions: discovery certifies completion again, nothing was tombstoned,
    // and the round is serviced again. A preserved, unchanged round correctly emits nothing (unchanged replay is
    // silent), so recovery is proved by a change made after the directory is readable again, not by demanding a
    // spurious re-emit.
    let t0 = Instant::now();
    while !run.src().discovery_complete() {
        assert!(
            t0.elapsed() < Duration::from_secs(30),
            "discovery must certify a complete sweep again once the directory is readable; stored runs: {:?}",
            run.run_rows()
                .iter()
                .map(|(_, d)| d.clone())
                .collect::<Vec<_>>()
        );
        settle(50).await;
    }
    assert!(
        run.store.load_removed(SOURCE).unwrap().is_empty(),
        "recovery must not leave a tombstone behind: {:?}",
        run.store
            .load_removed(SOURCE)
            .unwrap()
            .iter()
            .map(|r| r.path.clone())
            .collect::<Vec<_>>()
    );
    let q_children = run.child_rows_of("q/r1");
    let q_names: std::collections::BTreeSet<String> =
        q_children.iter().map(|(_, n, _)| n.clone()).collect();
    assert_eq!(
        q_names.len(),
        Q,
        "every worker of the recovered round must still be accounted for, found {q_names:?}"
    );
    // A worker added after the error cleared proves the plan is discoverable and serviced again.
    h.add_worker("q", Q);
    let floor = run.watermark();
    let recovered = run
        .wait_run_after(
            floor,
            "q serviced again after the error cleared",
            Duration::from_secs(30),
            |d| {
                d.get("plan") == Some(&Value::String("q".into()))
                    && partial(d) != Some(true)
                    && num(d, "workers") == (Q + 1) as u64
                    && num(d, "done") == (Q + 1) as u64
            },
        )
        .await;
    assert_eq!(num(&recovered, "workers"), (Q + 1) as u64);
    assert!(
        run.store
            .load_file_state(SOURCE)
            .unwrap()
            .iter()
            .any(|f| f.path == format!("q/_build/r1/workers/{}/DONE", worker_name(Q))),
        "the worker added after recovery must be persisted, not lost to the earlier error"
    );
    run.stop().await;
}

/// A complete aggregate may never be stored before the child observations it counts (event-order truthfulness).
///
/// The population claim is checked against SQLite seq order, not against the adapter's own output: every worker
/// the completed Run counts must have a stored `child` observation with a smaller seq.
#[tokio::test]
async fn harness_complete_aggregate_never_precedes_its_child_evidence() {
    let h = Home::new(WORKERS);
    let dir = tempfile::tempdir().unwrap();
    let run = Run::start(dir.path(), &h);
    let (seq, complete) = run
        .wait_run_row_after(
            0,
            "complete 250/250 aggregate",
            Duration::from_secs(30),
            |d| {
                partial(d) != Some(true)
                    && num(d, "workers") == WORKERS as u64
                    && num(d, "done") == WORKERS as u64
            },
        )
        .await;

    // Independently expected aggregate payload from the fixture (never read back from adapter output): plan `p`,
    // round `r1`, one BUILD-LOG line and 250 DONE workers.
    assert_eq!(complete.get("plan"), Some(&Value::String("p".into())));
    assert_eq!(complete.get("round"), Some(&Value::String("r1".into())));
    assert_eq!(num(&complete, "build_log_lines"), 1);
    assert_eq!(num(&complete, "workers"), WORKERS as u64);
    assert_eq!(num(&complete, "done"), WORKERS as u64);

    let children = run.child_rows();
    assert!(
        children.iter().all(|(_, _, done)| *done),
        "every fixture worker has a DONE marker, so no stored child observation may say done=false"
    );
    let covered: std::collections::BTreeSet<String> = children
        .iter()
        .filter(|(cseq, _, _)| *cseq < seq)
        .map(|(_, name, _)| name.clone())
        .collect();
    assert_eq!(
        covered.len(),
        WORKERS,
        "the complete aggregate at seq {seq} claims {} workers but only {} child observations precede it: \
         the population claim is stored before its evidence ({complete})",
        num(&complete, "workers"),
        covered.len()
    );
    let done_before = children
        .iter()
        .filter(|(cseq, _, done)| *cseq < seq && *done)
        .count();
    assert_eq!(
        num(&complete, "done"),
        done_before as u64,
        "the completed aggregate's done count must be covered by earlier stored child evidence \
         (aggregate: {complete})"
    );
    // And the aggregate's own seq is still unique/increasing with respect to the children it counts.
    assert!(
        children.iter().all(|(cseq, _, _)| *cseq != seq),
        "the aggregate seq {seq} collides with a child observation"
    );
    run.stop().await;
}

/// A worker whose DONE marker changes while the process is down and that sorts *below* the resumed sweep cursor
/// must be re-observed before the resumed sweep reports completion: the first complete aggregate stored after the
/// restart may not repeat the pre-downtime flags.
#[tokio::test]
async fn harness_downtime_change_below_resumed_cursor_is_observed() {
    let h = Home::new(WORKERS);
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let slow = Intervals {
        poll: Duration::from_secs(30),
        discover: Duration::from_secs(30),
    };
    let run = Run::start_in(data.clone(), &h, slow);
    let (_, page) = run
        .wait_run_row_after(0, "first partial page", Duration::from_secs(15), |d| {
            partial(d) == Some(true) && has_coverage(d) && num(d, "workers") < WORKERS as u64
        })
        .await;
    assert!(
        num(&page, "workers") > 0,
        "the interrupted sweep must have observed something: {page}"
    );
    // Pick a worker the first bounded page already observed and committed, and that sorts strictly below the
    // resumed sweep cursor: a resumed sweep that only visits names greater than its durable cursor never re-reads
    // it, so its committed DONE flag would be republished as a complete population observation.
    let observed: Vec<String> = run
        .child_rows()
        .into_iter()
        .map(|(_, name, _)| name)
        .collect();
    assert!(
        observed.len() >= 2,
        "the interrupted page must have committed worker observations, got {observed:?}"
    );
    let victim = observed.iter().min().cloned().unwrap();
    let cursor_name = observed.iter().max().cloned().unwrap();
    assert!(
        victim < cursor_name,
        "the changed worker must sort below the resumed cursor ({victim} vs {cursor_name})"
    );
    let floor = run.watermark();
    run.stop().await;
    h.set_done(&victim, false);

    let restarted = Run::start_in(
        data,
        &h,
        Intervals {
            poll: Duration::from_millis(20),
            discover: Duration::from_millis(20),
        },
    );
    // The FIRST complete aggregate stored after the restart is the claim that matters: a later sweep may correct
    // it, but the resumed sweep must not publish pre-downtime flags as a complete population observation.
    let (_, first_complete) = restarted
        .wait_first_run_row_after(
            floor,
            "first complete aggregate after restart",
            Duration::from_secs(30),
            |d| partial(d) != Some(true) && num(d, "workers") == WORKERS as u64,
        )
        .await;
    assert_eq!(
        num(&first_complete, "done"),
        (WORKERS - 1) as u64,
        "a DONE removal of an already-observed worker below the resumed cursor must be re-observed before the \
         resumed sweep reports completion ({victim}); the first complete aggregate after restart says \
         {first_complete}"
    );
    let changed = restarted
        .child_rows()
        .into_iter()
        .rev()
        .find(|(_, name, _)| name == &victim)
        .expect("the changed worker must be re-observed as a child observation");
    assert!(
        !changed.2,
        "the re-observed worker must report done=false, got {changed:?}"
    );
    restarted.stop().await;
}

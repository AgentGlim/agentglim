//! v6 G09: permanent fail-before regressions for the v5 final-verifier findings (BUILD-V6 T02).
//!
//! These three cases use the verifier's exact scenarios and limits (BUILD-V6 §4 T02, REOPEN-V6 items 1–3).
//! Against the unchanged v5 production they must execute as real assertion failures (not compile errors,
//! not timeouts):
//!
//! * `large_harness_removed_worker_keeps_tombstone` (V6.2): the real Source → poller → Bus → SQLite path
//!   over 221 plans (p/r1 with 250 DONE workers plus 220 other plans with one each) at a 20 ms cadence.
//!   After p completes at 250 workers, w000 is deleted; after p completes at 249 plus a 1.5 s settle,
//!   exactly one `source_removed` row must exist for `p/_build/r1/workers/w000/DONE` and the committed
//!   path must not keep stale parser state. v5 leaves saved=0/tombstones=0.
//! * `log_suffix_newline_change_is_observed` (V6.3): a 601-byte BUILD-LOG with one newline; byte 400 is
//!   changed to a newline preserving inode/length/mtime. Twenty real polls must yield a Run reporting
//!   two lines. v5's 256-byte prefix equality never re-reads past byte 256, so it stays observed=false.
//! * `checkpoint_work_bounded_by_turn_not_population` (V6.4): the same one-file changed-work scheduled
//!   turn against 1,000 resident files versus 10,000 resident files. The per-turn checkpoint rows built
//!   (and therefore compared by core equality and converted by Bus/Store for the commit) must stay under
//!   a stated constant and must not grow with the resident population. v5 builds/compares/converts the
//!   whole resident checkpoint every turn, so 10k rows are built for one changed file.
//!
//! Application counters and test-side row counts are application accounting. They are not kernel I/O
//! evidence; strace is unavailable on this host and no kernel claim is made.

use agentglimd::adapters::{claude_code, plans_harness};
use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{
    Cursor, Env, FileCheckpoint, Source, SourceCheckpoint, TurnBudget, TURN_ALLOWANCE_ENTRIES,
    TURN_ALLOWANCE_VISITS,
};
use agentglimd::store::Store;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

const SOURCE: &str = plans_harness::ID;

// ===================================================================================== tombstone (V6.2)

fn worker_name(i: usize) -> String {
    format!("w{i:03}")
}

/// One plan/round under `projects/dev/plans/<plan>/_build/r1` with `workers` DONE workers.
fn make_plan(home: &Path, plan: &str, workers: usize) {
    let rdir = home.join("projects/dev/plans").join(plan).join("_build/r1");
    fs::create_dir_all(rdir.join("workers")).unwrap();
    fs::write(rdir.join("BUILD-LOG.md"), "line 1\n").unwrap();
    for i in 0..workers {
        let d = rdir.join("workers").join(worker_name(i));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("DONE"), "").unwrap();
    }
}

struct Run {
    data: PathBuf,
    store: Store,
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl Run {
    fn start(data: PathBuf, home: &Path) -> Run {
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        let src: Arc<dyn Source> = Arc::new(plans_harness::PlansHarness::new(None, home, 30));
        let (refresh_tx, refresh) = watch::channel(0u64);
        std::mem::forget(refresh_tx);
        let (stop, stop_rx) = watch::channel(false);
        let deps = PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![src]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: Env {
                home: home.to_path_buf(),
                vars: Default::default(),
            },
            intervals: Intervals {
                poll: Duration::from_millis(20),
                discover: Duration::from_millis(20),
            },
            refresh,
        };
        let handle = spawn_poller(deps, stop_rx);
        Run {
            data,
            store,
            stop,
            handle,
        }
    }

    async fn stop(self) -> PathBuf {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(10), self.handle).await;
        self.data
    }

    fn run_rows(&self) -> Vec<(u64, Value)> {
        let c = rusqlite::Connection::open(self.data.join("state.db")).unwrap();
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
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn is_plan_run(v: &Value, plan: &str) -> bool {
    v.get("plan") == Some(&Value::String(plan.into()))
}

/// Waits for the latest stored Run of `plan` with the exact worker count; returns whether it appeared.
async fn wait_plan_workers(run: &Run, plan: &str, workers: u64, within: Duration) -> bool {
    let t0 = std::time::Instant::now();
    loop {
        let seen = run
            .run_rows()
            .iter()
            .any(|(_, d)| is_plan_run(d, plan) && num(d, "workers") == workers);
        if seen {
            return true;
        }
        if t0.elapsed() > within {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn large_harness_removed_worker_keeps_tombstone() {
    // 221 plans: p/r1 with 250 DONE workers plus 220 other plans with one each (verifier exact shape).
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    make_plan(&home, "p", 250);
    for i in 0..220 {
        make_plan(&home, &format!("q{i:03}"), 1);
    }
    let data = tempfile::tempdir().unwrap();
    let run = Run::start(data.path().join("data"), &home);

    // Wait for the complete p=250 aggregate through the real poller.
    assert!(
        wait_plan_workers(&run, "p", 250, Duration::from_secs(120)).await,
        "p must complete at 250 workers before the removal; stored runs: {:?}",
        run.run_rows()
            .iter()
            .filter(|(_, d)| is_plan_run(d, "p"))
            .take(5)
            .collect::<Vec<_>>()
    );

    // Delete w000's directory, as the verifier does.
    let victim = home
        .join("projects/dev/plans/p/_build/r1/workers")
        .join("w000");
    assert!(victim.is_dir(), "fixture w000 must exist before deletion");
    fs::remove_dir_all(&victim).unwrap();

    // Wait for the complete p=249 aggregate (recorded, not fatal) plus the verifier's 1.5 s settle.
    let saw_249 = wait_plan_workers(&run, "p", 249, Duration::from_secs(60)).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let removed_path = "p/_build/r1/workers/w000/DONE".to_string();
    let tombstones = run
        .store
        .load_removed(SOURCE)
        .unwrap()
        .into_iter()
        .filter(|r| r.path == removed_path)
        .count();
    let saved = run
        .store
        .load_file_state(SOURCE)
        .unwrap()
        .into_iter()
        .filter(|f| f.path == removed_path)
        .count();
    run.stop().await;

    assert_eq!(
        tombstones, 1,
        "a removed worker must keep exactly one source_removed tombstone, no premature disappearance and \
         no duplicates: tombstones={tombstones} saved={saved} saw_249_again={saw_249} for {removed_path}"
    );
    assert_eq!(
        saved, 0,
        "the tombstoned path must not keep stale parser state: saved={saved} tombstones={tombstones} \
         for {removed_path}"
    );
}

// ====================================================================================== log witness (V6.3)

#[tokio::test]
async fn log_suffix_newline_change_is_observed() {
    // One round, one worker; the BUILD-LOG is 601 bytes with a single newline at byte 0.
    // The real Source -> poller -> Bus -> SQLite path drives the polls (20 ms cadence), exactly as
    // the verifier's 20 real polls do; the edit must surface within a bounded wait after it.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home.join("projects/dev/plans/p/_build/r1");
    fs::create_dir_all(rdir.join("workers/w000")).unwrap();
    fs::write(rdir.join("workers/w000/DONE"), "").unwrap();
    let log = rdir.join("BUILD-LOG.md");
    // One non-empty line of 600 bytes plus its newline (the reader does not count empty lines):
    // changing byte 400 to a newline splits it into two non-empty lines.
    let mut bytes = vec![b'x'; 601];
    bytes[600] = b'\n';
    assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 1);
    fs::write(&log, &bytes).unwrap();

    let data = tempfile::tempdir().unwrap();
    let run = Run::start(data.path().join("data"), &home);

    // The initial 601-byte log must report 1 line through the real store.
    let mut initial_lines = None;
    {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < Duration::from_secs(60) {
            for (_, d) in run.run_rows() {
                if is_plan_run(&d, "p") && num(&d, "build_log_lines") == 1 {
                    initial_lines = Some(1u64);
                    break;
                }
            }
            if initial_lines.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    assert_eq!(
        initial_lines,
        Some(1),
        "the initial 601-byte log must report 1 line"
    );

    // Change byte 400 to a newline, preserving inode, length and mtime (verifier exact edit).
    #[cfg(unix)]
    let ino_before = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&log).unwrap().ino()
    };
    let mtime_before = fs::metadata(&log).unwrap().modified().unwrap();
    assert_eq!(fs::metadata(&log).unwrap().len(), 601);
    {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = fs::OpenOptions::new().write(true).open(&log).unwrap();
        f.seek(SeekFrom::Start(400)).unwrap();
        f.write_all(b"\n").unwrap();
        f.flush().unwrap();
    }
    fs::File::options()
        .write(true)
        .open(&log)
        .unwrap()
        .set_modified(mtime_before)
        .unwrap();
    let meta_after = fs::metadata(&log).unwrap();
    assert_eq!(meta_after.len(), 601, "the edit must preserve the length");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            meta_after.ino(),
            ino_before,
            "the edit must preserve the inode"
        );
    }

    // Bounded wait (many poller ticks, well beyond 20 real polls) for a stored Run reporting 2 lines.
    let mut observed = false;
    let mut observed_lines = 0u64;
    {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < Duration::from_secs(10) {
            for (_, d) in run.run_rows() {
                if is_plan_run(&d, "p") {
                    let l = num(&d, "build_log_lines");
                    if l > observed_lines {
                        observed_lines = l;
                    }
                    if l == 2 {
                        observed = true;
                    }
                }
            }
            if observed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    run.stop().await;
    assert!(
        observed,
        "observed={observed} for a 601-byte log edited at byte 400 to a newline preserving          inode/length/mtime: no stored Run reported 2 lines within the bounded wait          (last seen {observed_lines})"
    );
}

// =================================================================================== checkpoint O(N) (V6.4)

/// Stated per-turn checkpoint ceiling: one changed file plus one turn's entry allowance (200) of
/// continuation work. A bounded delta must never build/compare/convert more rows than this for it.
const CHECKPOINT_TURN_CEILING: usize = 256;

/// Runs one scheduled turn (begin_turn → detect → poll → end_turn) of a Claude adapter whose restored
/// resident population is `resident` checkpoint rows, with exactly one changed file on disk, and returns
/// the number of checkpoint rows the production `checkpoint()` built for that turn. That one number is
/// also the rows core compares by whole-checkpoint equality and the rows Bus/Store convert for the
/// commit (checkpoint payload size), so it is the test-side counter on the real production path.
async fn checkpoint_rows_for_one_changed_turn(resident: usize) -> usize {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let proj = home.join(".claude/projects/-bulk");
    fs::create_dir_all(&proj).unwrap();
    // One real changed file: two lines on disk; the restored entry below covers only the first line.
    let line1 =
        "{\"type\":\"assistant\",\"sessionId\":\"c00000\",\"message\":{\"role\":\"assistant\",\
                 \"model\":\"m\"},\"timestamp\":\"2026-11-01T00:00:00.000Z\"}\n";
    let line2 =
        "{\"type\":\"assistant\",\"sessionId\":\"c00000\",\"message\":{\"role\":\"assistant\",\
                 \"model\":\"m\"},\"timestamp\":\"2026-11-01T00:00:01.000Z\"}\n";
    fs::write(proj.join("c00000.jsonl"), format!("{line1}{line2}")).unwrap();

    let src = claude_code::ClaudeCode::new(None, &home, 30);
    let env = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    // Resident population: strictly increasing relative paths, the first naming the changed file.
    let files: Vec<FileCheckpoint> = (0..resident)
        .map(|i| FileCheckpoint {
            path: format!("c{i:05}.jsonl"),
            generation: 1,
            offset: if i == 0 { line1.len() as u64 } else { 0 },
            size: if i == 0 { line1.len() as u64 } else { 0 },
            ..Default::default()
        })
        .collect();
    src.restore_checkpoint(SourceCheckpoint {
        files,
        revisions: Default::default(),
    });

    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    let _ = src.detect(&env);
    let batch = src.poll(Cursor(1)).await.unwrap();
    src.end_turn();
    // The one changed file sits on disk with new bytes; whether this bounded turn reaches its read
    // before the visit allowance is spent on the resident population is itself population-dependent
    // work - the measured quantity is the checkpoint payload, not this turn's emission.
    eprintln!(
        "resident={resident} turn_items={} next={:?}",
        batch.items.len(),
        batch.next
    );
    let usage = budget.usage();
    assert!(
        usage.entries.used <= TURN_ALLOWANCE_ENTRIES && usage.visits.used <= TURN_ALLOWANCE_VISITS,
        "the turn itself must stay inside the shared allowance even with {resident} residents: {usage:?}"
    );
    src.checkpoint().files.len()
}

#[tokio::test]
async fn checkpoint_work_bounded_by_turn_not_population() {
    let rows_1k = checkpoint_rows_for_one_changed_turn(1_000).await;
    let rows_10k = checkpoint_rows_for_one_changed_turn(10_000).await;
    let growth = rows_10k.saturating_sub(rows_1k);
    eprintln!(
        "checkpoint rows built for one changed file: 1k residents -> {rows_1k}, 10k residents -> {rows_10k}"
    );
    assert!(
        rows_10k <= CHECKPOINT_TURN_CEILING,
        "one changed file built {rows_10k} checkpoint rows with 10,000 residents (1k residents -> {rows_1k}); \
         the stated per-turn ceiling is {CHECKPOINT_TURN_CEILING} rows (changed work + one 200-entry allowance)"
    );
    assert!(
        growth <= 200,
        "checkpoint rows built grew by {growth} when the resident population grew 1k -> 10k for the same \
         one-file changed work (1k -> {rows_1k}, 10k -> {rows_10k}); growth must stay within one turn's \
         200-entry allowance"
    );
}

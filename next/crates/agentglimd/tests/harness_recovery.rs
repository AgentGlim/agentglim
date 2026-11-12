//! Harness recovery: durable per-round observations (revision, DONE presence, report presence,
//! log summary) and lossless bounded worker continuation across polls and restarts.
//!
//! These tests drive `plans_harness::PlansHarness` only, against generated temporary homes. The
//! fixture contract (exactly 2 Run + 3 Child) is asserted by `adapters_fixtures`/`poll_loop`.
use agentglimd::adapters::{plans_harness, MAX_FILES_PER_PASS};
use agentglimd::core::{Batch, BatchItem, Cursor, ItemKind, Source, SourceCheckpoint};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tempfile::TempDir;

struct Home {
    _t: TempDir,
    home: PathBuf,
    rdir: PathBuf,
}

impl Home {
    /// New plan `p` with one round `r1`; `log` content is optional.
    fn new(log: Option<&str>) -> Home {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let rdir = home.join("projects/dev/plans/p/_build/r1");
        fs::create_dir_all(rdir.join("workers")).unwrap();
        if let Some(text) = log {
            fs::write(rdir.join("BUILD-LOG.md"), text).unwrap();
        }
        Home { _t: t, home, rdir }
    }

    /// Unpaced source: these cases drive census re-sweeps with tight polls. The 15 s floor has its own cases.
    fn source(&self) -> plans_harness::PlansHarness {
        unpaced(&self.home)
    }

    /// `done`/`report` select which marker files exist; empty markers are meaningful.
    fn worker(&self, name: &str, done: bool, report: bool) {
        let d = self.rdir.join("workers").join(name);
        fs::create_dir_all(&d).unwrap();
        if done {
            fs::write(d.join("DONE"), "").unwrap();
        }
        if report {
            fs::write(d.join("REPORT.md"), "done\n").unwrap();
        }
    }

    fn set_log(&self, text: &str) {
        fs::write(self.rdir.join("BUILD-LOG.md"), text).unwrap();
    }
}

fn runs(b: &Batch) -> Vec<&BatchItem> {
    b.items.iter().filter(|i| i.kind == ItemKind::Run).collect()
}

fn children(b: &Batch) -> Vec<&BatchItem> {
    b.items
        .iter()
        .filter(|i| i.kind == ItemKind::Child)
        .collect()
}

fn child_names(b: &Batch) -> Vec<String> {
    children(b)
        .iter()
        .map(|i| i.data["worker"].as_str().unwrap().to_string())
        .collect()
}

/// Poll until a poll returns no items; returns per-pass item counts and all items in order.
async fn drain(src: &plans_harness::PlansHarness, first: Cursor, max_passes: usize) -> Vec<Batch> {
    let mut out = Vec::new();
    let mut cursor = first;
    for pass in 0..max_passes {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        let last = b.items.is_empty();
        out.push(b);
        if last {
            return out;
        }
        if pass + 1 == max_passes {
            panic!("drain did not settle within {max_passes} passes");
        }
    }
    out
}

/// A restored checkpoint of the current state must emit nothing, whatever revision it holds.
async fn assert_silent_restore(h: &Home, cp: SourceCheckpoint, label: &str) {
    let fresh = h.source();
    fresh.restore_checkpoint(cp);
    let b = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        b.items.is_empty(),
        "unchanged restart at {label} re-emitted: {:?}",
        b.items
    );
}

#[tokio::test]
async fn harness_restart_is_silent_for_every_committed_revision() {
    let h = Home::new(Some("a\n"));
    h.worker("alpha", true, false);

    // Every committed revision must restore silently while nothing changed since it was taken.
    // Revisions 1, 2 and later are checked the same way: no forced replay for "later" revisions.
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(runs(&b0).len(), 1);
    assert_eq!(children(&b0).len(), 1);
    assert_eq!(runs(&b0)[0].data["build_log_lines"], 1);
    let cp1 = src.checkpoint();
    assert_silent_restore(&h, cp1, "revision 1").await;

    // Revision 2: append a line.
    std::thread::sleep(Duration::from_millis(10));
    h.set_log("a\nb\n");
    let b1 = src.poll(b0.next).await.unwrap();
    assert_eq!(
        b1.items.len(),
        1,
        "append emits one Run only: {:?}",
        b1.items
    );
    assert_eq!(runs(&b1)[0].data["build_log_lines"], 2);
    let cp2 = src.checkpoint();
    assert_silent_restore(&h, cp2.clone(), "revision 2").await;

    // Revision 3: worker gains a REPORT file, log untouched.
    std::thread::sleep(Duration::from_millis(10));
    h.worker("alpha", true, true);
    let b2 = src.poll(b1.next).await.unwrap();
    assert_eq!(children(&b2).len(), 1, "report change: {:?}", b2.items);
    let cp3 = src.checkpoint();
    assert_silent_restore(&h, cp3, "revision 3").await;

    // A change after a restore is reported once, with the durable log summary intact.
    let fresh = h.source();
    fresh.restore_checkpoint(cp2);
    std::thread::sleep(Duration::from_millis(10));
    h.set_log("a\nb\nc\n");
    let b3 = fresh.poll(Cursor(1)).await.unwrap();
    assert_eq!(
        runs(&b3).len(),
        1,
        "one Run after restore+append: {:?}",
        b3.items
    );
    assert_eq!(
        runs(&b3)[0].data["build_log_lines"],
        3,
        "restored line count must not reset: {:?}",
        runs(&b3)[0]
    );
    let b4 = fresh.poll(b3.next).await.unwrap();
    assert!(b4.items.is_empty(), "settled after append: {:?}", b4.items);
}

#[tokio::test]
async fn harness_true_a_b_a_transitions_appear_exactly_once() {
    let h = Home::new(Some("A\n"));
    h.worker("alpha", true, false);

    let src = h.source();
    let ba = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(runs(&ba).len(), 1);
    let cp_a1 = src.checkpoint();

    std::thread::sleep(Duration::from_millis(10));
    h.set_log("B\n");
    let bb = src.poll(ba.next).await.unwrap();
    assert_eq!(runs(&bb).len(), 1, "A->B: {:?}", bb.items);
    let cp_b = src.checkpoint();

    std::thread::sleep(Duration::from_millis(10));
    h.set_log("A\n");
    let ba2 = src.poll(bb.next).await.unwrap();
    assert_eq!(runs(&ba2).len(), 1, "B->A: {:?}", ba2.items);
    let cp_a2 = src.checkpoint();

    // Restoring state B against current A observes the one real B->A transition.
    let from_b = h.source();
    from_b.restore_checkpoint(cp_b);
    let tb = from_b.poll(Cursor(1)).await.unwrap();
    assert_eq!(
        runs(&tb).len(),
        1,
        "B checkpoint vs A on disk: {:?}",
        tb.items
    );
    assert_eq!(runs(&tb)[0].data["build_log_lines"], 1);
    assert!(children(&tb).is_empty(), "no child changed: {:?}", tb.items);

    // Current A state either way: committed, so silent. Never a replay of A.
    for cp in [cp_a1, cp_a2] {
        let fresh = h.source();
        fresh.restore_checkpoint(cp);
        let b = fresh.poll(Cursor(1)).await.unwrap();
        assert!(b.items.is_empty(), "A replay: {:?}", b.items);
    }
}

#[tokio::test]
async fn harness_partial_log_tail_does_not_stall_later_rounds() {
    // A BUILD-LOG being written line by line leaves an unterminated tail. That tail must not pin the
    // sweep to this round: later rounds still get observed, and the completed line lands once.
    let h = Home::new(None);
    fs::write(h.rdir.join("BUILD-LOG.md"), "first\nsecond-part").unwrap();
    h.worker("alpha", false, false);

    let other = h.home.join("projects/dev/plans/p/_build/r2");
    fs::create_dir_all(other.join("workers")).unwrap();
    fs::write(other.join("BUILD-LOG.md"), "other\n").unwrap();

    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    // Round order follows `read_dir` order, which the harness does not promise; both rounds must appear.
    let mut sessions: Vec<&str> = runs(&b0).iter().map(|i| i.session.as_str()).collect();
    sessions.sort_unstable();
    assert_eq!(sessions, vec!["p/r1", "p/r2"], "both rounds in one pass");
    assert_eq!(runs(&b0)[0].data["build_log_lines"], 1);

    // Finish the line: exactly one new Run for r1 with the accumulated count, then silence.
    std::thread::sleep(Duration::from_millis(10));
    h.set_log("first\nsecond-partial\n");
    let b1 = src.poll(b0.next).await.unwrap();
    assert_eq!(runs(&b1).len(), 1, "completion: {:?}", b1.items);
    assert_eq!(runs(&b1)[0].session, "p/r1");
    assert_eq!(runs(&b1)[0].data["build_log_lines"], 2);
    let b2 = src.poll(b1.next).await.unwrap();
    assert!(b2.items.is_empty(), "settled: {:?}", b2.items);
}

#[tokio::test]
async fn harness_250_workers_drain_unique_children() {
    let h = Home::new(Some("log\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), true, false);
    }

    let src = h.source();
    let passes = drain(&src, Cursor(0), 20).await;
    let mut seen: Vec<String> = Vec::new();
    let mut run_workers: BTreeSet<u64> = BTreeSet::new();
    for b in &passes {
        assert!(
            b.items.len() <= MAX_FILES_PER_PASS,
            "pass emitted {} items (> {MAX_FILES_PER_PASS})",
            b.items.len()
        );
        for r in runs(b) {
            run_workers.insert(r.data["workers"].as_u64().unwrap());
        }
        seen.extend(child_names(b));
    }
    assert_eq!(seen.len(), 250, "child observations: {}", seen.len());
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 250, "duplicate child observations");
    for i in 0..250 {
        assert!(unique.contains(&format!("w{i:03}")), "missing w{i:03}");
    }
    assert!(
        passes.iter().any(|b| runs(b).len() == 1
            && runs(b)[0].data["workers"] == 250
            && runs(b)[0].data["done"] == 250),
        "a Run must report the full round aggregate: {:?}",
        run_workers
    );
    assert!(
        passes.len() >= 2,
        "250 workers must page over several passes"
    );
}

#[tokio::test]
async fn harness_restart_mid_drain_keeps_pending_workers() {
    let h = Home::new(Some("log\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), i % 2 == 0, false);
    }

    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let first: Vec<String> = child_names(&b0);
    assert!(!first.is_empty(), "first pass must emit children");
    assert!(first.len() < 250, "first pass must leave work pending");
    assert!(b0.items.len() <= MAX_FILES_PER_PASS);

    // Restart exactly where the drain stopped. A bounded turn may legitimately emit nothing (it is
    // re-observing already-delivered workers), so the loop continues until the source certifies a
    // complete, error-free census rather than stopping at the first empty page.
    let cp = src.checkpoint();
    drop(src);
    let resumed = h.source();
    resumed.restore_checkpoint(cp);
    let mut seen = first.clone();
    let mut cursor = b0.next;
    for pass in 0..40 {
        let b = resumed.poll(cursor).await.unwrap();
        cursor = b.next;
        assert!(b.items.len() <= MAX_FILES_PER_PASS);
        seen.extend(child_names(&b));
        if b.items.is_empty() && resumed.discovery_complete() {
            break;
        }
        assert!(pass < 39, "resumed drain did not settle in 40 pages");
    }
    assert_eq!(
        seen.len(),
        250,
        "observations after restart: {}",
        seen.len()
    );
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(
        unique.len(),
        250,
        "duplicate observations across the restart"
    );

    // And the resumed source is silent once the drain is complete.
    let again = resumed.poll(cursor).await.unwrap();
    assert!(again.items.is_empty(), "post-drain poll: {:?}", again.items);
    let restored = h.source();
    restored.restore_checkpoint(resumed.checkpoint());
    let silent = restored.poll(Cursor(1)).await.unwrap();
    assert!(
        silent.items.is_empty(),
        "post-drain restore: {:?}",
        silent.items
    );
}

#[tokio::test]
async fn harness_checkpoint_survives_the_persisted_shape() {
    // The store persists a checkpoint through JSON-shaped columns: the durable revision, the log
    // summary, the worker presence flags and the sweep cursor must all come back unchanged.
    let h = Home::new(Some("one\ntwo\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), i % 3 == 0, i % 5 == 0);
    }

    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let cp = src.checkpoint();
    let persisted = serde_json::to_string(&cp).unwrap();
    let restored_cp: SourceCheckpoint = serde_json::from_str(&persisted).unwrap();
    assert_eq!(restored_cp, cp, "checkpoint did not survive serialization");

    let resumed = h.source();
    resumed.restore_checkpoint(restored_cp);
    let mut seen = child_names(&b0);
    let mut cursor = b0.next;
    for pass in 0..40 {
        let b = resumed.poll(cursor).await.unwrap();
        cursor = b.next;
        seen.extend(child_names(&b));
        if b.items.is_empty() && resumed.discovery_complete() {
            break;
        }
        assert!(
            pass < 39,
            "drain after persistence did not settle in 40 pages"
        );
    }
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 250, "incomplete drain after persistence");
    assert_eq!(seen.len(), 250, "duplicates after persistence: {seen:?}");
    let last = resumed.poll(cursor).await.unwrap();
    assert!(last.items.is_empty(), "settled after persistence");
}

#[tokio::test]
async fn harness_empty_done_and_report_only_workers_round_trip() {
    let h = Home::new(Some("x\n"));
    h.worker("done_empty", true, false);
    h.worker("report_only", false, true);
    h.worker("bare", false, false);

    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let by_name: BTreeMap<String, (bool, bool)> = children(&b0)
        .iter()
        .map(|i| {
            (
                i.data["worker"].as_str().unwrap().to_string(),
                (
                    i.data["done"].as_bool().unwrap(),
                    i.data["report"].as_bool().unwrap(),
                ),
            )
        })
        .collect();
    assert_eq!(by_name["done_empty"], (true, false), "empty DONE = done");
    assert_eq!(by_name["report_only"], (false, true));
    assert_eq!(by_name["bare"], (false, false));
    assert_eq!(runs(&b0)[0].data["done"], 1);

    // Restore: the independent flags survive instead of being inferred from aggregate size.
    let cp = src.checkpoint();
    let fresh = h.source();
    fresh.restore_checkpoint(cp);
    let silent = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        silent.items.is_empty(),
        "unchanged restore: {:?}",
        silent.items
    );

    // Removing the report and adding a REPORT to the empty-DONE worker is reported once each.
    fs::remove_file(h.rdir.join("workers/report_only/REPORT.md")).unwrap();
    h.worker("done_empty", true, true);
    let b1 = fresh.poll(silent.next).await.unwrap();
    let changed: BTreeSet<String> = child_names(&b1).into_iter().collect();
    assert_eq!(
        changed,
        BTreeSet::from(["done_empty".to_string(), "report_only".to_string()]),
        "flags change once: {:?}",
        b1.items
    );
    let b2 = fresh.poll(b1.next).await.unwrap();
    assert!(b2.items.is_empty(), "settled: {:?}", b2.items);
}

#[tokio::test]
async fn harness_change_and_removal_during_partial_drain_are_not_lost() {
    let h = Home::new(Some("log\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), false, false);
    }

    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let first = child_names(&b0);
    assert!(!first.is_empty() && first.len() < 250, "partial drain");
    assert!(
        !src.discovery_complete(),
        "a partial drain certifies nothing"
    );
    let first_set: BTreeSet<String> = first.iter().cloned().collect();
    // The durable continuation is the greatest observed name of this page: names below it have
    // already been observed, so a change to one of them is genuinely "behind" the sweep.
    let changed = first_set.iter().next().cloned().unwrap();
    let removed_seen = first_set.iter().nth(first_set.len() / 2).cloned().unwrap();
    assert_ne!(changed, removed_seen);
    let removed_unseen = (0..250)
        .map(|i| format!("w{i:03}"))
        .find(|n| !first_set.contains(n) && *n != changed)
        .unwrap();

    // A worker behind the cursor changes, one already observed is removed, one this sweep never
    // observed is removed, and a new (later-sorting) worker appears.
    std::thread::sleep(Duration::from_millis(10));
    h.worker(&changed, true, false);
    fs::remove_dir_all(h.rdir.join(format!("workers/{removed_seen}"))).unwrap();
    fs::remove_dir_all(h.rdir.join(format!("workers/{removed_unseen}"))).unwrap();
    h.worker("w250", false, true);

    let mut seen: Vec<String> = first;
    let mut last_run: Option<serde_json::Value> = runs(&b0).first().map(|i| i.data.clone());
    let mut cursor = b0.next;
    let mut passes = 1;
    loop {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        passes += 1;
        let batch_children = child_names(&b);
        assert!(
            !batch_children.contains(&removed_seen) && !batch_children.contains(&removed_unseen),
            "a removed worker must never be re-reported: {batch_children:?}"
        );
        seen.extend(batch_children);
        for run in runs(&b) {
            // A partial aggregate is a lower-bound window, never a complete population claim.
            if run.data.get("partial").is_none() {
                last_run = Some(run.data.clone());
            }
        }
        if b.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(
            passes <= 40,
            "drain did not settle in 40 turns ({} observations)",
            seen.len()
        );
    }

    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert!(
        !unique.contains(&removed_unseen),
        "a worker removed before it was observed must not appear: {seen:?}"
    );
    assert!(unique.contains("w250"), "new worker not observed: {seen:?}");
    // The changed worker was observed once before its change and once after it; every other
    // surviving worker was observed exactly once.
    assert_eq!(
        seen.iter().filter(|n| **n == changed).count(),
        2,
        "{changed} must be re-observed exactly once after its change: {seen:?}"
    );
    assert_eq!(
        seen.iter().filter(|n| **n == removed_seen).count(),
        1,
        "{removed_seen} was observed before it disappeared: {seen:?}"
    );
    for name in unique
        .iter()
        .filter(|n| **n != changed && **n != removed_seen)
    {
        assert_eq!(
            seen.iter().filter(|s| *s == name).count(),
            1,
            "{name} observed more than once without changing: {seen:?}"
        );
    }
    let run = last_run.expect("a Run");
    assert_eq!(
        run["workers"], 249,
        "final run counts the surviving workers: {run:?}"
    );
    assert_eq!(run["done"], 1, "only {changed} has a DONE file: {run:?}");
}

// --------------------------------------------------------------------------------------------------- additions

/// Bounded pages: one scheduled turn (begin_turn -> detect -> poll -> end_turn) stays inside the shared
/// entry/visit/byte allowance, later turns keep making progress, and every worker is observed exactly once.
#[tokio::test]
async fn harness_pages_respect_the_shared_turn_allowance() {
    use agentglimd::core::{
        Env, TurnBudget, TURN_ALLOWANCE_BYTES, TURN_ALLOWANCE_ENTRIES, TURN_ALLOWANCE_VISITS,
    };
    let h = Home::new(Some("log\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), i % 2 == 0, false);
    }
    let env = Env {
        home: h.home.clone(),
        vars: Default::default(),
    };

    let src = h.source();
    let mut cursor = Cursor(0);
    let mut passes = 0;
    let mut seen: Vec<String> = Vec::new();
    let mut complete_run: Option<serde_json::Value> = None;
    loop {
        passes += 1;
        assert!(passes <= 20, "drain did not settle within 20 turns");
        let before = src.work_stats();
        // Exactly what core does for one scheduled turn: one budget, detect (when due) and poll share it.
        let budget = TurnBudget::default_allowance();
        src.begin_turn(budget.clone());
        if passes == 1 {
            assert!(matches!(
                src.detect(&env),
                agentglimd::core::Detection::Detected { .. }
            ));
        }
        let batch = src.poll(cursor).await.unwrap();
        src.end_turn();
        cursor = batch.next;

        let after = src.work_stats();
        let entries = after.entries - before.entries;
        let visits = after.file_visits - before.file_visits;
        assert!(
            entries <= TURN_ALLOWANCE_ENTRIES,
            "turn {passes} returned {entries} directory entries (> {TURN_ALLOWANCE_ENTRIES})"
        );
        assert!(
            visits <= TURN_ALLOWANCE_VISITS,
            "turn {passes} made {visits} file/work visits (> {TURN_ALLOWANCE_VISITS})"
        );
        assert!(
            budget.used() <= TURN_ALLOWANCE_BYTES,
            "turn {passes} charged {} content bytes (> {TURN_ALLOWANCE_BYTES})",
            budget.used()
        );
        assert!(
            entries > 0 || !batch.items.is_empty() || src.discovery_complete(),
            "turn {passes} neither advanced nor settled: a bounded sweep must make progress"
        );
        seen.extend(child_names(&batch));
        for run in runs(&batch) {
            if run.data.get("partial").is_none() {
                complete_run = Some(run.data.clone());
            }
        }
        if batch.items.is_empty() && src.discovery_complete() {
            break;
        }
    }

    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 250, "every worker observed: {}", unique.len());
    assert_eq!(seen.len(), 250, "duplicate observations: {seen:?}");
    let run = complete_run.expect("a complete aggregate after the sweep");
    assert_eq!(run["workers"], 250);
    assert_eq!(run["done"], 125);
    assert!(
        passes >= 2,
        "250 workers must page over several bounded turns, not one unbounded pass"
    );
}

/// An incomplete census is emitted as an explicitly partial aggregate with coverage, and never as a
/// complete population; completion is a material observation that appears exactly once.
#[tokio::test]
async fn harness_partial_census_is_marked_with_coverage() {
    let h = Home::new(Some("line 1\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), true, false);
    }
    let src = h.source();
    let first = src.poll(Cursor(0)).await.unwrap();
    let first_children = children(&first).len();
    assert!(
        first_children > 0 && first_children < 250,
        "partial first page"
    );
    let first_runs = runs(&first);
    assert_eq!(first_runs.len(), 1, "one aggregate per round per page");
    let data = &first_runs[0].data;
    assert_eq!(
        data["partial"], true,
        "an incomplete aggregate must be marked partial: {data}"
    );
    let coverage = &data["coverage"];
    assert!(
        coverage.is_object(),
        "an incomplete aggregate must carry coverage: {data}"
    );
    let observed = coverage["observed"].as_u64().unwrap();
    assert_eq!(
        observed,
        data["workers"].as_u64().unwrap(),
        "a partial aggregate reports the observations of its own sweep window: {data}"
    );
    assert!(
        coverage["known"].as_u64().unwrap() >= observed,
        "known state is a superset of this window: {data}"
    );
    assert_eq!(coverage["errors"], false);
    assert_ne!(
        data["workers"].as_u64().unwrap(),
        250,
        "the population must not be claimed before it is observed: {data}"
    );

    let mut cursor = first.next;
    let mut complete_runs = 0usize;
    let mut observed_children: BTreeSet<String> = child_names(&first).into_iter().collect();
    let mut passes = 1;
    loop {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        passes += 1;
        observed_children.extend(child_names(&batch));
        for run in runs(&batch) {
            match run.data.get("partial") {
                Some(Value::Bool(true)) => {
                    assert!(
                        run.data.get("coverage").is_some(),
                        "partial aggregate without coverage: {}",
                        run.data
                    );
                    assert!(
                        run.data["workers"].as_u64().unwrap() < 250,
                        "a partial aggregate claimed the full population: {}",
                        run.data
                    );
                }
                _ => {
                    complete_runs += 1;
                    assert_eq!(run.data["workers"], 250);
                    assert_eq!(run.data["done"], 250);
                }
            }
        }
        if batch.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(passes <= 40, "drain did not settle");
    }
    assert_eq!(complete_runs, 1, "completion must be observed exactly once");
    assert_eq!(observed_children.len(), 250);
    assert_eq!(src.checkpoint().files.len(), 1 + 250, "log + every worker");
}

/// A partial or restored sweep never certifies absence, never drops a known path and never duplicates
/// an observation; only a complete error-free sweep reconciles the population.
#[tokio::test]
async fn harness_interrupted_sweep_never_certifies_absence() {
    let h = Home::new(Some("log\n"));
    for i in 0..120 {
        h.worker(&format!("w{i:03}"), false, false);
    }
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!child_names(&b0).is_empty(), "some workers observed");
    assert!(
        !src.discovery_complete(),
        "a partial census must not certify absence"
    );
    let known: BTreeSet<String> = src
        .checkpoint()
        .files
        .iter()
        .filter(|f| f.path.contains("/workers/"))
        .map(|f| f.path.clone())
        .collect();
    assert!(!known.is_empty());

    let resumed = h.source();
    resumed.restore_checkpoint(src.checkpoint());
    assert!(
        !resumed.discovery_complete(),
        "a restored interrupted sweep must not certify absence"
    );
    let b1 = resumed.poll(b0.next).await.unwrap();
    let after: BTreeSet<String> = resumed
        .checkpoint()
        .files
        .iter()
        .filter(|f| f.path.contains("/workers/"))
        .map(|f| f.path.clone())
        .collect();
    for path in &known {
        assert!(
            after.contains(path),
            "a partial sweep dropped a known path: {path}"
        );
    }
    assert!(!resumed.discovery_complete());

    let mut seen: Vec<String> = child_names(&b0);
    seen.extend(child_names(&b1));
    let mut cursor = b1.next;
    let mut passes = 2;
    loop {
        let batch = resumed.poll(cursor).await.unwrap();
        cursor = batch.next;
        passes += 1;
        seen.extend(child_names(&batch));
        if batch.items.is_empty() && resumed.discovery_complete() {
            break;
        }
        assert!(passes <= 40, "drain did not settle");
    }
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 120, "all workers observed across the restart");
    assert_eq!(seen.len(), 120, "duplicate observations: {seen:?}");
}

/// Removing and inserting workers while a bounded sweep is in flight may not produce a false removal:
/// only the complete aggregate reflects the surviving population.
#[tokio::test]
async fn harness_removal_reconciles_only_at_a_complete_sweep() {
    let h = Home::new(Some("log\n"));
    for i in 0..200 {
        h.worker(&format!("w{i:03}"), false, false);
    }
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!src.discovery_complete());
    let observed = child_names(&b0);
    assert!(observed.len() < 200);
    let victims: Vec<String> = (0..200)
        .map(|i| format!("w{i:03}"))
        .filter(|n| !observed.contains(n))
        .take(5)
        .collect();
    assert_eq!(victims.len(), 5);
    for victim in &victims {
        fs::remove_dir_all(h.rdir.join(format!("workers/{victim}"))).unwrap();
    }
    h.worker("w999", false, true);

    let mut seen = observed;
    let mut cursor = b0.next;
    let mut passes = 1;
    let mut complete_runs = 0usize;
    let mut last_complete: Option<Value> = None;
    loop {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        passes += 1;
        let batch_children = child_names(&batch);
        for victim in &victims {
            assert!(
                !batch_children.contains(victim),
                "a worker removed while scanning must not be re-reported: {victim}"
            );
        }
        seen.extend(batch_children);
        for run in runs(&batch) {
            if run.data.get("partial").is_some() {
                assert!(
                    run.data.get("coverage").is_some(),
                    "partial aggregate without coverage: {}",
                    run.data
                );
            } else {
                complete_runs += 1;
                // 200 - 5 removed (+ the 1 inserted once its sweep observed it). A complete
                // aggregate may never count a removed worker as live.
                assert!(
                    run.data["workers"].as_u64().unwrap() <= 196,
                    "a complete aggregate counted removed workers: {}",
                    run.data
                );
                if run.data["workers"] == 196 {
                    last_complete = Some(run.data.clone());
                }
            }
        }
        if batch.items.is_empty()
            && src.discovery_complete()
            && last_complete.as_ref().is_some_and(|r| r["workers"] == 196)
        {
            break;
        }
        assert!(passes <= 40, "drain did not settle");
    }
    assert!(
        complete_runs >= 1,
        "a complete aggregate after reconciliation"
    );
    assert_eq!(
        last_complete.expect("the settled complete aggregate")["workers"],
        196,
        "the settled population is 200 - 5 removed + 1 inserted"
    );
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert!(unique.contains("w999"), "the inserted worker was observed");
    for victim in &victims {
        assert!(
            !unique.contains(victim),
            "removed worker appeared: {victim}"
        );
    }
}

/// A directory that cannot be read is not evidence of deletion: the census stays unproven, every known
/// path survives the checkpoint, and nothing is re-reported once access returns.
#[tokio::test]
async fn harness_unreadable_workers_dir_does_not_imply_deletion() {
    use std::os::unix::fs::PermissionsExt;

    let h = Home::new(Some("log\n"));
    for i in 0..80 {
        h.worker(&format!("w{i:03}"), i % 2 == 0, false);
    }
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let first = child_names(&b0);
    assert!(!first.is_empty());
    let known: BTreeSet<String> = src
        .checkpoint()
        .files
        .iter()
        .filter(|f| f.path.contains("/workers/"))
        .map(|f| f.path.clone())
        .collect();

    let workers_dir = h.rdir.join("workers");
    let restore = fs::metadata(&workers_dir).unwrap().permissions();
    let mut deny = restore.clone();
    deny.set_mode(0o000);
    fs::set_permissions(&workers_dir, deny).unwrap();

    let mut cursor = b0.next;
    let mut passes = 1;
    for _ in 0..3 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        passes += 1;
        assert!(
            !src.discovery_complete(),
            "an unreadable sweep must not certify absence"
        );
        assert!(
            child_names(&batch).is_empty(),
            "unreadable discovery is not an observation: {:?}",
            batch.items
        );
    }
    let after: BTreeSet<String> = src
        .checkpoint()
        .files
        .iter()
        .filter(|f| f.path.contains("/workers/"))
        .map(|f| f.path.clone())
        .collect();
    for path in &known {
        assert!(
            after.contains(path),
            "an unreadable sweep dropped a known path: {path}"
        );
    }

    fs::set_permissions(&workers_dir, restore).unwrap();
    let mut seen: Vec<String> = first;
    let mut complete: Option<serde_json::Value> = None;
    loop {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        passes += 1;
        seen.extend(child_names(&batch));
        for run in runs(&batch) {
            if run.data.get("partial").is_none() {
                complete = Some(run.data.clone());
            }
        }
        if batch.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(passes <= 60, "drain did not settle after access returned");
    }
    let run = complete.expect("a complete aggregate once the directory is readable again");
    assert_eq!(run["workers"], 80);
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 80);
    let duplicates = seen.len() - unique.len();
    assert_eq!(
        duplicates, 0,
        "an error must not cause a worker to be observed twice: {seen:?}"
    );
}

// --------------------------------------------------- v5-r2 T04: error safety, identity, bounded bookkeeping

/// Builds a plan/round directory tree under the same home, independent of the fixture helpers above.
fn make_round(h: &Home, plan: &str, round: &str, log: Option<&str>) -> PathBuf {
    let d = h
        .home
        .join(format!("projects/dev/plans/{plan}/_build/{round}"));
    fs::create_dir_all(d.join("workers")).unwrap();
    if let Some(text) = log {
        fs::write(d.join("BUILD-LOG.md"), text).unwrap();
    }
    d
}

fn make_worker(round_dir: &std::path::Path, name: &str, done: bool, report: bool) {
    let d = round_dir.join("workers").join(name);
    fs::create_dir_all(&d).unwrap();
    if done {
        fs::write(d.join("DONE"), "").unwrap();
    }
    if report {
        fs::write(d.join("REPORT.md"), "done\n").unwrap();
    }
}

/// Producer identity must be one-to-one with `Batch::items`, unique per accepted observation and
/// absent for an unchanged poll or an unchanged restart.
fn assert_identity_alignment(src: &plans_harness::PlansHarness, batch: &Batch) {
    let ids = src.identities();
    assert_eq!(
        ids.len(),
        batch.items.len(),
        "identities must be aligned 1:1 with the batch items"
    );
    for (id, item) in ids.iter().zip(batch.items.iter()) {
        let key = id.key();
        assert!(
            key.starts_with("rev\u{1f}"),
            "a snapshot observation needs a revision identity, got {key}"
        );
        assert!(
            key.contains(&format!("\u{1f}{}/", item.session)),
            "identity {key} must name the round namespace of {}/{}",
            item.session,
            item.kind as u8
        );
    }
    let keys: BTreeSet<String> = ids.iter().map(|i| i.key()).collect();
    assert_eq!(
        keys.len(),
        ids.len(),
        "two observations of one batch shared a producer identity"
    );
}

/// An unreadable plan `_build` is not evidence of deletion: the census stays unproven, the plan keeps
/// its durable round/worker state, nothing is re-reported, and the population is rediscovered once access
/// returns. `chmod` limitation: an EACCES directory can only be produced for a non-root test user, so this
/// proves the adapter's error handling, not a universal permission model.
#[tokio::test]
async fn harness_unreadable_build_dir_does_not_certify_or_remove() {
    use std::os::unix::fs::PermissionsExt;

    let h = Home::new(Some("plan p log\n"));
    h.worker("alpha", true, false);
    let q = make_round(&h, "q", "r1", Some("plan q log\n"));
    for i in 0..80 {
        make_worker(&q, &format!("q{i:02}"), i % 2 == 0, false);
    }

    // One bounded page: q's census is interrupted mid-sweep (a partial aggregate is owed), so a later
    // completion aggregate is a real acceptance condition rather than an artefact.
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_identity_alignment(&src, &b0);
    assert!(!src.discovery_complete(), "the first page is incomplete");
    let q_paths: BTreeSet<String> = src
        .checkpoint()
        .files
        .iter()
        .filter(|f| f.path.starts_with("q/"))
        .map(|f| f.path.clone())
        .collect();
    assert_eq!(q_paths.len(), 81, "q: one log row and 80 worker rows");

    let build = h.home.join("projects/dev/plans/q/_build");
    let restore = fs::metadata(&build).unwrap().permissions();
    let mut deny = restore.clone();
    deny.set_mode(0o000);
    fs::set_permissions(&build, deny).unwrap();

    let mut cursor = b0.next;
    for pass in 0..3 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert_identity_alignment(&src, &b);
        assert!(
            !src.discovery_complete(),
            "an unreadable _build must not certify a complete census (pass {pass})"
        );
        assert!(
            child_names(&b).is_empty(),
            "an unreadable plan is not an observation: {:?}",
            b.items
        );
        for run in runs(&b) {
            // Any aggregate emitted while the traversal is unproven must say so.
            assert_eq!(
                run.data["coverage"]["errors"], true,
                "an aggregate from an unproven traversal must carry the error: {}",
                run.data
            );
            assert_eq!(run.data["coverage"]["total_known"], false);
        }
        let after: BTreeSet<String> = src
            .checkpoint()
            .files
            .iter()
            .filter(|f| f.path.starts_with("q/"))
            .map(|f| f.path.clone())
            .collect();
        for path in &q_paths {
            assert!(
                after.contains(path),
                "an unreadable _build dropped known state: {path}"
            );
        }
    }

    fs::set_permissions(&build, restore).unwrap();
    let mut seen: Vec<String> = child_names(&b0);
    let mut complete: Option<Value> = None;
    let mut passes = 0;
    loop {
        passes += 1;
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert_identity_alignment(&src, &b);
        seen.extend(child_names(&b));
        for run in runs(&b) {
            if run.data.get("partial").is_none() && run.session == "q/r1" {
                complete = Some(run.data.clone());
            }
        }
        if b.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(passes <= 80, "drain did not settle after access returned");
    }
    let run = complete.expect("q's complete aggregate once _build is readable again");
    assert_eq!(run["workers"], 80, "q: {run}");
    assert_eq!(run["done"], 40, "q: {run}");
    let q_seen: Vec<String> = seen
        .iter()
        .filter(|n| n.starts_with('q'))
        .cloned()
        .collect();
    let unique: BTreeSet<String> = q_seen.iter().cloned().collect();
    assert_eq!(
        unique.len(),
        80,
        "the recovered census re-observed every worker"
    );
    assert_eq!(q_seen.len(), 80, "no duplicate observation after recovery");
    assert!(
        seen.contains(&"alpha".to_string()),
        "the readable plan kept being observed"
    );
}

/// An uninspectable `DONE`/`REPORT.md` is unproven, never `done:false`: the sweep stops, the durable flags
/// are kept, no child is emitted with a guessed flag, and an aggregate emitted from the unproven sweep
/// declares the error instead of claiming a population.
#[tokio::test]
async fn harness_marker_stat_error_is_unproven_not_absent() {
    use std::os::unix::fs::PermissionsExt;

    let h = Home::new(Some("log\n"));
    for i in 0..80 {
        h.worker(&format!("w{i:02}"), i % 2 == 0, false);
    }
    // One bounded page: 64 of 80 workers observed, all 80 known, a partial aggregate owed.
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let before: BTreeMap<String, String> = src
        .checkpoint()
        .files
        .into_iter()
        .filter(|f| f.path.contains("/workers/"))
        .map(|f| (f.path, f.fingerprint))
        .collect();
    assert_eq!(
        before.len(),
        80,
        "the enumeration knows the whole population"
    );

    // A worker this sweep has not observed yet (`w70` sorts after the 64 observed names), so the failing
    // observation is a live marker stat. The worker directory itself stays readable: only the marker
    // inside it becomes uninspectable, so the directory stat still succeeds.
    let wdir = h.rdir.join("workers/w70");
    let restore = fs::metadata(&wdir).unwrap().permissions();
    let mut deny = restore.clone();
    deny.set_mode(0o000);
    fs::set_permissions(&wdir, deny).unwrap();

    let mut cursor = b0.next;
    let mut seen: Vec<String> = child_names(&b0);
    for pass in 0..3 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert!(!src.discovery_complete(), "pass {pass}: unproven census");
        assert!(
            !child_names(&b).contains(&"w70".to_string()),
            "an uninspectable marker must not be reported: {:?}",
            b.items
        );
        for run in runs(&b) {
            assert_eq!(
                run.data["coverage"]["errors"], true,
                "an aggregate from an unproven sweep must say so: {}",
                run.data
            );
        }
        // Observations the errored sweep did make before the failing marker are real and delivered.
        seen.extend(child_names(&b));
    }
    let after: BTreeMap<String, String> = src
        .checkpoint()
        .files
        .into_iter()
        .filter(|f| f.path.contains("/workers/"))
        .map(|f| (f.path, f.fingerprint))
        .collect();
    assert_eq!(after.len(), 80, "an unproven sweep dropped a known worker");
    for i in 0..80 {
        let path = format!("p/_build/r1/workers/w{i:02}/DONE");
        let proven = if i % 2 == 0 { "d1r0" } else { "d0r0" };
        let now = after
            .get(&path)
            .unwrap_or_else(|| panic!("{path} vanished"));
        assert!(
            now == &before[&path] || now == proven,
            "a worker's durable flags may only hold a definite observation: {path} {now}"
        );
    }
    assert_eq!(
        after[&"p/_build/r1/workers/w70/DONE".to_string()],
        before[&"p/_build/r1/workers/w70/DONE".to_string()],
        "the unproven marker stat must keep the prior state instead of a guessed done=false"
    );

    fs::set_permissions(&wdir, restore).unwrap();
    let mut complete: Option<Value> = None;
    let mut passes = 0;
    loop {
        passes += 1;
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        seen.extend(child_names(&b));
        for run in runs(&b) {
            if run.data.get("partial").is_none() {
                complete = Some(run.data.clone());
            }
        }
        if b.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(passes <= 80, "drain did not settle after access returned");
    }
    let run = complete.expect("a complete aggregate once the marker is inspectable");
    assert_eq!(run["workers"], 80);
    assert_eq!(run["done"], 40);
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 80);
    assert_eq!(
        seen.len(),
        80,
        "the error must not duplicate an observation"
    );
}

/// A change made to a worker the interrupted sweep had already passed is still observed after a restart:
/// the resumed sweep re-enumerates the whole population instead of trusting the old cursor.
#[tokio::test]
async fn harness_change_below_resumed_cursor_is_observed_after_restart() {
    let h = Home::new(Some("log\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), false, false);
    }
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let first = child_names(&b0);
    assert!(
        !first.is_empty() && first.len() < 250,
        "a bounded first page"
    );
    assert!(!src.discovery_complete());
    let cp = src.checkpoint();

    // The lowest observed name is unambiguously behind the durable sweep cursor. Change it while the
    // process is down.
    let below = first.iter().min().cloned().unwrap();
    std::thread::sleep(Duration::from_millis(10));
    h.worker(&below, true, false);

    let resumed = h.source();
    resumed.restore_checkpoint(cp);
    assert!(
        !resumed.discovery_complete(),
        "a restored interrupted sweep never certifies absence"
    );
    let mut seen: Vec<String> = first;
    let mut cursor = b0.next;
    let mut done_of_below: Option<bool> = None;
    let mut complete: Option<Value> = None;
    let mut passes = 0;
    loop {
        passes += 1;
        let b = resumed.poll(cursor).await.unwrap();
        cursor = b.next;
        seen.extend(child_names(&b));
        for child in children(&b) {
            if child.data["worker"] == below.as_str() {
                done_of_below = Some(child.data["done"].as_bool().unwrap());
            }
        }
        for run in runs(&b) {
            if run.data.get("partial").is_none() {
                complete = Some(run.data.clone());
            }
        }
        if b.items.is_empty() && resumed.discovery_complete() {
            break;
        }
        assert!(passes <= 60, "the resumed sweep did not settle");
    }
    assert_eq!(
        done_of_below,
        Some(true),
        "a DONE that appeared below the old cursor while the process was down must be observed"
    );
    let run = complete.expect("a complete aggregate after the restart");
    assert_eq!(run["workers"], 250);
    assert_eq!(run["done"], 1, "exactly one worker has DONE: {run}");
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(
        unique.len(),
        250,
        "every worker observed across the restart"
    );
    assert_eq!(
        seen.iter().filter(|n| **n == below).count(),
        2,
        "{below} was observed once before its change and once after it: {seen:?}"
    );
    assert_eq!(seen.len(), 251, "only the changed worker is re-observed");
}

/// Producer identities: one per emitted item, distinct per accepted revision (A->B->A keeps three),
/// nothing at all for an unchanged poll or restart, and no restart-inflated identity.
#[tokio::test]
async fn harness_producer_identities_are_unique_and_absent_when_unchanged() {
    let h = Home::new(Some("A\n"));
    h.worker("alpha", true, false);
    h.worker("beta", false, true);

    let src = h.source();
    let ba = src.poll(Cursor(0)).await.unwrap();
    assert_identity_alignment(&src, &ba);
    let a1: Vec<String> = src.identities().iter().map(|i| i.key()).collect();
    assert_eq!(a1.len(), ba.items.len());
    assert_eq!(a1.len(), 3, "one aggregate + two children: {:?}", ba.items);

    // Unchanged poll: no items, therefore no identities.
    let quiet = src.poll(ba.next).await.unwrap();
    assert!(quiet.items.is_empty(), "unchanged poll: {:?}", quiet.items);
    assert!(
        src.identities().is_empty(),
        "an unchanged poll must not claim producer identities"
    );

    // A -> B -> A on the durable log content: three distinct aggregate revisions.
    std::thread::sleep(Duration::from_millis(10));
    h.set_log("B\n");
    let bb = src.poll(ba.next).await.unwrap();
    assert_identity_alignment(&src, &bb);
    let b_ids: Vec<String> = src.identities().iter().map(|i| i.key()).collect();
    std::thread::sleep(Duration::from_millis(10));
    h.set_log("A\n");
    let ba2 = src.poll(bb.next).await.unwrap();
    assert_identity_alignment(&src, &ba2);
    let a2_ids: Vec<String> = src.identities().iter().map(|i| i.key()).collect();

    let all: BTreeSet<&String> = a1.iter().chain(b_ids.iter()).chain(a2_ids.iter()).collect();
    assert_eq!(
        all.len(),
        a1.len() + b_ids.len() + a2_ids.len(),
        "A->B->A reused a producer identity: {a1:?} {b_ids:?} {a2_ids:?}"
    );
    assert!(
        b_ids.iter().all(|k| k.contains("/run\u{1f}"))
            && a2_ids.iter().all(|k| k.contains("/run\u{1f}")),
        "log-only changes emit aggregate identities only"
    );

    // Restart at the committed A state: silent, no identities, and the counters continue instead of
    // replaying a consumed revision.
    let cp = src.checkpoint();
    let fresh = h.source();
    fresh.restore_checkpoint(cp);
    let rb = fresh.poll(Cursor(1)).await.unwrap();
    assert!(rb.items.is_empty(), "unchanged restart: {:?}", rb.items);
    assert!(fresh.identities().is_empty());
    std::thread::sleep(Duration::from_millis(10));
    h.set_log("C\n");
    let bz = fresh.poll(rb.next).await.unwrap();
    assert_identity_alignment(&fresh, &bz);
    let c_ids: Vec<String> = fresh.identities().iter().map(|i| i.key()).collect();
    assert_eq!(c_ids.len(), 1);
    for previous in a1.iter().chain(b_ids.iter()).chain(a2_ids.iter()) {
        assert_ne!(
            &c_ids[0], previous,
            "a revision identity already committed before the restart was reused"
        );
    }
}

/// Every batch puts its changed `Child` observations before the `Run` aggregate that counts them, and
/// a completion that observes no changed child still publishes the aggregate.
#[tokio::test]
async fn harness_children_precede_the_aggregate_and_completion_stands_alone() {
    let h = Home::new(Some("log\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), i % 2 == 0, false);
    }
    let src = h.source();
    let mut cursor = Cursor(0);
    let mut passes = 0;
    let mut complete: Option<Value> = None;
    let mut seen: Vec<String> = Vec::new();
    loop {
        passes += 1;
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        let last_child = b.items.iter().rposition(|i| i.kind == ItemKind::Child);
        for (idx, item) in b.items.iter().enumerate() {
            if item.kind == ItemKind::Run {
                if let Some(last) = last_child {
                    assert!(
                        idx > last,
                        "an aggregate at {idx} precedes its children (last child {last}): {:?}",
                        b.items
                    );
                }
            }
        }
        seen.extend(child_names(&b));
        for run in runs(&b) {
            if run.data.get("partial").is_none() {
                complete = Some(run.data.clone());
            }
        }
        if b.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(passes <= 40, "drain did not settle");
    }
    let run = complete.expect("a complete aggregate");
    assert_eq!(run["workers"], 250);
    assert_eq!(run["done"], 125);
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 250);
    assert_eq!(seen.len(), 250, "no duplicate child observations");

    // A completed sweep whose whole population disappeared is a completion observation on its own:
    // the aggregate is published with no changed child in the batch.
    for i in 0..250 {
        fs::remove_dir_all(h.rdir.join(format!("workers/w{i:03}"))).unwrap();
    }
    let mut empty_aggregate: Option<Value> = None;
    let mut standalone = false;
    let mut after = 0;
    loop {
        after += 1;
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        if !b.items.is_empty() {
            for run in runs(&b) {
                if run.data.get("partial").is_none() {
                    empty_aggregate = Some(run.data.clone());
                    standalone = b.items.iter().all(|i| i.kind == ItemKind::Run);
                }
            }
        }
        if b.items.is_empty() && src.discovery_complete() {
            break;
        }
        assert!(
            after <= 40,
            "drain did not settle after the population vanished"
        );
    }
    let agg = empty_aggregate.expect("the vanished population must be a completion observation");
    assert_eq!(agg["workers"], 0, "no worker survives: {agg}");
    assert_eq!(agg["done"], 0);
    assert!(
        standalone,
        "a completion with no changed child must be a valid standalone aggregate"
    );
}

/// A BUILD-LOG read is charged work whose returned content bytes are reported: `payload_bytes` is the
/// prefix sample plus the log bytes actually returned, never zero.
#[tokio::test]
async fn harness_build_log_reads_report_payload_bytes() {
    let body = "one\ntwo\nthree\n";
    let h = Home::new(Some(body));
    h.worker("alpha", false, false);
    let src = h.source();
    let before = src.work_stats();
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(!b.items.is_empty(), "a first observation emits");
    let after = src.work_stats();
    let size = body.len() as u64;
    // The full-content witness reads the BUILD-LOG exactly once: the line count and the SHA-256 come from the
    // same bytes, so there is no separate prefix sample (v5 charged size + 256 here).
    let expected = size;
    assert_eq!(
        after.payload_bytes - before.payload_bytes,
        expected,
        "payload_bytes must be the returned BUILD-LOG content bytes ({expected})"
    );
    assert!(after.payload_bytes > 0, "a BUILD-LOG read is content work");
}

/// The 250-worker population survives a serialized committed checkpoint taken mid-sweep: partial
/// first, then one complete 250/250 aggregate, 250 unique children and silence afterwards.
#[tokio::test]
async fn harness_restart_mid_sweep_reaches_250_with_one_completion() {
    let h = Home::new(Some("line 1\n"));
    for i in 0..250 {
        h.worker(&format!("w{i:03}"), true, false);
    }
    let src = h.source();
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let partial = runs(&b0);
    assert_eq!(partial.len(), 1, "one aggregate on the first bounded page");
    assert_eq!(partial[0].data["partial"], true);
    assert!(
        partial[0].data["workers"].as_u64().unwrap() < 250,
        "a bounded page cannot claim the whole population: {}",
        partial[0].data
    );
    let cp = serde_json::to_string(&src.checkpoint()).unwrap();
    drop(src);

    let resumed = h.source();
    resumed.restore_checkpoint(serde_json::from_str(&cp).unwrap());
    let mut seen: Vec<String> = child_names(&b0);
    let mut cursor = b0.next;
    let mut complete_runs: Vec<Value> = Vec::new();
    let mut completion_ids: Vec<String> = Vec::new();
    let mut passes = 0;
    loop {
        passes += 1;
        let b = resumed.poll(cursor).await.unwrap();
        assert_identity_alignment(&resumed, &b);
        cursor = b.next;
        seen.extend(child_names(&b));
        for (idx, run) in b.items.iter().enumerate() {
            if run.kind != ItemKind::Run || run.data.get("partial").is_some() {
                continue;
            }
            complete_runs.push(run.data.clone());
            completion_ids.push(resumed.identities()[idx].key());
        }
        if b.items.is_empty() && resumed.discovery_complete() {
            break;
        }
        assert!(passes <= 60, "the resumed sweep did not settle in 60 pages");
    }
    assert_eq!(complete_runs.len(), 1, "exactly one completion aggregate");
    assert_eq!(complete_runs[0]["workers"], 250);
    assert_eq!(complete_runs[0]["done"], 250);
    let unique: BTreeSet<String> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 250, "all 250 workers after the restart");
    assert_eq!(seen.len(), 250, "no duplicate child across the restart");

    // The completion revision is stable: a further unchanged turn emits nothing, and restoring the
    // final checkpoint is silent at every level.
    let quiet = resumed.poll(cursor).await.unwrap();
    assert!(
        quiet.items.is_empty(),
        "post-completion poll: {:?}",
        quiet.items
    );
    let final_cp = resumed.checkpoint();
    let again = h.source();
    again.restore_checkpoint(final_cp);
    let silent = again.poll(Cursor(1)).await.unwrap();
    assert!(
        silent.items.is_empty(),
        "unchanged restart re-emitted: {:?}",
        silent.items
    );
    assert!(again.identities().is_empty());
    assert_eq!(completion_ids.len(), 1);
}

// ============================================================================================ v5-r3
// v5-r2 AUDIT §2.1 / §2.3: durable retired-round identity and bounded round selection.
//
// A removed round keeps its Run/Child revision high-water as *retired revision state* (never as an active
// path), so a reappearance issues fresh, monotonically increasing producer identities instead of reusing
// keys SQLite already deduplicated. The priority selection and the discovery certification are bounded:
// a page inspects only the rounds it newly discovered, and the error evidence is a maintained counter.

/// One bounded scheduled turn, exactly as core runs it: one shared allowance for `detect` (when due) and
/// `poll`, with the producer keys and application counters of that turn.
struct TurnResult {
    batch: Batch,
    keys: Vec<String>,
    entries: u64,
    visits: u64,
    bytes: u64,
}

async fn one_turn(src: &plans_harness::PlansHarness, cursor: Cursor) -> TurnResult {
    use agentglimd::core::TurnBudget;
    let before = src.work_stats();
    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    let batch = src.poll(cursor).await.unwrap();
    let keys = src.identities().iter().map(|k| k.key()).collect();
    src.end_turn();
    let after = src.work_stats();
    TurnResult {
        batch,
        keys,
        entries: after.entries - before.entries,
        visits: after.file_visits - before.file_visits,
        bytes: budget.used(),
    }
}

/// Session names present in a checkpoint's file list (an absent round must not keep any active path).
fn checkpoint_sessions(cp: &SourceCheckpoint) -> BTreeSet<String> {
    cp.files.iter().filter_map(|f| f.session.clone()).collect()
}

/// The durable retired high-water entry of one session, decoded from its revision token.
fn retired_entry(cp: &SourceCheckpoint, session: &str) -> Option<Value> {
    cp.revisions
        .get(&format!("retired@{session}"))
        .map(|raw| serde_json::from_str::<Value>(raw).unwrap())
}

/// Polls until `done` holds (bounded), returning every batch emitted on the way.
async fn poll_until(
    src: &plans_harness::PlansHarness,
    cursor: &mut Cursor,
    max_turns: usize,
    what: &str,
    done: impl Fn(&plans_harness::PlansHarness) -> bool,
) -> Vec<Batch> {
    let mut out = Vec::new();
    for _ in 0..max_turns {
        let t = one_turn(src, *cursor).await;
        *cursor = t.batch.next;
        out.push(t.batch);
        if done(src) {
            return out;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("{what} did not happen within {max_turns} bounded turns");
}

/// A round removed and then restored must not recycle a producer key: the reappearance is a new
/// occurrence with fresh identities, and while the round is absent only retired revision state remains
/// (no active path, no worker row, no log offset).
#[tokio::test]
async fn harness_removed_round_reappearance_uses_fresh_producer_keys() {
    let h = Home::new(Some("log\n"));
    h.worker("w0", true, false);
    h.worker("w1", true, false);
    let q = make_round(&h, "q", "r1", Some("log\n"));
    make_worker(&q, "q0", true, false);

    let src = h.source();
    let mut cursor = Cursor(0);
    let mut keys: Vec<String> = Vec::new();
    let mut child_keys: Vec<String> = Vec::new();
    let mut child_names_seen: Vec<String> = Vec::new();

    // 1. Complete initial observation of p/r1 (two DONE children, two/two aggregate).
    let mut initial_complete: Option<Value> = None;
    for _ in 0..60 {
        let t = one_turn(&src, cursor).await;
        assert_identity_alignment(&src, &t.batch);
        cursor = t.batch.next;
        keys.extend(t.keys.clone());
        for (idx, item) in t.batch.items.iter().enumerate() {
            if item.session != "p/r1" {
                continue;
            }
            match item.kind {
                ItemKind::Child => {
                    child_keys.push(t.keys[idx].clone());
                    child_names_seen.push(item.data["worker"].as_str().unwrap().to_string());
                }
                ItemKind::Run if item.data.get("partial").is_none() => {
                    initial_complete = Some(item.data.clone())
                }
                _ => {}
            }
        }
        if initial_complete.is_some() && src.discovery_complete() {
            break;
        }
    }
    let initial_complete = initial_complete.expect("a complete initial aggregate for p/r1");
    assert_eq!(initial_complete["workers"], 2);
    assert_eq!(initial_complete["done"], 2);
    assert_eq!(child_names_seen.len(), 2, "two initial children");

    // 2. Remove the whole round and let its absence be committed.
    let parked = h._t.path().join("parked-r1");
    fs::rename(&h.rdir, &parked).unwrap();
    let absent_turns = poll_until(&src, &mut cursor, 200, "committed round absence", |s| {
        let cp = s.checkpoint();
        !checkpoint_sessions(&cp).contains("p/r1")
    })
    .await;
    // The absence must be certified, not merely unseen.
    assert!(
        src.discovery_complete(),
        "a removal is reconciled only at a complete error-free census"
    );
    let cp_absent = src.checkpoint();
    assert!(
        !checkpoint_sessions(&cp_absent).contains("p/r1"),
        "the removed round keeps no active path"
    );
    assert!(
        !cp_absent
            .files
            .iter()
            .any(|f| f.session.as_deref() == Some("p/r1")),
        "no worker/log row survives the removed round"
    );
    assert!(
        !cp_absent.revisions.contains_key("p/r1"),
        "the live round token is gone with the round"
    );
    let retired = retired_entry(&cp_absent, "p/r1").unwrap_or_else(|| {
        panic!(
            "a retired revision high-water must survive: {:?}",
            cp_absent.revisions
        )
    });
    assert_eq!(
        retired["rv"], 1,
        "one Run aggregate was emitted before removal"
    );
    assert_eq!(
        retired["cv"], 2,
        "two Child observations were emitted before removal"
    );
    for batch in &absent_turns {
        for item in &batch.items {
            assert_ne!(
                item.session, "p/r1",
                "an absent round must not be re-emitted as active state"
            );
        }
    }

    // 3. The same round reappears: two children + one complete aggregate, all with fresh identities.
    fs::rename(&parked, &h.rdir).unwrap();
    let mut later_children: Vec<(String, String)> = Vec::new();
    let mut later_complete: Option<Value> = None;
    let mut later_run_keys: Vec<String> = Vec::new();
    for _ in 0..200 {
        let t = one_turn(&src, cursor).await;
        assert_identity_alignment(&src, &t.batch);
        cursor = t.batch.next;
        for (idx, item) in t.batch.items.iter().enumerate() {
            if item.session != "p/r1" {
                continue;
            }
            match item.kind {
                ItemKind::Child => later_children.push((
                    t.keys[idx].clone(),
                    item.data["worker"].as_str().unwrap().to_string(),
                )),
                ItemKind::Run if item.data.get("partial").is_none() => {
                    later_run_keys.push(t.keys[idx].clone());
                    later_complete = Some(item.data.clone());
                }
                _ => {}
            }
        }
        if later_complete.is_some() && src.discovery_complete() {
            break;
        }
    }
    let later_complete =
        later_complete.expect("the reappearing round must store a complete aggregate");
    assert_eq!(
        later_complete["workers"], 2,
        "the reappearance re-observes both children"
    );
    assert_eq!(later_complete["done"], 2);
    assert_eq!(later_children.len(), 2, "both new children are emitted");
    assert_eq!(
        later_run_keys.len(),
        1,
        "exactly one reappearance aggregate"
    );

    // Four distinct child occurrences for this round: two before the removal, two after.
    let all_child_keys: Vec<String> = child_keys
        .iter()
        .chain(later_children.iter().map(|(k, _)| k))
        .cloned()
        .collect();
    let unique: BTreeSet<String> = all_child_keys.iter().cloned().collect();
    assert_eq!(
        unique.len(),
        4,
        "four distinct child producer keys after the reappearance: {all_child_keys:?}"
    );
    // No recycled identity anywhere in the round's history (this is what SQLite deduplicates).
    let all_keys: BTreeSet<String> = keys
        .iter()
        .cloned()
        .chain(later_children.iter().map(|(k, _)| k.clone()))
        .chain(later_run_keys.iter().cloned())
        .collect();
    let emitted = keys.len() + later_children.len() + later_run_keys.len();
    assert_eq!(
        all_keys.len(),
        emitted,
        "a reappearance reused an already-committed producer key"
    );
    // The reappearance continues above the retired high-water.
    let cp_again = src.checkpoint();
    let live_token: Value = serde_json::from_str(
        cp_again
            .revisions
            .get("p/r1")
            .unwrap_or_else(|| panic!("the reappeared round is active revision state again")),
    )
    .unwrap();
    assert!(
        live_token["rv"].as_u64().unwrap() > retired["rv"].as_u64().unwrap(),
        "the reappearance aggregate continues above the retired high-water: {live_token}"
    );
    assert!(
        live_token["cv"].as_u64().unwrap() > retired["cv"].as_u64().unwrap(),
        "the reappearance children continue above the retired high-water: {live_token}"
    );
    // Unchanged afterwards: no replay of the restored round.
    let quiet = one_turn(&src, cursor).await;
    assert!(
        quiet.batch.items.is_empty(),
        "a settled reappearance must be silent: {:?}",
        quiet.batch.items
    );
}

/// The same case with the daemon serialized while the round is absent: the retired high-water must come
/// back from the persisted checkpoint (revisions survive as JSON), and the reappearance after the restart
/// still uses fresh identities.
#[tokio::test]
async fn harness_round_reappearance_after_restart_while_absent() {
    let h = Home::new(Some("log\n"));
    h.worker("w0", true, false);
    h.worker("w1", true, false);
    let q = make_round(&h, "q", "r1", Some("log\n"));
    make_worker(&q, "q0", true, false);

    let src = h.source();
    let mut cursor = Cursor(0);
    let mut before: BTreeSet<String> = BTreeSet::new();
    let mut complete = false;
    for _ in 0..60 {
        let t = one_turn(&src, cursor).await;
        cursor = t.batch.next;
        before.extend(t.keys.iter().cloned());
        complete |= t.batch.items.iter().any(|i| {
            i.kind == ItemKind::Run && i.session == "p/r1" && i.data.get("partial").is_none()
        });
        if complete && src.discovery_complete() {
            break;
        }
    }
    assert!(complete, "initial complete aggregate");

    let parked = h._t.path().join("parked-r1");
    fs::rename(&h.rdir, &parked).unwrap();
    poll_until(&src, &mut cursor, 200, "committed round absence", |s| {
        !checkpoint_sessions(&s.checkpoint()).contains("p/r1")
    })
    .await;
    let cp_absent = src.checkpoint();
    assert!(
        retired_entry(&cp_absent, "p/r1").is_some(),
        "retired high-water present before the restart"
    );
    // Serialize the committed checkpoint exactly as the store persists it, then restart while absent.
    let persisted = serde_json::to_string(&cp_absent).unwrap();
    drop(src);
    let resumed = h.source();
    resumed.restore_checkpoint(serde_json::from_str(&persisted).unwrap());
    let mut cursor = Cursor(1);
    // While absent the restored source must stay silent about p/r1 and keep its retired high-water.
    for _ in 0..20 {
        let t = one_turn(&resumed, cursor).await;
        cursor = t.batch.next;
        assert!(
            !t.batch.items.iter().any(|i| i.session == "p/r1"),
            "an absent round cannot be re-emitted after a restart: {:?}",
            t.batch.items
        );
    }
    let cp_after_restart = resumed.checkpoint();
    assert!(
        retired_entry(&cp_after_restart, "p/r1").is_some(),
        "the retired high-water survives the serialized restart: {:?}",
        cp_after_restart.revisions
    );
    assert!(
        !checkpoint_sessions(&cp_after_restart).contains("p/r1"),
        "no active path is resurrected just to keep revisions"
    );

    // Reappearance after the restart.
    fs::rename(&parked, &h.rdir).unwrap();
    let mut fresh_keys: Vec<String> = Vec::new();
    let mut children = 0usize;
    let mut run_complete = false;
    for _ in 0..200 {
        let t = one_turn(&resumed, cursor).await;
        assert_identity_alignment(&resumed, &t.batch);
        cursor = t.batch.next;
        for (idx, item) in t.batch.items.iter().enumerate() {
            if item.session != "p/r1" {
                continue;
            }
            match item.kind {
                ItemKind::Child => {
                    children += 1;
                    fresh_keys.push(t.keys[idx].clone());
                }
                ItemKind::Run if item.data.get("partial").is_none() => {
                    run_complete = true;
                    fresh_keys.push(t.keys[idx].clone());
                }
                _ => {}
            }
        }
        if run_complete && resumed.discovery_complete() {
            break;
        }
    }
    assert_eq!(children, 2, "both children reappear after the restart");
    assert!(run_complete, "a complete aggregate after the restart");
    assert_eq!(fresh_keys.len(), 3, "two children and one aggregate");
    for key in &fresh_keys {
        assert!(
            !before.contains(key),
            "the reappearance after a restart reused a committed key: {key}"
        );
    }
    let unique: BTreeSet<&String> = fresh_keys.iter().collect();
    assert_eq!(unique.len(), fresh_keys.len(), "fresh keys are distinct");
}

// ------------------------------------------------------------------ store-level reappearance + retry rig
//
// The adapter-level cases above prove the identity property. This one drives the same round through the
// production `spawn_poller` (`Source -> Bus -> SQLite`) and asserts the stored rows: four Child occurrences
// with four distinct producer keys, one new complete Run, cleared tombstones, and an exact retry after an
// injected commit failure.

use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::Env;
use agentglimd::store::Store;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::watch;

const SOURCE_ID: &str = plans_harness::ID;

struct Rig {
    data: PathBuf,
    store: Store,
    src: Arc<dyn Source>,
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl Rig {
    fn start(dir: &std::path::Path, h: &Home) -> Rig {
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        let src: Arc<dyn Source> = Arc::new(unpaced(&h.home));
        let (refresh_tx, refresh) = watch::channel(0u64);
        std::mem::forget(refresh_tx);
        let (stop, stop_rx) = watch::channel(false);
        let deps = PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![src.clone()]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: Env {
                home: h.home.clone(),
                vars: Default::default(),
            },
            intervals: Intervals {
                poll: Duration::from_millis(20),
                discover: Duration::from_millis(20),
            },
            refresh,
        };
        let handle = spawn_poller(deps, stop_rx);
        Rig {
            data,
            store,
            src,
            stop,
            handle,
        }
    }

    fn src(&self) -> &Arc<dyn Source> {
        &self.src
    }

    async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(10), self.handle).await;
    }

    fn db(&self) -> Connection {
        Connection::open(self.data.join("state.db")).unwrap()
    }

    /// `(seq, worker, producer key)` of every stored Child observation of `session`.
    fn child_rows(&self, session: &str) -> Vec<(u64, String, String)> {
        let c = self.db();
        let mut st = c
            .prepare(
                "SELECT seq, session, data, producer FROM events
                 WHERE source=?1 AND kind='child' ORDER BY seq",
            )
            .unwrap();
        let rows = st
            .query_map([SOURCE_ID], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .unwrap();
        rows.filter_map(|r| {
            let (seq, s, raw, producer) = r.unwrap();
            if s != session {
                return None;
            }
            let v: Value = serde_json::from_str(&raw).unwrap();
            Some((
                seq,
                v.get("worker")?.as_str()?.to_string(),
                producer.unwrap_or_default(),
            ))
        })
        .collect()
    }

    /// `(seq, data)` of every stored Run aggregate of `session`.
    fn run_rows(&self, session: &str) -> Vec<(u64, Value)> {
        let c = self.db();
        let mut st = c
            .prepare(
                "SELECT seq, session, data FROM events WHERE source=?1 AND kind='run' ORDER BY seq",
            )
            .unwrap();
        let rows = st
            .query_map([SOURCE_ID], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap();
        rows.filter_map(|r| {
            let (seq, s, raw) = r.unwrap();
            if s != session {
                return None;
            }
            Some((seq, serde_json::from_str(&raw).unwrap()))
        })
        .collect()
    }

    fn event_count(&self) -> i64 {
        self.store.event_count().unwrap()
    }

    fn tombstones(&self, prefix: &str) -> Vec<String> {
        let c = self.db();
        let mut st = c
            .prepare(
                "SELECT path FROM source_removed WHERE source=?1 AND path LIKE ?2 ORDER BY path",
            )
            .unwrap();
        let rows = st
            .query_map(rusqlite::params![SOURCE_ID, format!("{prefix}%")], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn fail_event_commits(&self) {
        self.db()
            .execute_batch(
                "CREATE TRIGGER inject_fail BEFORE INSERT ON events
                 BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;",
            )
            .unwrap();
    }

    fn allow_event_commits(&self) {
        self.db()
            .execute_batch("DROP TRIGGER inject_fail;")
            .unwrap();
    }
}

async fn wait_for(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let t0 = std::time::Instant::now();
    while !f() {
        assert!(t0.elapsed() < within, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// v5-r2 AUDIT §2.1 through the real store: the reappearing round stores **four** Child occurrences (not
/// two) with four distinct producer keys and a new complete Run; the three tombstones of the removed round
/// clear only when its paths reappear; and an injected commit failure before the reappearance commit is
/// retried with the exact same pending batch (nothing stored twice, nothing lost).
#[tokio::test]
async fn harness_round_reappearance_persists_four_children_and_retries_after_failure() {
    let h = Home::new(Some("log\n"));
    h.worker("w0", true, false);
    h.worker("w1", true, false);
    let q = make_round(&h, "q", "r1", Some("log\n"));
    make_worker(&q, "q0", true, false);

    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::start(dir.path(), &h);
    wait_for(
        "the initial complete p/r1 aggregate",
        Duration::from_secs(10),
        || {
            rig.run_rows("p/r1")
                .iter()
                .any(|(_, d)| d["workers"] == 2 && d.get("partial").is_none())
        },
    )
    .await;
    wait_for("two stored children", Duration::from_secs(10), || {
        rig.child_rows("p/r1").len() == 2
    })
    .await;
    let initial_children = rig.child_rows("p/r1");
    let initial_keys: BTreeSet<String> =
        initial_children.iter().map(|(_, _, k)| k.clone()).collect();
    assert_eq!(initial_keys.len(), 2, "two distinct initial producer keys");

    // Remove the whole round; wait until its absence is committed (checkpoint + three tombstones).
    let parked = h._t.path().join("parked-r1");
    fs::rename(&h.rdir, &parked).unwrap();
    wait_for("committed round absence", Duration::from_secs(20), || {
        !rig.src()
            .checkpoint()
            .files
            .iter()
            .any(|f| f.session.as_deref() == Some("p/r1"))
    })
    .await;
    let cp_absent = rig.src().checkpoint();
    assert!(
        retired_entry(&cp_absent, "p/r1").is_some(),
        "the removed round keeps a durable retired high-water: {:?}",
        cp_absent.revisions
    );
    let retired = retired_entry(&cp_absent, "p/r1").unwrap();
    assert_eq!(retired["rv"], 1);
    assert_eq!(retired["cv"], 2);
    wait_for(
        "three tombstones for the removed round",
        Duration::from_secs(10),
        || rig.tombstones("p/_build/r1/").len() == 3,
    )
    .await;
    let stored_revisions = rig.store.load_revisions(SOURCE_ID).unwrap();
    assert!(
        stored_revisions.contains_key("retired@p/r1"),
        "the retired high-water is durable in SQLite revisions: {stored_revisions:?}"
    );
    // A delta can only upsert, so the absent round's live token is cleared with an empty value; an empty
    // token decodes as "no live round", which is the claim this assertion makes.
    assert!(
        stored_revisions.get("p/r1").is_none_or(|t| t.is_empty()),
        "no live round token for an absent round: {stored_revisions:?}"
    );

    // Inject a commit failure, then let the round reappear: the reappearance batch must fail once and be
    // retried exactly, not re-polled into different identities.
    rig.fail_event_commits();
    let events_before = rig.event_count();
    fs::rename(&parked, &h.rdir).unwrap();
    wait_for(
        "the reappearing round in adapter state",
        Duration::from_secs(20),
        || {
            rig.src()
                .checkpoint()
                .files
                .iter()
                .any(|f| f.session.as_deref() == Some("p/r1"))
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        rig.event_count(),
        events_before,
        "the injected failure must abort the whole reappearance transaction"
    );
    rig.allow_event_commits();
    wait_for(
        "four stored children after the retry",
        Duration::from_secs(20),
        || rig.child_rows("p/r1").len() == 4,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let children = rig.child_rows("p/r1");
    assert_eq!(
        children.len(),
        4,
        "four Child occurrences after reappearance"
    );
    let keys: BTreeSet<String> = children.iter().map(|(_, _, k)| k.clone()).collect();
    assert_eq!(keys.len(), 4, "four distinct producer keys: {keys:?}");
    let new_keys: BTreeSet<String> = keys.difference(&initial_keys).cloned().collect();
    assert_eq!(
        new_keys.len(),
        2,
        "the reappearance must add two fresh producer keys instead of reusing committed ones: {new_keys:?}"
    );
    let names: Vec<String> = children.iter().map(|(_, w, _)| w.clone()).collect();
    assert_eq!(
        names.iter().filter(|w| *w == "w0").count(),
        2,
        "w0 observed before and after the removal"
    );
    assert_eq!(names.iter().filter(|w| *w == "w1").count(), 2);
    // Exactly two complete aggregates for p/r1: the initial one and the reappearance.
    let runs_p: Vec<(u64, Value)> = rig
        .run_rows("p/r1")
        .into_iter()
        .filter(|(_, d)| d.get("partial").is_none())
        .collect();
    assert_eq!(
        runs_p.len(),
        2,
        "initial + reappearance aggregates: {runs_p:?}"
    );
    assert_eq!(runs_p[1].1["workers"], 2);
    assert_eq!(runs_p[1].1["done"], 2);
    assert!(runs_p[1].0 > runs_p[0].0);
    // Tombstones clear only because the paths reappeared.
    assert!(
        rig.tombstones("p/_build/r1/").is_empty(),
        "reappeared paths must clear their tombstones"
    );
    // And a settled store stops changing.
    let quiet_children = rig.child_rows("p/r1").len();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        rig.child_rows("p/r1").len(),
        quiet_children,
        "a settled reappearance must not replay"
    );
    rig.stop().await;
}

/// v5-r2 AUDIT §2.3: with more than 200 already-seen rounds, one bounded turn must not inspect the known
/// population before applying its cap, and the error evidence used for certification is a maintained
/// counter (a broken round is tracked exactly, without re-scanning every round). Fair rotation still
/// completes every round.
#[tokio::test]
async fn harness_seen_round_selection_and_error_work_are_bounded() {
    use agentglimd::core::{TURN_ALLOWANCE_BYTES, TURN_ALLOWANCE_ENTRIES, TURN_ALLOWANCE_VISITS};
    use std::os::unix::fs::PermissionsExt;

    const ROUNDS: usize = 250;
    let h = Home::new(Some("log\n"));
    h.worker("w0", true, false);
    for i in 1..ROUNDS {
        let d = make_round(&h, "p", &format!("r{i:03}"), Some("log\n"));
        make_worker(&d, "w0", true, false);
    }

    let src = h.source();
    let mut cursor = Cursor(0);
    let mut complete_sessions: BTreeSet<String> = BTreeSet::new();
    let mut passes = 0usize;
    let (mut max_entries, mut max_visits, mut max_bytes) = (0u64, 0u64, 0u64);
    loop {
        passes += 1;
        assert!(
            passes <= 120,
            "250 rounds did not settle in 120 bounded turns"
        );
        let t = one_turn(&src, cursor).await;
        cursor = t.batch.next;
        max_entries = max_entries.max(t.entries);
        max_visits = max_visits.max(t.visits);
        max_bytes = max_bytes.max(t.bytes);
        assert!(
            t.entries <= TURN_ALLOWANCE_ENTRIES,
            "turn {passes} returned {} entries (> {TURN_ALLOWANCE_ENTRIES})",
            t.entries
        );
        assert!(
            t.visits <= TURN_ALLOWANCE_VISITS,
            "turn {passes} made {} visits (> {TURN_ALLOWANCE_VISITS})",
            t.visits
        );
        assert!(
            t.bytes <= TURN_ALLOWANCE_BYTES,
            "turn {passes} charged {} bytes (> {TURN_ALLOWANCE_BYTES})",
            t.bytes
        );
        for item in &t.batch.items {
            if item.kind == ItemKind::Run && item.data.get("partial").is_none() {
                complete_sessions.insert(item.session.clone());
            }
        }
        if t.batch.items.is_empty() && src.discovery_complete() && complete_sessions.len() == ROUNDS
        {
            break;
        }
    }
    assert_eq!(
        complete_sessions.len(),
        ROUNDS,
        "fair rotation must complete every round"
    );
    assert!(passes >= 2, "250 rounds cannot fit one bounded turn");
    eprintln!(
        "BOUNDED rounds={ROUNDS} turns={passes} max_entries={max_entries} max_visits={max_visits} max_bytes={max_bytes} complete={}",
        complete_sessions.len()
    );

    // Every round is known and quiet: the priority selection must inspect none of them (no all-round scan).
    let before = src.selection_stats();
    let t = one_turn(&src, cursor).await;
    let after = src.selection_stats();
    assert!(
        t.batch.items.is_empty(),
        "quiet turn emitted: {:?}",
        t.batch.items
    );
    assert_eq!(
        after.priority_inspections, before.priority_inspections,
        "a quiet turn with {ROUNDS} seen rounds inspected the population for priority service"
    );
    assert_eq!(after.error_rounds, 0, "no round is erroring");
    eprintln!(
        "BOUNDED quiet_turn_entries={} quiet_turn_visits={} priority_inspections_delta={}",
        t.entries,
        t.visits,
        after.priority_inspections - before.priority_inspections
    );
    assert_eq!(
        src.checkpoint()
            .files
            .iter()
            .filter(|f| f.session.as_deref().is_some_and(|s| s.starts_with("p/r")))
            .map(|f| f.session.clone().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        ROUNDS
    );

    // Error evidence is maintained, not re-derived by scanning: one unreadable census is tracked exactly
    // and certification stops; once access returns the counter drops back and discovery certifies again.
    let victim = h.home.join("projects/dev/plans/p/_build/r123/workers");
    let original = fs::metadata(&victim).unwrap().permissions();
    fs::set_permissions(&victim, fs::Permissions::from_mode(0o000)).unwrap();
    let mut errored = false;
    for _ in 0..40 {
        let _ = one_turn(&src, cursor).await;
        if src.selection_stats().error_rounds >= 1 {
            errored = true;
            break;
        }
    }
    assert!(errored, "an unreadable round must be tracked as an error");
    assert!(
        !src.discovery_complete(),
        "an erroring round cannot certify disappearance"
    );
    let errored_rounds = src.selection_stats().error_rounds;
    assert!(errored_rounds >= 1);
    eprintln!("BOUNDED error_rounds_while_unreadable={errored_rounds}");
    fs::set_permissions(&victim, original).unwrap();
    for _ in 0..80 {
        let t = one_turn(&src, cursor).await;
        cursor = t.batch.next;
        if src.selection_stats().error_rounds == 0 && src.discovery_complete() {
            break;
        }
    }
    assert_eq!(
        src.selection_stats().error_rounds,
        0,
        "the error counter must clear once the round is readable again"
    );
    assert!(
        src.discovery_complete(),
        "discovery certifies again after recovery"
    );
    // No false removal: every round is still present in the checkpoint.
    let sessions: BTreeSet<String> = src
        .checkpoint()
        .files
        .iter()
        .filter_map(|f| f.session.clone())
        .collect();
    assert_eq!(sessions.len(), ROUNDS, "no round was falsely removed");
}

// ============================================================================ census floor and witness pacing

/// Unpaced source for the cases that drive census re-sweeps with tight polls (a zero census floor).
fn unpaced(home: &std::path::Path) -> plans_harness::PlansHarness {
    plans_harness::PlansHarness::new(None, home, 30).with_census_floor(Duration::ZERO)
}

/// Source paced by an explicit census floor (production uses the 15 s default of `PlansHarness::new`).
fn paced(home: &std::path::Path, floor: Duration) -> plans_harness::PlansHarness {
    plans_harness::PlansHarness::new(None, home, 30).with_census_floor(floor)
}

#[tokio::test]
async fn census_floor_defers_new_workers_until_the_floor_has_passed() {
    // The first census window opens immediately. A second window may open only once the floor has passed since
    // the first one started, so a worker created right after a completed census is not discovered before it.
    let floor = Duration::from_millis(1500);
    let h = Home::new(None);
    h.worker("alpha", false, false);
    let src = paced(&h.home, floor);
    let t0 = std::time::Instant::now();
    let mut cursor = Cursor(0);
    let mut first_complete = false;
    for _ in 0..50 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        if runs(&b)
            .iter()
            .any(|r| r.data.get("partial").is_none() && r.data["workers"] == 1)
        {
            first_complete = true;
            break;
        }
    }
    assert!(
        first_complete,
        "the first census window must complete without waiting for the floor"
    );
    h.worker("beta", false, false);
    let mut beta_at = None;
    while t0.elapsed() < Duration::from_secs(10) {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        if child_names(&b).iter().any(|n| n == "beta") {
            beta_at = Some(t0.elapsed());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let beta_at = beta_at.expect("beta is discovered once the floor has passed");
    eprintln!(
        "CADENCE census_floor floor_ms={} beta_discovered_ms={}",
        floor.as_millis(),
        beta_at.as_millis()
    );
    assert!(
        beta_at >= floor,
        "beta was discovered after {beta_at:?}, before the {floor:?} census floor had passed"
    );
}

#[tokio::test]
async fn build_log_witness_is_not_gated_by_the_census_floor() {
    // A same-size content edit is observed within 20 polls even with a 15 s census floor: the witness is not a
    // census. A touch (new mtime, same bytes) stays silent.
    let h = Home::new(Some("xxxxxxxxxx\n"));
    h.worker("alpha", true, false);
    let src = paced(&h.home, Duration::from_secs(15));
    let mut cursor = Cursor(0);
    let b0 = src.poll(cursor).await.unwrap();
    cursor = b0.next;
    assert_eq!(runs(&b0)[0].data["build_log_lines"], 1);

    h.set_log("xxxx\nxxxxx\n");
    let mut observed = false;
    let mut polls_to_observe = 0;
    for poll in 1..=20 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        if runs(&b).iter().any(|r| r.data["build_log_lines"] == 2) {
            observed = true;
            polls_to_observe = poll;
            break;
        }
    }
    eprintln!("CADENCE witness_polls_to_observe={polls_to_observe} floor_ms=15000");
    assert!(
        observed,
        "a same-size edit must be observed as 2 lines within 20 polls"
    );

    let log = h.rdir.join("BUILD-LOG.md");
    fs::File::options()
        .write(true)
        .open(&log)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    for _ in 0..5 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert!(
            b.items.is_empty(),
            "a touch with unchanged bytes must stay silent: {:?}",
            b.items
        );
    }
}

#[tokio::test]
async fn build_log_same_size_edit_past_the_old_prefix_is_observed_across_pages() {
    // 20,000 lines of 100 bytes (2,000,000 bytes, four read pages). A same-size edit at byte 1,500,050, far past
    // the old 256-byte prefix and in a later page, splits one line: 20,000 lines become 20,001.
    let line = format!("{}\n", "y".repeat(99));
    let body = line.repeat(20_000);
    let h = Home::new(Some(&body));
    h.worker("alpha", true, false);
    let src = unpaced(&h.home);
    let mut cursor = Cursor(0);
    let mut lines = 0u64;
    for _ in 0..200 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        for r in runs(&b) {
            lines = lines.max(r.data["build_log_lines"].as_u64().unwrap_or(0));
        }
        if lines == 20_000 {
            break;
        }
    }
    assert_eq!(
        lines, 20_000,
        "the full 2 MB log must be counted over several pages"
    );

    let mut bytes = body.clone().into_bytes();
    assert_eq!(bytes[1_500_050], b'y');
    bytes[1_500_050] = b'\n';
    fs::write(h.rdir.join("BUILD-LOG.md"), &bytes).unwrap();
    assert_eq!(bytes.len(), body.len(), "the edit preserves the length");

    let mut observed = false;
    for _ in 0..200 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        if runs(&b).iter().any(|r| r.data["build_log_lines"] == 20_001) {
            observed = true;
            break;
        }
    }
    assert!(
        observed,
        "a same-size edit past the old 256-byte prefix must be observed as 20,001 lines"
    );
}

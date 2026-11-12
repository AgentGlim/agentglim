//! v5 supplemental acceptance: the three exact v4 requirement failures, frozen before repair.
//!
//! Provenance: each test below reconstructs one of the three independent assertion failures recorded in
//! `_build/v4-final/VERIFY.md` §"What v4 delivered and what still fails" against the untouched v4 production
//! source (frozen digest `784cb7d9a8c554df056af37476329e9e073dd6924a98594f59d419beec91047f`). The inputs, the
//! real `Source` entry points and the expected outcomes come from BUILD-V5 §3 "Exact supplemental acceptance to
//! freeze before repair"; nothing here is regenerated from repaired output.
//!
//! These tests assert the REQUIRED (repaired) behaviour, so on untouched v4 they fail with the recorded
//! assertion overruns:
//!
//! * S1 `harness_partial_total_must_be_marked` — first real poll reports `workers:250, done:199` with no
//!   coverage/partial metadata (v4-final: "First real poll emits ... without partial/coverage metadata").
//! * S2 `one_scheduled_turn_entries_and_visits` — 420 supported Claude files, one scheduled turn: v4 reports
//!   `entries=202, stats=202, file_visits=0, opens=1, bytes=127` and only the byte pool is shared.
//! * S3 `opencode_between_windows_requires_detection` — 10,000-character blob edited at byte 1000 with
//!   preserved inode/length/mtime: six real polls return `edit_items=0` in v4.
//!
//! Frozen test bodies: after the pre-repair receipts are recorded the assertions in this file are fixed. A
//! later API extension may require a *mechanical* compile update (recorded separately); inputs, limits and
//! expected outcomes must not change.

use agentglimd::adapters::MAX_FILES_PER_PASS;
use agentglimd::adapters::{claude_code, opencode, plans_harness, MAX_DISCOVERY_ENTRIES_PER_PASS};
use agentglimd::core::{
    Batch, BatchItem, Cursor, Env, ItemKind, Source, TurnBudget, TURN_ALLOWANCE_BYTES,
};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use tempfile::TempDir;

// ------------------------------------------------------------------------------------------------ shared helpers

/// The whole-turn entry cap BUILD-V5 states for one scheduled source turn (begin_turn -> detect -> poll ->
/// end_turn), in *returned directory entries*; it is deliberately the same number as the file/work-visit cap.
const TURN_ENTRY_CAP: u64 = 200;
const TURN_VISIT_CAP: u64 = 200;

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn flag(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
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

/// Coverage evidence accepted for an explicitly-partial aggregate. BUILD-V5 requires an incomplete Run to be
/// "explicitly `partial:true` with meaningful coverage"; these are the documented spellings for that coverage,
/// so an implementation may choose any one of them but may not omit all of them.
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

fn coverage_signal(data: &Value) -> Option<&'static str> {
    COVERAGE_KEYS
        .iter()
        .copied()
        .find(|k| data.get(*k).is_some())
}

// ----------------------------------------------------------------------------------------- S1: harness aggregate

struct HarnessHome {
    _t: TempDir,
    home: PathBuf,
}

impl HarnessHome {
    /// One plan `p` with round `r1` holding a one-line BUILD-LOG.md and `workers` DONE worker directories.
    fn new(workers: usize) -> HarnessHome {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let rdir = home.join("projects/dev/plans/p/_build/r1");
        fs::create_dir_all(rdir.join("workers")).unwrap();
        fs::write(rdir.join("BUILD-LOG.md"), "line 1\n").unwrap();
        for i in 0..workers {
            let d = rdir.join("workers").join(format!("w{i:03}"));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("DONE"), "").unwrap();
        }
        HarnessHome { _t: t, home }
    }

    fn source(&self) -> plans_harness::PlansHarness {
        plans_harness::PlansHarness::new(None, &self.home, 30)
    }

    fn env(&self) -> Env {
        Env {
            home: self.home.clone(),
            vars: Default::default(),
        }
    }
}

/// S1: an incomplete harness aggregate must never be presented as complete.
///
/// Required outcome (BUILD-V5): any emitted incomplete Run carries `partial:true` plus meaningful coverage; a
/// complete total is only ever asserted after it was observed; the source continues to a full 250/250 with all
/// 250 worker children; unchanged polls and an unchanged restart stay silent. If an implementation instead
/// chooses complete-only delivery, the early Run must be absent (`covered_by_completion_only`), and the eventual
/// exact completion is still required — a permanently empty source can never pass.
#[tokio::test]
async fn harness_partial_total_must_be_marked() {
    const WORKERS: usize = 250;
    let h = HarnessHome::new(WORKERS);
    let src = h.source();
    assert!(
        !matches!(
            src.detect(&h.env()),
            agentglimd::core::Detection::NotDetected { .. }
        ),
        "harness fixture must be detected"
    );

    let first = src.poll(Cursor(0)).await.unwrap();
    // Two legitimate deliveries are allowed: an explicitly-partial aggregate, or complete-only delivery that
    // emits no Run until the whole population has really been observed. The coverage criterion is observable:
    // the first Run of a fresh source can only describe every worker if the batch also reports all of them.
    let first_children = children(&first).len();
    for run in runs(&first) {
        let workers = num(&run.data, "workers");
        let done = num(&run.data, "done");
        assert!(
            done <= workers,
            "an aggregate may never report more DONE workers than workers: {}",
            run.data
        );
        if first_children < WORKERS {
            assert_eq!(
                flag(&run.data, "partial"),
                Some(true),
                "a fresh-state aggregate covering {first_children}/{WORKERS} workers must be explicitly marked \
                 partial:true; payload was {} (v4 emitted 250/199 unmarked)",
                run.data
            );
            assert!(
                coverage_signal(&run.data).is_some(),
                "an incomplete aggregate must carry meaningful coverage (one of {COVERAGE_KEYS:?}); payload was {}",
                run.data
            );
        } else {
            assert_ne!(
                flag(&run.data, "partial"),
                Some(true),
                "an aggregate that covered every worker must not claim to be partial: {}",
                run.data
            );
            assert_eq!(
                workers, WORKERS as u64,
                "a covered total must be the observed population, not an undercount: {}",
                run.data
            );
        }
    }
    assert!(
        !runs(&first).is_empty()
            || first_children == 0
            || first_children == WORKERS,
        "a first poll that reports {first_children} of {WORKERS} workers but no aggregate hides incomplete coverage"
    );

    // Continue the real source (bounded pages, fresh cursor each poll) until a complete aggregate is observed.
    let mut cursor = first.next;
    let mut seen_children: Vec<String> = children(&first)
        .iter()
        .map(|c| c.data["worker"].as_str().unwrap_or_default().to_string())
        .collect();
    let mut complete_run: Option<Value> = None;
    for _pass in 0..64 {
        if let Some(run) = runs(&first)
            .iter()
            .map(|r| r.data.clone())
            .find(|d| num(d, "workers") == WORKERS as u64 && num(d, "done") == WORKERS as u64)
        {
            complete_run = Some(run);
        }
        if complete_run.is_some() {
            break;
        }
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        for run in runs(&batch) {
            if num(&run.data, "workers") == WORKERS as u64
                && num(&run.data, "done") == WORKERS as u64
            {
                complete_run = Some(run.data.clone());
            }
        }
        seen_children.extend(
            children(&batch)
                .iter()
                .map(|c| c.data["worker"].as_str().unwrap_or_default().to_string()),
        );
    }
    let complete = complete_run.expect(
        "bounded continuation must eventually observe the complete 250/250 aggregate, never a permanent partial",
    );
    assert_eq!(num(&complete, "workers"), WORKERS as u64);
    assert_eq!(num(&complete, "done"), WORKERS as u64);
    assert_ne!(
        flag(&complete, "partial"),
        Some(true),
        "the complete aggregate must not be marked partial: {complete}"
    );

    seen_children.sort();
    seen_children.dedup();
    assert_eq!(
        seen_children.len(),
        WORKERS,
        "every one of the {WORKERS} workers must be reported as a child exactly once; saw {}",
        seen_children.len()
    );

    // Unchanged replay: draining again must not invent changes.
    let mut quiet_cursor = cursor;
    for _ in 0..4 {
        let b = src.poll(quiet_cursor).await.unwrap();
        quiet_cursor = b.next;
        assert!(
            b.items.is_empty(),
            "unchanged harness poll re-emitted items: {:?}",
            b.items
        );
    }

    // Unchanged restart from the committed checkpoint stays silent.
    let checkpoint = src.checkpoint();
    let fresh = h.source();
    fresh.restore_checkpoint(checkpoint);
    let b = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        b.items.is_empty(),
        "unchanged restart re-emitted harness items: {:?}",
        b.items
    );
}

// ------------------------------------------------------------------------------- S2: one scheduled whole turn

struct ClaudeHome {
    _t: TempDir,
    home: PathBuf,
}

impl ClaudeHome {
    /// `files` supported Claude transcripts, one trailing assistant line each.
    fn new(files: usize) -> ClaudeHome {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let dir = home.join(".claude/projects/-bulk");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..files {
            let line = format!(
                "{{\"type\":\"assistant\",\"sessionId\":\"s{i:04}\",\"message\":{{\"role\":\"assistant\",\
                 \"model\":\"m\"}},\"timestamp\":\"2026-11-01T00:00:00.000Z\"}}\n"
            );
            fs::write(dir.join(format!("s{i:04}.jsonl")), line).unwrap();
        }
        ClaudeHome { _t: t, home }
    }

    fn source(&self) -> claude_code::ClaudeCode {
        claude_code::ClaudeCode::new(None, &self.home, 30)
    }

    fn env(&self) -> Env {
        Env {
            home: self.home.clone(),
            vars: Default::default(),
        }
    }
}

/// S2: one scheduled turn shares ≤200 returned entries and ≤200 file visits (and one 4 MiB content allowance)
/// across `begin_turn → detect → poll → end_turn`; later turns make progress and eventually ingest every
/// supported occurrence exactly once.
#[tokio::test]
async fn one_scheduled_turn_entries_and_visits() {
    const FILES: usize = 420;
    let h = ClaudeHome::new(FILES);
    let src = h.source();
    let budget = TurnBudget::default_allowance();

    // One real scheduled turn: exactly one allowance for detect + poll, closed from the outside.
    src.begin_turn(budget.clone());
    let detection = src.detect(&h.env());
    let first = src.poll(Cursor(0)).await.unwrap();
    src.end_turn();
    let stats = src.work_stats();

    assert!(
        matches!(detection, agentglimd::core::Detection::Detected { .. }),
        "420 supported Claude files under one project must be detected: {detection:?}"
    );

    // v4 reports entries=202 / stats=202 / file_visits=0 / opens=1 / shared bytes=127 for this fixture. The
    // whole-turn caps below are the requirement; the printed counters are the diagnosis.
    assert!(
        stats.entries <= TURN_ENTRY_CAP,
        "whole-turn returned entries {} exceed the shared {TURN_ENTRY_CAP} cap (detect+poll must share one \
         entry allowance); stats={stats:?} per-pass cap is {}",
        stats.entries,
        MAX_DISCOVERY_ENTRIES_PER_PASS
    );
    assert!(
        stats.file_visits <= TURN_VISIT_CAP,
        "whole-turn file/work visits {} exceed the shared {TURN_VISIT_CAP} cap; stats={stats:?} per-pass cap is {}",
        stats.file_visits,
        MAX_FILES_PER_PASS
    );
    assert!(
        budget.used() <= TURN_ALLOWANCE_BYTES,
        "whole-turn content bytes {} exceed the shared {} allowance",
        budget.used(),
        TURN_ALLOWANCE_BYTES
    );

    // Bounded continuation: further scheduled turns (each with a fresh allowance) must make progress and
    // eventually ingest all 420 occurrences exactly once. No turn may exceed the shared caps. The cursor rule is
    // the production poller's: the first turn starts at 0, later turns never go back to 0.
    let mut cursor = first.next;
    if cursor.0 == 0 {
        cursor = Cursor(1);
    }
    let mut steps: Vec<String> = first
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Step)
        .map(|i| i.session.clone())
        .collect();
    let mut previous_entries = stats.entries;
    for turn in 0..80 {
        if steps.len() >= FILES {
            break;
        }
        let b_budget = TurnBudget::default_allowance();
        src.begin_turn(b_budget.clone());
        let batch = src.poll(cursor).await.unwrap();
        src.end_turn();
        let after = src.work_stats();
        let turn_entries = after.entries.saturating_sub(previous_entries);
        previous_entries = after.entries;
        assert!(
            turn_entries <= TURN_ENTRY_CAP,
            "turn {turn} returned {turn_entries} entries, above the shared {TURN_ENTRY_CAP} cap"
        );
        assert!(
            b_budget.used() <= TURN_ALLOWANCE_BYTES,
            "turn {turn} read {} content bytes, above the shared allowance",
            b_budget.used()
        );
        cursor = if batch.next.0 == 0 {
            Cursor(cursor.0.max(1))
        } else {
            batch.next
        };
        steps.extend(
            batch
                .items
                .iter()
                .filter(|i| i.kind == ItemKind::Step)
                .map(|i| i.session.clone()),
        );
    }
    steps.sort();
    let unique = {
        let mut s = steps.clone();
        s.dedup();
        s.len()
    };
    assert_eq!(
        unique, FILES,
        "bounded turns must eventually ingest every one of the {FILES} supported files exactly once \
         (saw {} step items, {} distinct)",
        steps.len(),
        unique
    );
    assert_eq!(
        steps.len(),
        FILES,
        "an already-ingested occurrence must not be re-emitted: {} step items for {FILES} files",
        steps.len()
    );
}

// ------------------------------------------------------------------------------------- S3: OpenCode blind spot

fn oc_root(home: &std::path::Path) -> PathBuf {
    home.join(".local/share/opencode/storage")
}

fn set_mtime(path: &std::path::Path, t: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(t)
        .unwrap();
}

/// S3: an inode/length/mtime-preserving edit inside a large (10,000-character blob) supported document at byte
/// 1000, between the bounded sample windows, must be observed within six real polls; afterwards the unchanged
/// polls and an unchanged restart are silent.
#[tokio::test]
async fn opencode_between_windows_requires_detection() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();

    let padding = "p".repeat(10_000);
    let doc1 = format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":101}},"blob":"{}"}}"#,
        padding
    );
    let mut chars: Vec<char> = doc1.chars().collect();
    assert!(chars[1000] == 'p');
    chars[1000] = 'q';
    let doc2: String = chars.into_iter().collect();
    assert_eq!(
        doc1.len(),
        doc2.len(),
        "same length, same inode, same mtime"
    );
    assert!(doc1.len() > opencode::SAMPLE_FULL_MAX as usize);

    let msg = base.join("message/ses1/m_large.json");
    fs::write(&msg, &doc1).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "an unchanged second poll must be silent, got {:?}",
        b1.items
    );

    // Same inode, same length, same mtime; a single byte inside the blob differs between sample windows.
    fs::write(&msg, &doc2).unwrap();
    set_mtime(&msg, mtime);

    let mut cursor = b1.next;
    let mut detected = 0usize;
    for _poll in 0..6 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        detected += b.items.len();
    }
    assert!(
        detected > 0,
        "the between-window content edit must be observed within six real polls (v4 reported edit_items=0)"
    );

    // After acceptance the unchanged document is silent, and an unchanged restart stays silent.
    for _poll in 0..3 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert!(
            b.items.is_empty(),
            "an accepted revision must not be re-emitted while the document is unchanged: {:?}",
            b.items
        );
    }
    let checkpoint = src.checkpoint();
    let fresh = opencode::OpenCode::new(None, &home, 30);
    fresh.restore_checkpoint(checkpoint);
    let b = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        b.items.is_empty(),
        "unchanged OpenCode restart re-emitted items: {:?}",
        b.items
    );
}

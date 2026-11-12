//! v5 G08: all-six whole-turn traversal, sharing, cancellation and fair progress on REAL adapters.
//!
//! Two driving modes, both production:
//! * direct `Source` turns (`begin_turn -> detect -> poll -> end_turn`) exactly as the scheduler calls them, so a
//!   single turn's allowance/entry/work-visit accounting is observable;
//! * the real `spawn_poller` with all six adapters registered, for scheduling, fairness, shutdown and
//!   balanced begin/end evidence.
//!
//! Instrumentation is a thin delegating wrapper around each real adapter (it records begin/end and the turn
//! allowance); it never parses, enumerates or budgets anything itself.
//!
//! Per-turn accounting has two independent sources, and both are asserted for all six adapters:
//! * the `TurnBudget` core handed the adapter, read back as `usage()` **after** `end_turn()` — the authoritative
//!   per-turn counters (bytes/entries/visits) charged by the shared `adapters::io` boundary;
//! * each adapter's own cumulative `work_stats()`, sampled **before** `begin_turn` and after `end_turn`, so the
//!   assertion is over this turn's delta and never over a lifetime total (v5-r1 audit §2.5).
//!
//! Application counters and budget counters are both application accounting; neither is kernel evidence.

use agentglimd::adapters::{
    agy, claude_code, codex, opencode, pi, plans_harness, MAX_FILES_PER_PASS,
};
use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{
    Batch, BoxFut, Caps, CoreError, Cursor, Detection, Env, ItemKind, SessionId, Source,
    SourceKind, TurnBudget, TurnUsage, Verb, TURN_ALLOWANCE_BYTES, TURN_ALLOWANCE_ENTRIES,
    TURN_ALLOWANCE_VISITS,
};
use agentglimd::store::Store;
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::watch;

// -------------------------------------------------------------------------------------------------- fixtures

/// One private home holding a supported synthetic tree for all six adapters.
struct Fixture {
    _t: TempDir,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Fixture {
        Self::with_counts(420, 60, 40, 60, 40, 250)
    }

    fn with_counts(
        claude_files: usize,
        codex_files: usize,
        agy_files: usize,
        pi_files: usize,
        opencode_messages: usize,
        harness_workers: usize,
    ) -> Fixture {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");

        // claude-code: one project, N single-line transcripts.
        let claude = home.join(".claude/projects/-bulk");
        fs::create_dir_all(&claude).unwrap();
        for i in 0..claude_files {
            fs::write(
                claude.join(format!("c{i:04}.jsonl")),
                format!(
                    "{{\"type\":\"assistant\",\"sessionId\":\"c{i:04}\",\"message\":{{\"role\":\"assistant\",\
                     \"model\":\"m\"}},\"timestamp\":\"2026-11-01T00:00:00.000Z\"}}\n"
                ),
            )
            .unwrap();
        }

        // codex: N rollouts under dated directories.
        let codex = home.join(".codex/sessions/2026/11/06");
        fs::create_dir_all(&codex).unwrap();
        for i in 0..codex_files {
            let uuid = format!("0000000{i:03}-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
            fs::write(
                codex.join(format!("rollout-2026-11-06T10-00-00-{uuid}.jsonl")),
                format!(
                    "{{\"timestamp\":\"2026-11-06T10:00:00.120Z\",\"type\":\"session_meta\",\"payload\":\
                     {{\"id\":\"{uuid}\",\"cwd\":\"/work/demo\",\"originator\":\"codex_cli_rs\",\
                     \"cli_version\":\"0.50.0\"}}}}\n\
                     {{\"timestamp\":\"2026-11-06T10:00:01.000Z\",\"type\":\"response_item\",\"payload\":\
                     {{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\
                     \"text\":\"hello\"}}]}}}}\n"
                ),
            )
            .unwrap();
        }

        // agy: one transcript inside its own brain directory.
        for i in 0..agy_files {
            let brain = home.join(format!(
                ".gemini/antigravity-cli/brain/4c1d9e70-2b35-4a8f-9d64-{i:012}/.system_generated/logs"
            ));
            fs::create_dir_all(&brain).unwrap();
            fs::write(
                brain.join("transcript.jsonl"),
                "{\"type\":\"user_input\",\"timestamp\":\"2026-11-01T08:00:00.000Z\",\
                 \"content\":\"do it\"}\n\
                 {\"type\":\"planner_response\",\"timestamp\":\"2026-11-01T08:00:04.000Z\",\
                 \"model\":\"gemini-3-pro\",\"content\":\"ok\",\"usage\":{\"input_tokens\":10,\
                 \"output_tokens\":2}}\n",
            )
            .unwrap();
        }

        // pi: N sessions in one project.
        let pi_dir = home.join(".pi/agent/sessions/--work-demo--");
        fs::create_dir_all(&pi_dir).unwrap();
        for i in 0..pi_files {
            let uuid = format!("5e2f7a90-1c3d-4b6e-8f01-{i:012}");
            fs::write(
                pi_dir.join(format!("2026-11-01T09-00-00-000Z_{uuid}.jsonl")),
                format!(
                    "{{\"type\":\"session\",\"version\":3,\"id\":\"{uuid}\",\
                     \"timestamp\":\"2026-11-01T09:00:00.000Z\",\"cwd\":\"/work/demo\"}}\n\
                     {{\"type\":\"message\",\"id\":\"a1\",\"timestamp\":\"2026-11-01T09:00:01.000Z\",\
                     \"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}],\
                     \"timestamp\":1793523601000}}}}\n"
                ),
            )
            .unwrap();
        }

        // opencode: one session document plus N message documents.
        let oc = home.join(".local/share/opencode/storage");
        fs::create_dir_all(oc.join("session/demo")).unwrap();
        fs::write(
            oc.join("session/demo/ses1.json"),
            r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
        )
        .unwrap();
        for i in 0..opencode_messages {
            let dir = oc.join("message/ses1");
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join(format!("m{i:04}.json")),
                format!(
                    "{{\"id\":\"m{i:04}\",\"sessionID\":\"ses1\",\"role\":\"user\",\
                     \"time\":{{\"created\":{}}},\"text\":\"hello\"}}",
                    100 + i
                ),
            )
            .unwrap();
        }

        // plans-harness: one plan/round with N DONE workers and a log line.
        let round = home.join("projects/dev/plans/p/_build/r1");
        fs::create_dir_all(round.join("workers")).unwrap();
        fs::write(round.join("BUILD-LOG.md"), "line 1\n").unwrap();
        for i in 0..harness_workers {
            let d = round.join("workers").join(format!("w{i:03}"));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("DONE"), "").unwrap();
        }

        Fixture { _t: t, home }
    }

    fn env(&self) -> Env {
        Env {
            home: self.home.clone(),
            vars: Default::default(),
        }
    }

    fn sources(&self) -> Vec<(&'static str, Arc<dyn Source>)> {
        vec![
            (
                plans_harness::ID,
                Arc::new(plans_harness::PlansHarness::new(None, &self.home, 30)) as Arc<dyn Source>,
            ),
            (
                claude_code::ID,
                Arc::new(claude_code::ClaudeCode::new(None, &self.home, 30)) as Arc<dyn Source>,
            ),
            (
                codex::ID,
                Arc::new(codex::Codex::new(None, &self.home, 30)) as Arc<dyn Source>,
            ),
            (
                opencode::ID,
                Arc::new(opencode::OpenCode::new(None, &self.home, 30)) as Arc<dyn Source>,
            ),
            (
                agy::ID,
                Arc::new(agy::Agy::new(None, &self.home, 30)) as Arc<dyn Source>,
            ),
            (
                pi::ID,
                Arc::new(pi::Pi::new(None, &self.home, 30)) as Arc<dyn Source>,
            ),
        ]
    }
}

// ----------------------------------------------------------------------------------------- instrumentation

/// Delegating wrapper: records the turn allowance core hands the adapter and the begin/end balance. It performs
/// no parsing, enumeration or budgeting of its own, so the adapter under test is unchanged.
struct Watched {
    inner: Arc<dyn Source>,
    begins: AtomicUsize,
    ends: AtomicUsize,
    open: Mutex<Vec<Arc<TurnBudget>>>,
    used: Mutex<Vec<u64>>,
    usage: Mutex<Vec<TurnUsage>>,
}

impl Watched {
    fn new(inner: Arc<dyn Source>) -> Arc<Watched> {
        Arc::new(Watched {
            inner,
            begins: AtomicUsize::new(0),
            ends: AtomicUsize::new(0),
            open: Mutex::new(Vec::new()),
            used: Mutex::new(Vec::new()),
            usage: Mutex::new(Vec::new()),
        })
    }

    fn begins(&self) -> usize {
        self.begins.load(Ordering::SeqCst)
    }

    fn ends(&self) -> usize {
        self.ends.load(Ordering::SeqCst)
    }

    fn used_per_turn(&self) -> Vec<u64> {
        self.used.lock().unwrap().clone()
    }

    /// The `TurnBudget::usage()` of every completed scheduled turn, in order.
    fn usage_per_turn(&self) -> Vec<TurnUsage> {
        self.usage.lock().unwrap().clone()
    }
}

impl Source for Watched {
    fn id(&self) -> &'static str {
        self.inner.id()
    }
    fn kind(&self) -> SourceKind {
        self.inner.kind()
    }
    fn detect(&self, env: &Env) -> Detection {
        self.inner.detect(env)
    }
    fn capabilities(&self) -> Caps {
        self.inner.capabilities()
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        self.inner.poll(since)
    }
    fn offsets(&self) -> Vec<agentglimd::core::FileOffset> {
        self.inner.offsets()
    }
    fn restore_offsets(&self, offsets: Vec<agentglimd::core::FileOffset>) {
        self.inner.restore_offsets(offsets)
    }
    fn checkpoint(&self) -> agentglimd::core::SourceCheckpoint {
        self.inner.checkpoint()
    }
    fn restore_checkpoint(&self, cp: agentglimd::core::SourceCheckpoint) {
        self.inner.restore_checkpoint(cp)
    }
    fn restore_removed(&self, removed: &[agentglimd::core::RemovedPath]) {
        self.inner.restore_removed(removed)
    }
    fn identities(&self) -> Vec<agentglimd::core::RecordKey> {
        self.inner.identities()
    }
    fn discovery_complete(&self) -> bool {
        self.inner.discovery_complete()
    }
    fn discovery_epoch(&self) -> Option<u64> {
        self.inner.discovery_epoch()
    }
    fn retains_unseen_paths(&self) -> bool {
        self.inner.retains_unseen_paths()
    }
    fn begin_turn(&self, allowance: Arc<TurnBudget>) {
        self.begins.fetch_add(1, Ordering::SeqCst);
        self.open.lock().unwrap().push(allowance.clone());
        self.inner.begin_turn(allowance);
    }
    fn end_turn(&self) {
        self.ends.fetch_add(1, Ordering::SeqCst);
        let b = self.open.lock().unwrap().pop();
        if let Some(b) = b {
            self.used.lock().unwrap().push(b.used());
            self.usage.lock().unwrap().push(b.usage());
        }
        self.inner.end_turn();
    }
    fn control<'a>(
        &'a self,
        sid: &'a SessionId,
        verb: Verb,
    ) -> BoxFut<'a, Result<agentglimd::core::Ack, CoreError>> {
        self.inner.control(sid, verb)
    }
}

// --------------------------------------------------------------------------------------------------- helpers

/// One real scheduled turn, driven exactly like `SourceLoop::turn`: detect (when due) and poll share one
/// allowance, `end_turn` always runs. `stats` is a `(entries, file_visits)` reader for the SAME adapter
/// instance; it is sampled **after** `begin_turn` and after `end_turn`, and the returned value is the
/// **delta** for this turn (v5-r1 audit §2.5: most `WorkStats` are cumulative per adapter by contract,
/// so post-begin sampling is a no-op for them). The one exception is OpenCode, whose counters are reset
/// in `begin_turn` (per-turn by design, `opencode.rs::begin_turn`): sampling before `begin_turn` would
/// subtract the previous turn's total from this turn's and saturate to zero, masking all of its work.
/// Post-begin sampling gives the per-turn value for OpenCode and the delta for every cumulative adapter.
async fn turn<F>(
    src: &dyn Source,
    env: &Env,
    cursor: Cursor,
    stats: F,
) -> (Arc<TurnBudget>, Detection, Batch, Option<(u64, u64)>)
where
    F: Fn() -> Option<(u64, u64)>,
{
    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    let before = stats();
    let detection = src.detect(env);
    let batch = src.poll(cursor).await.unwrap();
    src.end_turn();
    let delta = match (before, stats()) {
        (Some((be, bv)), Some((ae, av))) => Some((ae.saturating_sub(be), av.saturating_sub(bv))),
        _ => None,
    };
    (budget, detection, batch, delta)
}

/// Full attempted-work counters of one scheduled turn, sampled after `begin_turn` (the same sampling as
/// `turn()`, so OpenCode's per-turn reset is handled and cumulative adapters still yield a delta).
/// `WorkStats` counts *attempted* operations (an entry is charged before the enumerator advances, an open
/// is counted before it is attempted — see `adapters::io`), so error operations are included, not only
/// successes. This is application accounting, never kernel I/O.
macro_rules! work_full {
    ($src:expr) => {{
        let w = $src.work_stats();
        (w.entries, w.stats, w.opens, w.dirs, w.file_visits)
    }};
}

fn attempted_total(d: (u64, u64, u64, u64, u64)) -> u64 {
    d.0 + d.1 + d.2 + d.3 + d.4
}

fn sub_work(
    before: (u64, u64, u64, u64, u64),
    after: (u64, u64, u64, u64, u64),
) -> (u64, u64, u64, u64, u64) {
    (
        after.0.saturating_sub(before.0),
        after.1.saturating_sub(before.1),
        after.2.saturating_sub(before.2),
        after.3.saturating_sub(before.3),
        after.4.saturating_sub(before.4),
    )
}

/// Defensible per-class ceilings derived from the shared 200-entry / 200-visit turn allowances: at most one
/// entry, one visit, one metadata op per entry plus one per visit, up to three opens per visit (the
/// fingerprint sample, the payload read and the verification read a single visited file may take), one
/// directory open per visit. Attempted (not merely successful) operations are counted by `WorkStats` itself.
const TRACE_CEILINGS: (u64, u64, u64, u64, u64) = (200, 400, 600, 200, 200);
const TRACE_TOTAL_CEILING: u64 = 1_600;

fn assert_trace_ceiling(label: &str, d: (u64, u64, u64, u64, u64)) {
    let (c, s, o, dd, v) = TRACE_CEILINGS;
    assert!(
        d.0 <= c && d.1 <= s && d.2 <= o && d.3 <= dd && d.4 <= v,
        "{label}: attempted {d:?} exceeds the stated per-class ceilings {TRACE_CEILINGS:?} \
         (entries, stats, opens, dirs, visits)"
    );
    assert!(
        attempted_total(d) <= TRACE_TOTAL_CEILING,
        "{label}: attempted total {} exceeds {TRACE_TOTAL_CEILING}",
        attempted_total(d)
    );
}

/// Cumulative `(entries, file_visits)` of one adapter instance, for the delta accounting above.
macro_rules! work {
    ($src:expr) => {{
        let w = $src.work_stats();
        Some((w.entries, w.file_visits))
    }};
}

/// The production poller's cursor rule: the first turn starts at 0; later turns never go back to 0.
fn advance(cursor: Cursor, next: Cursor) -> Cursor {
    if next.0 == 0 {
        Cursor(cursor.0.max(1))
    } else {
        next
    }
}

/// Work units this fixture expects to observe once each, per adapter shape: harness children, and
/// session/message identities for the transcript adapters.
fn units(id: &str, batch: &Batch) -> Vec<String> {
    if id == plans_harness::ID {
        return batch
            .items
            .iter()
            .filter(|i| i.kind == ItemKind::Child)
            .filter_map(|i| {
                i.data
                    .get("worker")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect();
    }
    batch
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Session || i.kind == ItemKind::Step)
        .map(|i| i.session.clone())
        .collect()
}

/// Observations one visited file may emit (Session + Step + Spend), so an emitted batch has a derived ceiling.
const MAX_ITEMS_PER_VISIT_ROUND: usize = 3 * MAX_FILES_PER_PASS;

fn cap_check(label: &str, budget: &TurnBudget, items: usize) {
    let usage = budget.usage();
    assert!(
        usage.bytes.used <= TURN_ALLOWANCE_BYTES,
        "{label}: turn read {} content bytes, above the shared {} allowance",
        usage.bytes.used,
        TURN_ALLOWANCE_BYTES
    );
    // The contract caps returned entries, work visits and content bytes. Emitted observations are derived:
    // one visited file can yield Session + Step + Spend, so the page has a finite derived ceiling and is
    // never unbounded, but exact equality with the visit cap is not a requirement.
    assert!(
        items <= MAX_ITEMS_PER_VISIT_ROUND,
        "{label}: turn returned {items} items, above the derived ceiling of {MAX_ITEMS_PER_VISIT_ROUND} \
         (three observations per visited file)"
    );
    assert!(
        usage.entries.used <= TURN_ALLOWANCE_ENTRIES,
        "{label}: turn returned {} directory entries, above the shared {TURN_ALLOWANCE_ENTRIES} cap ({usage:?})",
        usage.entries.used
    );
    assert!(
        usage.visits.used <= TURN_ALLOWANCE_VISITS,
        "{label}: turn performed {} work visits, above the shared {TURN_ALLOWANCE_VISITS} cap ({usage:?})",
        usage.visits.used
    );
}

/// The per-turn caps, asserted from the `TurnBudget` core handed the adapter (entries/visits/bytes) and, when the
/// adapter reports its own counters, from this turn's `work_stats()` delta only.
fn assert_caps(label: &str, budget: &TurnBudget, batch: &Batch, stats: Option<(u64, u64)>) {
    cap_check(label, budget, batch.items.len());
    if let Some((entries, visits)) = stats {
        assert!(
            entries <= MAX_FILES_PER_PASS as u64,
            "{label}: whole-turn returned entries delta {entries} exceed the shared {MAX_FILES_PER_PASS} cap"
        );
        assert!(
            visits <= MAX_FILES_PER_PASS as u64,
            "{label}: whole-turn file/work visit delta {visits} exceed the shared {MAX_FILES_PER_PASS} cap"
        );
    }
}

// ---------------------------------------------------------------------------------------------------- tests

/// One scheduled turn on each of the six real adapters: one shared allowance, inside the content and work caps,
/// `end_turn` closed the turn, and the fixture is detected (for the deep `agy` layout after bounded continuation).
#[tokio::test]
async fn one_scheduled_turn_per_adapter_is_bounded() {
    let fx = Fixture::new();
    let env = fx.env();

    let harness = plans_harness::PlansHarness::new(None, &fx.home, 30);
    let (b, det, batch, st) = turn(&harness, &env, Cursor(0), || work!(harness)).await;
    assert!(
        matches!(det, Detection::Detected { .. }),
        "harness detected"
    );
    assert_caps("plans-harness", &b, &batch, st);
    // Bounded, not exact: one page is a slice of the bounded worker census (the adapter deliberately caps a
    // round at 96 entries / 64 observations so rounds share the turn), so the only hard requirement is a
    // non-empty page inside the shared cap that continues on the next turn (asserted below).
    assert!(
        !batch.items.is_empty() && batch.items.len() <= MAX_ITEMS_PER_VISIT_ROUND,
        "the first bounded harness page must be non-empty and inside the derived item ceiling, got {}",
        batch.items.len()
    );
    let usage = b.usage();
    assert!(
        usage.entries.used > 0 && usage.visits.used > 0,
        "the harness turn must report its entry/visit work through the shared budget: {usage:?}"
    );

    let claude = claude_code::ClaudeCode::new(None, &fx.home, 30);
    let (b, det, batch, st) = turn(&claude, &env, Cursor(0), || work!(claude)).await;
    assert!(matches!(det, Detection::Detected { .. }), "claude detected");
    assert_caps("claude-code", &b, &batch, st);
    let (entries, visits) = st.unwrap();
    assert!(
        entries > 0,
        "the claude turn must report the entries it returned (420-file fixture)"
    );
    assert_eq!(
        visits, 0,
        "nothing can be visited before discovery completes"
    );

    let codex = codex::Codex::new(None, &fx.home, 30);
    let (b, det, batch, st) = turn(&codex, &env, Cursor(0), || work!(codex)).await;
    assert!(matches!(det, Detection::Detected { .. }), "codex detected");
    assert_caps("codex", &b, &batch, st);

    // `agy` detection is bounded and resumable by contract: the layout is four levels deep per conversation,
    // so one 200-entry/200-visit detection pass can legitimately finish still scanning (r5-r1 shared-turn
    // change). The requirement is a finite bound, so every scheduled turn stays inside the caps and detection
    // completes within a stated number of turns — a bounded-but-forever-scanning detection is a failure.
    let agy = agy::Agy::new(None, &fx.home, 30);
    let mut cursor = Cursor(0);
    let mut agy_turns = 0usize;
    let mut agy_detected = false;
    while agy_turns < 8 {
        agy_turns += 1;
        let (b, det, batch, st) = turn(&agy, &env, cursor, || work!(agy)).await;
        assert_caps(&format!("agy detect turn {agy_turns}"), &b, &batch, st);
        cursor = advance(cursor, batch.next);
        if matches!(det, Detection::Detected { .. }) {
            agy_detected = true;
            break;
        }
    }
    assert!(
        agy_detected,
        "agy: bounded detection must finish within 8 scheduled turns for the 40-conversation fixture"
    );

    let pi = pi::Pi::new(None, &fx.home, 30);
    let (b, det, batch, st) = turn(&pi, &env, Cursor(0), || work!(pi)).await;
    assert!(matches!(det, Detection::Detected { .. }), "pi detected");
    assert_caps("pi", &b, &batch, st);

    let oc = opencode::OpenCode::new(None, &fx.home, 30);
    let (b, det, batch, st) = turn(&oc, &env, Cursor(0), || work!(oc)).await;
    assert!(
        matches!(det, Detection::Detected { .. }),
        "opencode detected"
    );
    assert_caps("opencode", &b, &batch, st);
    let usage = b.usage();
    assert!(
        usage.entries.used > 0 && usage.visits.used > 0,
        "the opencode turn must report its entry/visit work through the shared budget: {usage:?}"
    );
    // All six adapters therefore report real per-turn entry/visit accounting through the one shared
    // allowance; the four JSONL adapters additionally assert their own cumulative-counter deltas above.
}

/// Bounded continuation on each adapter: repeated scheduled turns make progress, never exceed the caps, and
/// eventually ingest every supported occurrence exactly once.
#[tokio::test]
async fn bounded_turns_eventually_ingest_every_occurrence() {
    let fx = Fixture::new();
    let env = fx.env();

    macro_rules! drive {
        ($id:expr, $src:expr, $expected:expr, $stats:expr) => {{
            let src = &$src;
            let mut cursor = Cursor(0);
            let mut seen: Vec<String> = Vec::new();
            let mut stalled = 0usize;
            let mut turns = 0usize;
            let expected: usize = $expected;
            while turns < 400 {
                turns += 1;
                let (budget, _, batch, st) = turn(src, &env, cursor, $stats).await;
                assert_caps(&format!("{} turn {}", $id, turns), &budget, &batch, st);
                cursor = advance(cursor, batch.next);
                let got = units($id, &batch);
                let fresh = got.iter().filter(|u| !seen.contains(u)).count();
                stalled = if fresh == 0 { stalled + 1 } else { 0 };
                assert!(
                    stalled < 12,
                    "{}: 12 consecutive turns without new work is a bounded-but-stalled loop; \
                     seen {} of {expected} after {turns} turns",
                    $id,
                    seen.len()
                );
                for u in got {
                    if !seen.contains(&u) {
                        seen.push(u);
                    }
                }
                if seen.len() >= expected {
                    break;
                }
            }
            assert_eq!(
                seen.len(),
                expected,
                "{}: bounded turns must ingest all {expected} occurrences, saw {} after {turns} turns",
                $id,
                seen.len()
            );
            // Settled: a further turn must be silent.
            let (budget, _, batch, st) = turn(src, &env, cursor, $stats).await;
            assert_caps(&format!("{} settled turn", $id), &budget, &batch, st);
            assert!(
                batch.items.is_empty(),
                "{}: an ingested fixture must not replay: {:?}",
                $id,
                batch
                    .items
                    .iter()
                    .map(|i| (i.kind, i.session.clone()))
                    .collect::<Vec<_>>()
            );
        }};
    }

    let harness = plans_harness::PlansHarness::new(None, &fx.home, 30);
    drive!(plans_harness::ID, harness, 250, || work!(harness));
    let claude = claude_code::ClaudeCode::new(None, &fx.home, 30);
    drive!(claude_code::ID, claude, 420, || work!(claude));
    let codex = codex::Codex::new(None, &fx.home, 30);
    drive!(codex::ID, codex, 60, || work!(codex));
    let agy = agy::Agy::new(None, &fx.home, 30);
    drive!(agy::ID, agy, 40, || work!(agy));
    let pi = pi::Pi::new(None, &fx.home, 30);
    drive!(pi::ID, pi, 60, || work!(pi));
    let oc = opencode::OpenCode::new(None, &fx.home, 30);
    drive!(opencode::ID, oc, 1, || work!(oc));
}

/// Missing and unreadable roots: bounded, honest (no detection claim), no budget spin, and full recovery once the
/// root is readable again.
#[tokio::test]
async fn missing_and_unreadable_roots_are_bounded_and_recover() {
    let fx = Fixture::new();
    let env = fx.env();
    // A home with none of the supported roots.
    let empty = tempfile::tempdir().unwrap();
    let empty_home = Env {
        home: empty.path().join("home"),
        vars: Default::default(),
    };
    fs::create_dir_all(&empty_home.home).unwrap();

    let empty_sources: Vec<(&'static str, Arc<dyn Source>)> = vec![
        (
            plans_harness::ID,
            Arc::new(plans_harness::PlansHarness::new(None, &empty_home.home, 30)),
        ),
        (
            claude_code::ID,
            Arc::new(claude_code::ClaudeCode::new(None, &empty_home.home, 30)),
        ),
        (
            codex::ID,
            Arc::new(codex::Codex::new(None, &empty_home.home, 30)),
        ),
        (
            opencode::ID,
            Arc::new(opencode::OpenCode::new(None, &empty_home.home, 30)),
        ),
        (agy::ID, Arc::new(agy::Agy::new(None, &empty_home.home, 30))),
        (pi::ID, Arc::new(pi::Pi::new(None, &empty_home.home, 30))),
    ];
    for (id, src) in empty_sources {
        let (budget, detection, batch, _) =
            turn(src.as_ref(), &empty_home, Cursor(0), || None).await;
        assert!(
            matches!(detection, Detection::NotDetected { .. }),
            "{id}: an absent root must be reported not-detected, never detected"
        );
        assert!(
            batch.items.is_empty(),
            "{id}: an absent root must emit nothing, got {:?}",
            batch.items
        );
        assert_caps("absent root", &budget, &batch, None);
        let (budget2, _, batch2, _) = turn(src.as_ref(), &empty_home, Cursor(1), || None).await;
        assert!(batch2.items.is_empty(), "{id}: absent root stays silent");
        assert_eq!(budget2.used(), 0, "{id}: absent root must charge nothing");
        // An absent root may cost a bounded directory probe (one visit to open the missing root) but it must
        // return no entries, charge no bytes and never spin.
        assert!(
            budget2.usage().entries.used == 0,
            "{id}: an absent root must not charge returned entries: {:?}",
            budget2.usage()
        );
        assert!(
            budget2.usage().visits.used <= 4,
            "{id}: an absent root must not charge unbounded visit work: {:?}",
            budget2.usage()
        );
    }

    // Unreadable project directory, then recovery.
    let project = fx.home.join(".claude/projects/-bulk");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(&project).unwrap().permissions();
        perm.set_mode(0o000);
        fs::set_permissions(&project, perm).unwrap();
        let src = claude_code::ClaudeCode::new(None, &fx.home, 30);
        let (budget, _, batch, st) = turn(&src, &env, Cursor(0), || work!(src)).await;
        assert_caps("unreadable root", &budget, &batch, st);
        // Absence of files is unproven while the directory cannot be read.
        assert!(
            !src.discovery_complete(),
            "discovery must never claim a complete sweep over an unreadable directory"
        );
        let mut perm = fs::metadata(&project).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&project, perm).unwrap();

        let mut cursor = Cursor(1);
        let mut seen = BTreeSet::new();
        for _ in 0..12 {
            let (budget, _, batch, st) = turn(&src, &env, cursor, || work!(src)).await;
            assert_caps("claude recovery turn", &budget, &batch, st);
            cursor = advance(cursor, batch.next);
            for s in units(claude_code::ID, &batch) {
                seen.insert(s);
            }
            if seen.len() == 420 {
                break;
            }
        }
        assert_eq!(
            seen.len(),
            420,
            "recovery after the unreadable directory must re-ingest every supported file"
        );
    }
}

/// The real scheduler over all six sources at once: every source is served, seqs are per-source monotonic, and
/// begin_turn/end_turn stay balanced (one allowance per turn).
#[tokio::test]
async fn scheduled_poller_serves_all_six_sources_fairly() {
    let fx = Fixture::new();
    let data = tempfile::tempdir().unwrap();
    let store = Store::open(&data.path().join("state.db")).unwrap();
    let bus = Arc::new(Bus::new(store.clone()).unwrap());
    let mut watched: Vec<(&'static str, Arc<Watched>)> = Vec::new();
    let mut sources: Vec<Arc<dyn Source>> = Vec::new();
    for (id, src) in fx.sources() {
        let w = Watched::new(src);
        watched.push((id, w.clone()));
        sources.push(w);
    }
    let (refresh_tx, refresh) = watch::channel(0u64);
    std::mem::forget(refresh_tx);
    let (stop, stop_rx) = watch::channel(false);
    let deps = PollerDeps {
        store: store.clone(),
        bus,
        sources: Arc::new(sources),
        runtimes: Arc::new(Vec::new()),
        status: Arc::new(StatusCache::new()),
        env: fx.env(),
        intervals: Intervals {
            poll: Duration::from_millis(50),
            discover: Duration::from_millis(50),
        },
        refresh,
    };
    let handle = spawn_poller(deps, stop_rx);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;

    let c = Connection::open(data.path().join("state.db")).unwrap();
    for (id, w) in &watched {
        let rows: i64 = c
            .query_row("SELECT COUNT(*) FROM events WHERE source=?1", [*id], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(rows > 0, "{id}: the shared scheduler starved this source");
        assert!(
            w.begins() > 0 && w.begins() == w.ends(),
            "{id}: begin_turn/end_turn must stay balanced, got {}/{}",
            w.begins(),
            w.ends()
        );
        for used in w.used_per_turn() {
            assert!(
                used <= TURN_ALLOWANCE_BYTES,
                "{id}: a scheduled turn used {used} bytes, above the shared allowance"
            );
        }
        let usages = w.usage_per_turn();
        assert!(
            !usages.is_empty(),
            "{id}: the scheduler completed no measured turn"
        );
        for usage in &usages {
            assert!(
                usage.entries.used <= TURN_ALLOWANCE_ENTRIES,
                "{id}: a scheduled turn returned {} entries, above the shared {TURN_ALLOWANCE_ENTRIES} cap: {usage:?}",
                usage.entries.used
            );
            assert!(
                usage.visits.used <= TURN_ALLOWANCE_VISITS,
                "{id}: a scheduled turn performed {} work visits, above the shared {TURN_ALLOWANCE_VISITS} cap: {usage:?}",
                usage.visits.used
            );
        }
        assert!(
            usages
                .iter()
                .any(|u| u.bytes.used > 0 || u.entries.used > 0 || u.visits.used > 0),
            "{id}: the scheduler served this source but every turn charged nothing: {usages:?}"
        );
        let mut st = c
            .prepare("SELECT seq FROM events WHERE source=?1 ORDER BY seq")
            .unwrap();
        let seqs: Vec<u64> = st
            .query_map([*id], |r| Ok(r.get::<_, i64>(0)? as u64))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            seqs.windows(2).all(|w| w[0] < w[1]),
            "{id}: stored seq must strictly increase"
        );
        let state_rows = store.load_file_state(id).unwrap();
        assert!(
            !state_rows.is_empty() || *id == opencode::ID,
            "{id}: a served source must persist its checkpoint state"
        );
    }

    let total: i64 = c
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert!(
        total < 20_000,
        "six bounded sources produced {total} events in 800 ms, which is not a bounded cadence"
    );
}

/// Shutdown while the scheduler is running: every in-flight turn is closed (no half-open turn) for all six
/// adapters, and no allowance was ever exceeded.
#[tokio::test]
async fn scheduled_shutdown_closes_every_turn_for_all_six() {
    let fx = Fixture::new();
    let data = tempfile::tempdir().unwrap();
    let store = Store::open(&data.path().join("state.db")).unwrap();
    let bus = Arc::new(Bus::new(store.clone()).unwrap());
    let mut watched: Vec<(&'static str, Arc<Watched>)> = Vec::new();
    let mut sources: Vec<Arc<dyn Source>> = Vec::new();
    for (id, src) in fx.sources() {
        let w = Watched::new(src);
        watched.push((id, w.clone()));
        sources.push(w);
    }
    let (refresh_tx, refresh) = watch::channel(0u64);
    std::mem::forget(refresh_tx);
    let (stop, stop_rx) = watch::channel(false);
    let deps = PollerDeps {
        store,
        bus,
        sources: Arc::new(sources),
        runtimes: Arc::new(Vec::new()),
        status: Arc::new(StatusCache::new()),
        env: fx.env(),
        intervals: Intervals {
            poll: Duration::from_millis(10),
            discover: Duration::from_millis(10),
        },
        refresh,
    };
    let handle = spawn_poller(deps, stop_rx);
    tokio::time::sleep(Duration::from_millis(120)).await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
    for (id, w) in &watched {
        assert_eq!(
            w.begins(),
            w.ends(),
            "{id}: shutdown left {} turn(s) open ({} begin / {} end)",
            w.begins().saturating_sub(w.ends()),
            w.begins(),
            w.ends()
        );
        assert!(
            w.begins() > 0,
            "{id}: the scheduler never served this source"
        );
        for used in w.used_per_turn() {
            assert!(
                used <= TURN_ALLOWANCE_BYTES,
                "{id}: a cancelled turn used {used} bytes above the allowance"
            );
        }
        for usage in w.usage_per_turn() {
            assert!(
                usage.entries.used <= TURN_ALLOWANCE_ENTRIES
                    && usage.visits.used <= TURN_ALLOWANCE_VISITS,
                "{id}: a cancelled turn exceeded an entry/visit cap: {usage:?}"
            );
        }
    }
}

/// Deterministic attempted-operation trace across all six production adapters (v6 V6.5): one scheduled
/// turn on the shared fixture, attempted enumerator/metadata/open/read counters reported per adapter,
/// every class inside its stated ceiling, and the totals identical across two identical fixtures
/// (deterministic: counts do not depend on directory iteration order). Application counters only;
/// strace is unavailable on this host, so no kernel I/O claim is made or implied.
#[tokio::test]
async fn attempted_work_trace_all_six_is_deterministic_and_bounded() {
    macro_rules! traced_turn {
        ($src:expr, $env:expr) => {{
            let src = &$src;
            let budget = TurnBudget::default_allowance();
            src.begin_turn(budget.clone());
            let baseline = work_full!(src);
            let _ = src.detect($env);
            let _ = src.poll(Cursor(0)).await.unwrap();
            src.end_turn();
            sub_work(baseline, work_full!(src))
        }};
    }

    async fn run_all(fx: &Fixture) -> Vec<(&'static str, (u64, u64, u64, u64, u64))> {
        let env = fx.env();
        let mut out = Vec::new();
        let harness = plans_harness::PlansHarness::new(None, &fx.home, 30);
        out.push((plans_harness::ID, traced_turn!(harness, &env)));
        let claude = claude_code::ClaudeCode::new(None, &fx.home, 30);
        out.push((claude_code::ID, traced_turn!(claude, &env)));
        let codex = codex::Codex::new(None, &fx.home, 30);
        out.push((codex::ID, traced_turn!(codex, &env)));
        let oc = opencode::OpenCode::new(None, &fx.home, 30);
        out.push((opencode::ID, traced_turn!(oc, &env)));
        let agy = agy::Agy::new(None, &fx.home, 30);
        out.push((agy::ID, traced_turn!(agy, &env)));
        let pi = pi::Pi::new(None, &fx.home, 30);
        out.push((pi::ID, traced_turn!(pi, &env)));
        out
    }

    let fx1 = Fixture::new();
    let first = run_all(&fx1).await;
    let fx2 = Fixture::new();
    let second = run_all(&fx2).await;
    assert_eq!(first.len(), 6, "the trace covers all six adapters");
    for ((id, d1), (_, d2)) in first.iter().zip(second.iter()) {
        assert_trace_ceiling(id, *d1);
        assert!(
            attempted_total(*d1) > 0,
            "{id}: a first turn on a populated fixture must attempt real enumerator/metadata/open work"
        );
        assert_eq!(
            d1, d2,
            "{id}: the attempted trace must be deterministic across identical fixtures"
        );
        eprintln!("{id}: attempted {:?} total {}", d1, attempted_total(*d1));
    }
    // OpenCode's counters reset in begin_turn, so its traced value must be the per-turn value itself,
    // not a saturated zero delta: a zero trace here would prove the masking bug is back.
    let oc = first.iter().find(|(id, _)| *id == opencode::ID).unwrap().1;
    assert!(
        oc.0 > 0 || oc.1 > 0,
        "opencode: per-turn attempted work must be visible after the begin_turn reset, got {oc:?}"
    );
}

/// Decreasing-work regression (v6 V6.4/V6.5): as the bounded drain consumes the fixture, per-turn
/// attempted work must fall, the settled turn must attempt strictly less than the first turn, and the
/// total attempted work across the whole drain must stay a constant multiple of the fixture size —
/// never a per-turn population re-scan. Application counters only (see the trace test above).
#[tokio::test]
async fn decreasing_work_regression() {
    let fx = Fixture::new();
    let env = fx.env();
    let src = claude_code::ClaudeCode::new(None, &fx.home, 30);
    let mut cursor = Cursor(0);
    let mut seen: Vec<String> = Vec::new();
    let mut per_turn: Vec<u64> = Vec::new();
    for _ in 0..400 {
        let budget = TurnBudget::default_allowance();
        src.begin_turn(budget.clone());
        let baseline = work_full!(src);
        let _ = src.detect(&env);
        let batch = src.poll(cursor).await.unwrap();
        src.end_turn();
        let d = sub_work(baseline, work_full!(src));
        assert_trace_ceiling(&format!("drain turn {}", per_turn.len() + 1), d);
        per_turn.push(attempted_total(d));
        cursor = advance(cursor, batch.next);
        for u in units(claude_code::ID, &batch) {
            if !seen.contains(&u) {
                seen.push(u);
            }
        }
        if seen.len() >= 420 {
            break;
        }
    }
    assert_eq!(seen.len(), 420, "the fixture must fully drain");
    assert!(
        per_turn.len() >= 2,
        "420 files must page over several turns"
    );

    // One settled turn: unchanged fixture, no new work.
    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    let baseline = work_full!(src);
    let _ = src.detect(&env);
    let settled = src.poll(cursor).await.unwrap();
    src.end_turn();
    let settled_d = sub_work(baseline, work_full!(src));
    assert_trace_ceiling("settled turn", settled_d);
    assert!(settled.items.is_empty(), "a drained fixture must settle");
    let settled_total = attempted_total(settled_d);
    let total: u64 = per_turn.iter().sum();
    eprintln!("per-turn attempted {per_turn:?} settled {settled_total} drain total {total}");
    assert!(
        settled_total < per_turn[0],
        "decreasing work: the settled turn ({settled_total}) must attempt strictly less than the first \
         turn ({}); per-turn {per_turn:?}",
        per_turn[0]
    );
    assert!(
        total <= 7 * 420 + TRACE_TOTAL_CEILING,
        "decreasing work: total attempted work across the drain ({total}) must stay within 7x the fixture \
         size plus one turn ceiling, not grow with turns x population; per-turn {per_turn:?}"
    );
}

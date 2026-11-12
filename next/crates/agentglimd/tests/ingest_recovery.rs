//! Ingestion recovery (v2-r1): a committed batch is exactly the input that was consumed, a failed commit
//! consumes nothing, and re-reading the same source time never silently drops a genuine repeat.
//!
//! Fixture homes are copied from `build/fixtures/` into `tempfile` dirs; every daemon is started on a free
//! port in 19360-19379 and stopped through its own handle/pid.

mod common;

use agentglimd::core::bus::Bus;
use agentglimd::core::{now_ms, BatchItem, ItemKind};
use agentglimd::store::{iso8601_ms, Store};
use common::{free_port, Daemon};
use rusqlite::Connection;
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const FAST: [(&str, &str); 2] = [("AG_POLL_MS", "100"), ("AG_DISCOVER_MS", "300")];
const CLAUDE: &str = "claude-code";
const CLAUDE_FILE: &str = ".claude/projects/-work-other/1b2e3d4c-5a69-4788-9900-aabbccddeeff.jsonl";
const CLAUDE_SESSION: &str = "1b2e3d4c-5a69-4788-9900-aabbccddeeff";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for e in std::fs::read_dir(src).unwrap().flatten() {
        let to = dst.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &to);
        } else {
            std::fs::copy(e.path(), &to).unwrap();
        }
    }
}

/// (tempdir, fixture home holding one claude-code home, data dir)
fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    copy_dir(
        &fixtures().join("claude-code").join("2.0").join("home"),
        &home,
    );
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    (t, home, data)
}

fn start(home: &Path, data: &Path) -> Daemon {
    let h = home.to_str().unwrap().to_string();
    let envs: Vec<(&str, &str)> = vec![("HOME", h.as_str()), FAST[0], FAST[1]];
    Daemon::start_env(data, free_port(), &envs)
}

fn db(data: &Path) -> Connection {
    let c = Connection::open(data.join("state.db")).unwrap();
    c.busy_timeout(Duration::from_secs(5)).unwrap();
    c
}

fn wait_for(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while t0.elapsed() < within {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}

/// One stored event, in the columns ingestion recovery cares about.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    seq: u64,
    kind: String,
    session: Option<String>,
    ts: u64,
    occurred_ms: i64,
    occurrence: Option<String>,
}

fn rows(data: &Path, source: &str) -> Vec<Row> {
    let c = db(data);
    let mut st = c
        .prepare(
            "SELECT seq,kind,session,ts,occurred_ms,occurrence FROM events WHERE source=?1 ORDER BY seq",
        )
        .unwrap();
    st.query_map([source], |r| {
        Ok(Row {
            seq: r.get::<_, i64>(0)? as u64,
            kind: r.get(1)?,
            session: r.get(2)?,
            ts: r.get::<_, i64>(3)? as u64,
            occurred_ms: r.get(4)?,
            occurrence: r.get(5)?,
        })
    })
    .unwrap()
    .map(|r| r.unwrap())
    .collect()
}

fn offsets(data: &Path, source: &str) -> Vec<(String, u64, u64)> {
    let c = db(data);
    let mut st = c
        .prepare("SELECT path,offset,size FROM source_offsets WHERE source=?1 ORDER BY path")
        .unwrap();
    st.query_map([source], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64,
        ))
    })
    .unwrap()
    .map(|r| r.unwrap())
    .collect()
}

/// Waits until `source` has produced no new event for `quiet`, returns the settled rows.
fn settle(data: &Path, source: &str, quiet: Duration, within: Duration) -> Vec<Row> {
    let t0 = Instant::now();
    let mut last = rows(data, source);
    let mut stable = Instant::now();
    while t0.elapsed() < within {
        std::thread::sleep(Duration::from_millis(50));
        let cur = rows(data, source);
        if cur.len() != last.len() {
            last = cur;
            stable = Instant::now();
        } else if stable.elapsed() >= quiet {
            break;
        }
    }
    last
}

/// A complete fixture line of the given shape, with a later date so it is a new observation.
fn fixture_line(text: &str, needle: &str) -> String {
    let line = text
        .lines()
        .find(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("no fixture line containing {needle}"))
        .to_string();
    line.replace("2026-10-31T", "2026-11-02T")
}

fn append_line(file: &Path, line: &str) -> usize {
    let mut fh = std::fs::OpenOptions::new().append(true).open(file).unwrap();
    writeln!(fh, "{line}").unwrap();
    fh.flush().unwrap();
    line.len() + 1
}

fn daemon_log(data: &Path) -> String {
    std::fs::read_to_string(data.join("logs/agentglimd.log")).unwrap_or_default()
}

fn item(kind: ItemKind, session: &str, data: serde_json::Value) -> BatchItem {
    BatchItem {
        kind,
        session: session.to_string(),
        data,
    }
}

#[test]
fn a_failed_commit_consumes_nothing() {
    let (_t, home, data) = setup();
    let mut d = start(&home, &data);
    let before = settle(
        &data,
        CLAUDE,
        Duration::from_millis(400),
        Duration::from_secs(10),
    );
    assert!(!before.is_empty(), "fixture ingested");
    let offs_before = offsets(&data, CLAUDE);
    assert!(
        !offs_before.is_empty(),
        "offsets saved for the fixture files"
    );

    // A new record arrives while the daemon cannot commit.
    let file = home.join(CLAUDE_FILE);
    let text = std::fs::read_to_string(&file).unwrap();
    let added = append_line(&file, &fixture_line(&text, "\"type\":\"user\""));

    // Exclusive write transaction on the daemon's own database, busy timeout 0.
    let holder = Connection::open(data.join("state.db")).unwrap();
    holder.busy_timeout(Duration::ZERO).unwrap();
    let mut held = false;
    for _ in 0..400 {
        if holder.execute_batch("BEGIN IMMEDIATE").is_ok() {
            held = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(held, "could not hold the write lock");

    // The store's busy timeout is 5 s: holding longer makes the daemon's append really fail.
    let t0 = Instant::now();
    std::thread::sleep(Duration::from_millis(6200));

    // Nothing was committed and no offset advanced while the commit was failing.
    assert_eq!(
        rows(&data, CLAUDE),
        before,
        "failed commit inserted nothing"
    );
    assert_eq!(
        offsets(&data, CLAUDE),
        offs_before,
        "offsets did not advance without a commit"
    );
    holder.execute_batch("COMMIT").unwrap();
    drop(holder);

    // Released: the next pass retries the very same record, exactly once.
    wait_for("the retried record", Duration::from_secs(12), || {
        rows(&data, CLAUDE).len() > before.len()
    });
    let retry_ms = t0.elapsed().as_millis();
    std::thread::sleep(Duration::from_millis(1200));
    let after = rows(&data, CLAUDE);
    assert_eq!(after.len(), before.len() + 1, "exactly one retried event");
    let new = after.last().unwrap();
    assert_eq!(new.kind, "step");
    assert_eq!(new.session.as_deref(), Some(CLAUDE_SESSION));
    let rel = file
        .strip_prefix(home.join(".claude/projects"))
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let was = offs_before
        .iter()
        .find(|o| o.0 == rel)
        .map(|o| o.1)
        .unwrap();
    let is = offsets(&data, CLAUDE)
        .into_iter()
        .find(|o| o.0 == rel)
        .map(|o| o.1)
        .unwrap();
    assert_eq!(
        is,
        was + added as u64,
        "offset advanced by exactly the appended bytes"
    );
    let log = daemon_log(&data);
    assert!(
        log.contains("append batch failed"),
        "the failure was logged with its source and item count: {log}"
    );

    assert!(d.term(Duration::from_secs(10)).unwrap().success());
    eprintln!("commit-failure retry latency: {retry_ms} ms (6.2 s of it held deliberately)");
}

#[test]
fn b_restart_after_commit_has_no_duplicates() {
    let (_t, home, data) = setup();
    let mut d = start(&home, &data);
    let before = settle(
        &data,
        CLAUDE,
        Duration::from_millis(400),
        Duration::from_secs(10),
    );
    assert!(before.len() > 3, "fixture ingested: {}", before.len());
    let offs_before = offsets(&data, CLAUDE);
    // Crash right after the events exist: no client has read anything, nothing else ran.
    d.kill9();
    let crash = Instant::now();

    let mut d2 = start(&home, &data);
    let restart_ms = crash.elapsed().as_millis();
    std::thread::sleep(Duration::from_millis(1500));
    let after = rows(&data, CLAUDE);
    assert_eq!(
        after, before,
        "restart on the same data dir re-inserted or dropped nothing"
    );
    assert_eq!(offsets(&data, CLAUDE), offs_before, "offsets restored");
    // seq stays monotonic and consecutive for what is stored.
    let seqs: Vec<u64> = after.iter().map(|r| r.seq).collect();
    assert_eq!(
        seqs,
        (seqs[0]..seqs[0] + seqs.len() as u64).collect::<Vec<_>>()
    );
    // Occurrence time is historical for the fixture (October records, ingested now).
    let now = now_ms();
    for r in after.iter().filter(|r| r.kind != "error") {
        assert!(r.occurred_ms > 0, "occurrence time kept for {r:?}");
        assert!(
            (r.occurred_ms as u64) < now,
            "occurrence is older than the observation: {r:?}"
        );
    }
    let term = Instant::now();
    assert!(d2.term(Duration::from_secs(10)).unwrap().success());
    eprintln!(
        "restart dedup: {} events before and after SIGKILL+restart; crash-to-healthy {restart_ms} ms; SIGTERM exit {} ms",
        after.len(),
        term.elapsed().as_millis()
    );
}

#[test]
fn c_append_after_restart_needs_no_new_header() {
    let (_t, home, data) = setup();
    let mut d = start(&home, &data);
    let before = settle(
        &data,
        CLAUDE,
        Duration::from_millis(400),
        Duration::from_secs(10),
    );
    assert!(d.term(Duration::from_secs(10)).unwrap().success());

    // One assistant line with usage: a `step` and a `spend` item, model included in the line itself.
    let file = home.join(CLAUDE_FILE);
    let text = std::fs::read_to_string(&file).unwrap();
    let line = fixture_line(&text, "\"type\":\"assistant\"");
    assert!(line.contains("\"usage\""), "chosen line carries usage");
    append_line(&file, &line);

    let mut d2 = start(&home, &data);
    wait_for("the appended record", Duration::from_secs(10), || {
        rows(&data, CLAUDE).len() > before.len()
    });
    std::thread::sleep(Duration::from_millis(1200));
    let after = rows(&data, CLAUDE);
    let new: Vec<&Row> = after
        .iter()
        .filter(|r| r.seq > before.last().unwrap().seq)
        .collect();
    assert_eq!(
        new.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(),
        vec!["step", "spend"],
        "one appended line, no extra session header"
    );
    assert!(
        new.iter()
            .all(|r| r.session.as_deref() == Some(CLAUDE_SESSION)),
        "both items keep their session attribution: {new:?}"
    );
    // Attributed from the line itself (claude-code reads `message.model`); a line without a model after a
    // restart would get `null` because the parser's fallback model is in memory only - see REPORT.md.
    let c = db(&data);
    let model: Option<String> = c
        .query_row(
            "SELECT json_extract(data,'$.model') FROM events WHERE source=?1 AND kind='step' ORDER BY seq DESC LIMIT 1",
            [CLAUDE],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(model.as_deref(), Some("claude-opus-4-1"));
    assert!(
        after
            .iter()
            .filter(|r| r.seq > before.last().unwrap().seq)
            .all(|r| r.occurrence.is_none()),
        "offset-bearing sources identify records by file offset, not by occurrence"
    );
    assert!(d2.term(Duration::from_secs(10)).unwrap().success());
}

#[test]
fn d_offset_less_a_b_a_keeps_every_occurrence() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.db")).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let a1 = item(
        ItemKind::Step,
        "s1",
        json!({"text": "A", "ts": "2026-10-30T09:00:00.000Z"}),
    );
    let b = item(
        ItemKind::Step,
        "s1",
        json!({"text": "B", "ts": "2026-10-30T09:00:01.000Z"}),
    );
    let a2 = item(
        ItemKind::Step,
        "s1",
        json!({"text": "A", "ts": "2026-10-30T09:00:02.000Z"}),
    );
    let batch = [a1.clone(), b.clone(), a2.clone()];
    let first = bus.append_batch("fake", &batch, &[]).unwrap();
    assert_eq!(first.len(), 3, "A -> B -> A keeps the second A");
    assert_eq!(
        first.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "consecutive seq in insertion order"
    );
    let keys: Vec<String> = rows(dir.path(), "fake")
        .into_iter()
        .map(|r| r.occurrence.expect("offset-less rows carry an occurrence"))
        .collect();
    assert_eq!(keys.len(), 3);
    assert!(
        keys.iter().collect::<std::collections::BTreeSet<_>>().len() == 3,
        "each observation has its own identity: {keys:?}"
    );

    // Re-reading the same batch (same records, same source times) inserts nothing.
    assert!(bus.append_batch("fake", &batch, &[]).unwrap().is_empty());
    assert_eq!(rows(dir.path(), "fake").len(), 3);
}

#[test]
fn e_identical_repeats_in_one_batch_are_kept_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.db")).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    // The same usage record twice for one message: identical content AND identical occurrence time.
    let usage = item(
        ItemKind::Spend,
        "s1",
        json!({"model": "m", "ts": "2026-10-30T09:00:00.000Z", "input_tokens": 10}),
    );
    let batch = [usage.clone(), usage.clone()];
    let evs = bus.append_batch("fake", &batch, &[]).unwrap();
    assert_eq!(evs.len(), 2, "both genuine repeats kept");
    assert_ne!(
        rows(dir.path(), "fake")[0].occurrence,
        rows(dir.path(), "fake")[1].occurrence,
        "repeat index distinguishes them inside one batch"
    );
    assert!(
        bus.append_batch("fake", &batch, &[]).unwrap().is_empty(),
        "a re-poll of the same batch adds none"
    );
}

#[test]
fn f_historical_occurrence_time_survives() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.db")).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let observed_from = now_ms();
    // Same instant, three encodings an adapter may use.
    let iso = item(
        ItemKind::Step,
        "s1",
        json!({"ts": "2026-10-30T09:00:04.000Z"}),
    );
    let ms = item(ItemKind::Step, "s1", json!({"ts": 1793350804000i64}));
    let secs = item(ItemKind::Step, "s1", json!({"at": 1793350804i64}));
    bus.append_batch("fake", &[iso, ms, secs], &[]).unwrap();
    let observed_to = now_ms();
    for r in rows(dir.path(), "fake") {
        assert_eq!(r.occurred_ms, 1793350804000, "occurrence time from {r:?}");
        assert!(
            r.ts >= observed_from && r.ts <= observed_to,
            "ts stays the observation time, not the source time: {r:?}"
        );
    }
    assert_eq!(iso8601_ms("2026-10-30T09:00:04.000Z"), Some(1793350804000));
    assert_eq!(iso8601_ms("2026-10-30T11:00:04+02:00"), Some(1793350804000));
    assert_eq!(iso8601_ms("not a time"), None);
}

#[test]
fn g_pruning_keeps_ingestion_and_offsets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = Store::open(&path).unwrap();
    let day = 86_400_000u64;
    // Two old daemon-style rows, older than the 30-day window.
    for seq in [100u64, 101] {
        store
            .insert_event(&agentglimd::core::Event {
                seq,
                kind: "task".into(),
                source: "daemon".into(),
                ts: now_ms() - 40 * day,
                data: json!({}),
            })
            .unwrap();
    }
    let bus = Bus::new(store.clone()).unwrap();
    bus.append_batch(
        "claude-code",
        &[item(
            ItemKind::Step,
            "s1",
            json!({"ts": "2026-10-30T09:00:00.000Z"}),
        )],
        &[agentglimd::core::FileOffset {
            path: "a.jsonl".into(),
            offset: 40,
            size: 40,
        }],
    )
    .unwrap();
    let pruned = store.prune_events(30).unwrap();
    assert_eq!(pruned, 2, "only the old rows went");
    assert_eq!(store.max_seq().unwrap(), 102);
    assert_eq!(
        store.load_offsets("claude-code").unwrap().len(),
        1,
        "pruning does not touch the cursor table"
    );
    // Ingestion still works and seq stays monotonic after the prune.
    let evs = bus
        .append_batch(
            "claude-code",
            &[item(
                ItemKind::Step,
                "s1",
                json!({"ts": "2026-10-30T09:00:02.000Z"}),
            )],
            &[agentglimd::core::FileOffset {
                path: "a.jsonl".into(),
                offset: 90,
                size: 90,
            }],
        )
        .unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].seq, 103, "seq continues after pruning");
    assert_eq!(
        store.load_offsets("claude-code").unwrap(),
        vec![agentglimd::core::FileOffset {
            path: "a.jsonl".into(),
            offset: 90,
            size: 90
        }]
    );
}

#[test]
fn h_source_disabled_in_config_is_absent_after_restart() {
    let (_t, home, data) = setup();
    let mut d = start(&home, &data);
    let before = settle(
        &data,
        CLAUDE,
        Duration::from_millis(400),
        Duration::from_secs(10),
    );
    assert!(!before.is_empty());
    let offs_before = offsets(&data, CLAUDE);
    assert!(d.term(Duration::from_secs(10)).unwrap().success());

    // Config is read at startup: this takes effect on the next start, not live (see docs/lifecycle.md).
    std::fs::write(
        data.join("config.json"),
        serde_json::to_vec(&json!({"sources": {"claude-code": false}})).unwrap(),
    )
    .unwrap();
    // A new record that would be ingested if the source were still enabled.
    let file = home.join(CLAUDE_FILE);
    let text = std::fs::read_to_string(&file).unwrap();
    append_line(&file, &fixture_line(&text, "\"type\":\"user\""));

    let mut d2 = start(&home, &data);
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(
        rows(&data, CLAUDE),
        before,
        "disabled source produced no event"
    );
    assert_eq!(
        offsets(&data, CLAUDE),
        offs_before,
        "stored offsets were not replayed"
    );
    let status = common::client()
        .get(d2.url("/status"))
        .header("Authorization", format!("Bearer {}", d2.token))
        .send()
        .unwrap();
    assert_eq!(status.status(), 200);
    let body: serde_json::Value = status.json().unwrap();
    let ids: Vec<&str> = body["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["id"].as_str())
        .collect();
    assert!(
        !ids.contains(&CLAUDE),
        "no status entry for a disabled source: {ids:?}"
    );
    assert!(d2.term(Duration::from_secs(10)).unwrap().success());
}

#[test]
fn i_fake_source_is_offset_less_but_still_identified() {
    let (_t, home, data) = setup();
    std::fs::write(
        data.join("config.json"),
        serde_json::to_vec(&json!({"sources": {"claude-code": false, "fake": true}})).unwrap(),
    )
    .unwrap();
    let mut d = start(&home, &data);
    wait_for("fake heartbeats", Duration::from_secs(10), || {
        rows(&data, "fake").len() >= 2
    });
    let rows_fake = rows(&data, "fake");
    assert!(
        rows_fake.iter().all(|r| r.occurrence.is_some()),
        "offset-less source rows carry an occurrence identity"
    );
    let keys: std::collections::BTreeSet<&String> = rows_fake
        .iter()
        .filter_map(|r| r.occurrence.as_ref())
        .collect();
    assert_eq!(keys.len(), rows_fake.len(), "no repeated identity");
    assert!(d.term(Duration::from_secs(10)).unwrap().success());
}

#[test]
fn j_file_state_round_trip() {
    // Storage for the v2-r2 parser-state wiring: written and read back exactly, no adapter uses it yet.
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.db")).unwrap();
    assert!(store.load_file_state("claude-code").unwrap().is_empty());
    let row = agentglimd::store::FileStateRow {
        source: "claude-code".into(),
        path: "-work-other/s1.jsonl".into(),
        size: 4096,
        mtime_ms: 1793350804000,
        fingerprint: "sha256:deadbeef".into(),
        session: Some("s1".into()),
        model: Some("claude-opus-4-1".into()),
        generation: 7,
        offset: 128,
        discarded_bytes: 3,
        incomplete: true,
        announced: true,
        revision: Some("rev-1".into()),
    };
    store.save_file_state(&row).unwrap();
    assert_eq!(
        store.load_file_state("claude-code").unwrap(),
        vec![row.clone()]
    );
    let updated = agentglimd::store::FileStateRow {
        size: 8192,
        model: None,
        ..row.clone()
    };
    store.save_file_state(&updated).unwrap();
    assert_eq!(store.load_file_state("claude-code").unwrap(), vec![updated]);
}

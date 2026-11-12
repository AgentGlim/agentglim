//! Poll loop: the daemon tails fixture sources into SQLite, durably and without duplicates across restarts.
mod common;
use common::{free_port, Daemon};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const FAST: [(&str, &str); 2] = [("AG_POLL_MS", "100"), ("AG_DISCOVER_MS", "300")];

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

const SETS: [(&str, &str, &str); 3] = [
    ("claude-code", "claude-code", "2.0"),
    ("codex", "codex", "0.50"),
    ("plans-harness", "plans-harness", "v1-r2"),
];

/// (tempdir, home, data): one HOME holding the three fixture homes together.
fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    for (_, dir, ver) in SETS {
        copy_dir(&fixtures().join(dir).join(ver).join("home"), &home);
    }
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    (t, home, data)
}

fn expected(dir: &str, ver: &str) -> BTreeMap<String, usize> {
    let v: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join(dir).join(ver).join("expected.json")).unwrap(),
    )
    .unwrap();
    let mut m = BTreeMap::new();
    for it in v.as_array().unwrap() {
        *m.entry(it["kind"].as_str().unwrap().to_string())
            .or_insert(0) += 1;
    }
    m
}

fn db(data: &Path) -> rusqlite::Connection {
    let c = rusqlite::Connection::open(data.join("state.db")).unwrap();
    c.busy_timeout(Duration::from_secs(5)).unwrap();
    c
}

fn counts(data: &Path, source: &str) -> BTreeMap<String, usize> {
    let c = db(data);
    let mut st = c
        .prepare("SELECT kind, COUNT(*) FROM events WHERE source=?1 GROUP BY kind")
        .unwrap();
    st.query_map([source], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
    })
    .unwrap()
    .map(|r| r.unwrap())
    .collect()
}

fn total(data: &Path) -> i64 {
    db(data)
        .query_row(
            "SELECT COUNT(*) FROM events WHERE source != 'daemon' AND source != 'task'",
            [],
            |r| r.get(0),
        )
        .unwrap()
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

fn all_ingested(data: &Path) -> bool {
    SETS.iter()
        .all(|(id, dir, ver)| counts(data, id) == expected(dir, ver))
}

fn start(home: &Path, data: &Path) -> Daemon {
    let h = home.to_str().unwrap();
    let envs = [("HOME", h), FAST[0], FAST[1]];
    Daemon::start_env(data, free_port(), &envs)
}

#[test]
fn a_events_hold_every_expected_item() {
    let (_t, home, data) = setup();
    let mut d = start(&home, &data);
    wait_for("all fixture items stored", Duration::from_secs(5), || {
        all_ingested(&data)
    });
    for (id, dir, ver) in SETS {
        assert_eq!(counts(&data, id), expected(dir, ver), "{id}");
    }
    assert!(d.term(Duration::from_secs(10)).unwrap().success());
}

#[test]
fn b_restart_on_same_data_dir_keeps_count() {
    let (_t, home, data) = setup();
    let mut d = start(&home, &data);
    wait_for("ingest", Duration::from_secs(5), || all_ingested(&data));
    let before = total(&data);
    assert!(d.term(Duration::from_secs(10)).unwrap().success());
    let mut d2 = start(&home, &data);
    // several poll and discovery cycles at the fast intervals
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(total(&data), before, "no duplicates after restart");
    assert!(all_ingested(&data));
    let offs: i64 = db(&data)
        .query_row("SELECT COUNT(*) FROM source_offsets", [], |r| r.get(0))
        .unwrap();
    assert!(offs >= 3, "offsets stored for the jsonl files, got {offs}");
    assert!(d2.term(Duration::from_secs(10)).unwrap().success());
}

#[test]
fn c_appended_line_adds_exactly_one_event() {
    let (_t, home, data) = setup();
    let f = home.join(".claude/projects/-work-other/1b2e3d4c-5a69-4788-9900-aabbccddeeff.jsonl");
    // This fixture file ends with a complete line; the appended line must be the only unconsumed one.
    let text = std::fs::read_to_string(&f).unwrap();
    assert!(text.ends_with('\n'));
    let mut d = start(&home, &data);
    wait_for("ingest", Duration::from_secs(5), || all_ingested(&data));
    let before = counts(&data, "claude-code");
    let n_before: usize = before.values().sum();
    let first = text;
    // reuse a real user line shape (one step item, no usage) from the same file, with a new timestamp
    let line = first
        .lines()
        .find(|l| l.contains("\"type\":\"user\"") && !l.contains("usage"))
        .expect("user line without usage in fixture")
        .replace("2026-10-31T", "2026-11-02T");
    let mut fh = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
    writeln!(fh, "{line}").unwrap();
    drop(fh);
    wait_for("one new event", Duration::from_secs(5), || {
        counts(&data, "claude-code").values().sum::<usize>() > n_before
    });
    std::thread::sleep(Duration::from_millis(800));
    let after: usize = counts(&data, "claude-code").values().sum();
    assert_eq!(after, n_before + 1, "exactly one new event");
    assert!(d.term(Duration::from_secs(10)).unwrap().success());
}

#[tokio::test(start_paused = true)]
async fn d_ten_minute_jump_polls_once() {
    use agentglimd::core::poller::run_loop;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use tokio::sync::watch;
    let (_keep, refresh) = watch::channel(0u64);
    let (stop, stop_rx) = watch::channel(false);
    let n = Arc::new(AtomicU32::new(0));
    let n2 = n.clone();
    let h = tokio::spawn(run_loop(
        Duration::from_secs(2),
        Duration::from_secs(15),
        refresh,
        stop_rx,
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
    let base = n.load(Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(600)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    let ran = n.load(Ordering::SeqCst) - base;
    assert!(
        (1..=2).contains(&ran),
        "closure ran {ran} times after the jump, expected one (not ~300)"
    );
    stop.send(true).unwrap();
    h.await.unwrap();
}

// ------------------------------------- bounded shutdown under a sustained synthetic backlog (v4-r3 step 5)

/// One synthetic Claude Code home with `files` supported session files, one assistant record each. A single
/// bounded poll visits at most 200 files and a single discovery sweep enumerates at most 200 entries, so this tree
/// needs at least ten passes per phase: the daemon is genuinely mid-backlog when it is signalled. Fixture-only;
/// no real transcript is read.
fn write_claude_backlog(root: &Path, files: usize) -> (u64, usize) {
    let dir = root.join("-work-backlog");
    std::fs::create_dir_all(&dir).unwrap();
    let mut bytes = 0u64;
    for i in 0..files {
        let text = format!(
            "{{\"type\":\"assistant\",\"pad\":\"{}\",\"cwd\":\"/work/demo\",\"sessionId\":\"backlog-{i:05}\",\"version\":\"2.0.14\",\"gitBranch\":\"main\",\"message\":{{\"role\":\"assistant\",\"model\":\"backlog-model\",\"content\":[{{\"type\":\"text\",\"text\":\"step {i}\"}}],\"usage\":{{\"input_tokens\":3,\"output_tokens\":2}}}},\"uuid\":\"backlog-u{i:05}\",\"timestamp\":\"2026-11-01T10:00:00.000Z\"}}\n",
            "x".repeat(600)
        );
        bytes += text.len() as u64;
        std::fs::write(dir.join(format!("s{i:05}.jsonl")), text).unwrap();
    }
    (bytes, files)
}

fn kind_count(data: &Path, source: &str, kind: &str) -> i64 {
    db(data)
        .query_row(
            "SELECT COUNT(*) FROM events WHERE source=?1 AND kind=?2",
            rusqlite::params![source, kind],
            |r| r.get(0),
        )
        .unwrap()
}

fn duplicate_producer_keys(data: &Path, source: &str) -> i64 {
    db(data)
        .query_row(
            "SELECT COUNT(*) - COUNT(DISTINCT producer) FROM events WHERE source=?1 AND producer IS NOT NULL",
            [source],
            |r| r.get(0),
        )
        .unwrap()
}

/// SIGTERM while the daemon is genuinely mid-drain of a bounded synthetic Claude Code backlog: the owned child
/// (signalled by its saved PID, never by a pattern) exits 0 well inside 10 s and is reaped, the persisted state is
/// a clean checkpoint (no tombstones, no partial batch), and a restart finishes the backlog with every record
/// stored exactly once - no interrupted rerun and no duplicate. Prints the physical evidence as `EBACKLOG {...}`.
#[test]
fn e_sigterm_during_sustained_backlog_is_bounded_and_durable() {
    const FILES: usize = 2000; // >= 10 bounded poll/discovery passes each
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let root = home.join(".claude/projects");
    let (bytes, files) = write_claude_backlog(&root, FILES);
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let h = home.to_str().unwrap();
    let envs = [
        ("HOME", h),
        ("AG_POLL_MS", "200"),
        ("AG_DISCOVER_MS", "100"),
    ];

    let mut d = Daemon::start_env(&data, free_port(), &envs);
    wait_for("the first backlog records", Duration::from_secs(15), || {
        kind_count(&data, "claude-code", "step") > 0
    });
    let steps_before = kind_count(&data, "claude-code", "step");
    assert!(
        steps_before < files as i64,
        "the fixture really is a sustained backlog at SIGTERM: {steps_before}/{files} records stored"
    );

    let t0 = Instant::now();
    let status = d
        .term(Duration::from_secs(10))
        .expect("the owned daemon exits within 10 s of SIGTERM");
    let elapsed = t0.elapsed();
    assert!(status.success(), "clean shutdown exit status: {status}");
    assert!(
        elapsed < Duration::from_secs(10),
        "shutdown took {elapsed:?}"
    );
    assert!(
        d.child.is_none(),
        "the owned child was reaped after being signalled by its saved PID"
    );

    // Durable interrupted state: a readable store with the committed prefix and no removal certified mid-scan.
    let interrupted_steps = kind_count(&data, "claude-code", "step");
    assert!(interrupted_steps >= steps_before);
    assert!(interrupted_steps < files as i64);
    assert_eq!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='claude-code'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0,
        "an interrupted scan never certifies removals"
    );
    assert!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM source_file_state WHERE source='claude-code'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
            > 0,
        "the committed per-file checkpoints survive the interrupt"
    );

    // Restart on the same data dir: finish the backlog without an interrupted rerun or a duplicate.
    let mut d2 = Daemon::start_env(&data, free_port(), &envs);
    wait_for("the backlog to drain", Duration::from_secs(60), || {
        kind_count(&data, "claude-code", "step") == files as i64
    });
    std::thread::sleep(Duration::from_millis(800));
    let steps = kind_count(&data, "claude-code", "step");
    let spends = kind_count(&data, "claude-code", "spend");
    let sessions = kind_count(&data, "claude-code", "session");
    let duplicates = duplicate_producer_keys(&data, "claude-code");
    assert_eq!(steps, files as i64, "every record stored exactly once");
    assert_eq!(spends, files as i64, "every usage observation stored once");
    assert_eq!(sessions, files as i64, "one session announcement per file");
    assert_eq!(duplicates, 0, "no duplicated producer identity");
    assert!(d2.term(Duration::from_secs(10)).unwrap().success());

    println!(
        "EBACKLOG {{\"files\":{files},\"records\":{files},\"fixture_bytes\":{bytes},\"steps_at_sigterm\":{steps_before},\"steps_after_restart\":{steps},\"shutdown_exit\":0,\"shutdown_ms\":{},\"child_reaped\":true,\"duplicate_producer_keys\":{duplicates}}}",
        elapsed.as_millis()
    );
}

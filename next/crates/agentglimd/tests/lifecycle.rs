//! Lifecycle matrix rows 2, 3 and 5 (docs/lifecycle.md) plus config refusal.
mod common;
use common::{client, spawn, Daemon};
use serde_json::json;
use std::time::{Duration, Instant};

fn task_state(data: &std::path::Path, id: &str) -> String {
    let uri = format!("file:{}?mode=ro", data.join("state.db").display());
    let c = rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    c.query_row("SELECT state FROM tasks WHERE id=?1", [id], |r| r.get(0))
        .unwrap()
}

#[test]
fn sigterm_exits_zero_and_marks_running_task_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let mut d = Daemon::start(dir.path());
    let r = client()
        .post(d.url("/tasks"))
        .header("Authorization", format!("Bearer {}", d.token))
        .json(&json!({"id": "long-1", "kind": "sleep", "ms": 600000}))
        .send()
        .unwrap();
    assert_eq!(r.status(), 201);
    let t0 = Instant::now();
    let st = d.term(Duration::from_secs(10)).expect("exit within 10 s");
    assert!(st.success(), "exit status {st}");
    assert!(t0.elapsed() < Duration::from_secs(10));
    assert_eq!(task_state(dir.path(), "long-1"), "interrupted");
    assert!(
        !dir.path().join("daemon.lock").exists(),
        "clean exit removes the lock"
    );
}

#[test]
fn kill9_restart_reclaims_stale_lock_and_never_reruns() {
    let dir = tempfile::tempdir().unwrap();
    let mut d = Daemon::start(dir.path());
    let auth = format!("Bearer {}", d.token);
    client()
        .post(d.url("/tasks"))
        .header("Authorization", &auth)
        .json(&json!({"id": "crash-1", "kind": "sleep", "ms": 600000}))
        .send()
        .unwrap();
    let old_pid = d.pid();

    // A second daemon on the same data dir is refused while the first is alive.
    let mut second = spawn(dir.path(), common::free_port());
    let st = second.wait().unwrap();
    assert_eq!(st.code(), Some(3), "live lock must refuse start");

    d.kill9();
    let lock = std::fs::read_to_string(dir.path().join("daemon.lock")).unwrap();
    assert_eq!(
        lock.split_whitespace().next(),
        Some(old_pid.to_string().as_str()),
        "kill -9 leaves a stale lock"
    );

    let t0 = Instant::now();
    let d2 = Daemon::start_on(dir.path(), d.port);
    assert!(t0.elapsed() < Duration::from_secs(5), "restart within 5 s");
    let lock = std::fs::read_to_string(dir.path().join("daemon.lock")).unwrap();
    assert_eq!(
        lock.split_whitespace().next(),
        Some(d2.pid().to_string().as_str()),
        "stale lock reclaimed"
    );
    assert_eq!(
        lock.split_whitespace().count(),
        3,
        "lock holds pid start_time nonce"
    );
    assert_eq!(task_state(dir.path(), "crash-1"), "interrupted");
    let r = client()
        .post(d2.url("/tasks"))
        .header("Authorization", &auth)
        .json(&json!({"id": "crash-1", "kind": "noop"}))
        .send()
        .unwrap();
    assert_eq!(r.status(), 409, "a task id never runs twice");
}

#[test]
fn bad_config_refuses_start() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("config.json"), r#"{"bind":"0.0.0.0"}"#).unwrap();
    let out = spawn(dir.path(), common::free_port())
        .wait_with_output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("refusing to start") && err.contains("allow_remote"),
        "{err}"
    );
    assert!(!dir.path().join("state.db").exists(), "never half-start");
}

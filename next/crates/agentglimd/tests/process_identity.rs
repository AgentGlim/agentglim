//! Process identity: `stop` may only signal a daemon whose pid **and** process start time match the lock.
//!
//! Every process this file touches is either an owned child started here or a daemon the test helper started; no
//! process is ever found by name or pattern. Each case has its own deadline so a hang fails instead of blocking.

mod common;

use agentglimd::core::lock::{pid_alive, start_time};
use common::{client, Daemon};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// An owned child: killed and reaped when the case ends, whatever the outcome.
struct Owned<C: KilledByHandle>(C);

/// The children this file stops: a plain `sleep` process, and a daemon spawned by the test helper (which also owns
/// that daemon's default home and mock runtime endpoints).
trait KilledByHandle {
    fn handle(&self) -> &Child;
    fn handle_mut(&mut self) -> &mut Child;
}

impl KilledByHandle for Child {
    fn handle(&self) -> &Child {
        self
    }

    fn handle_mut(&mut self) -> &mut Child {
        self
    }
}

impl KilledByHandle for common::Spawned {
    fn handle(&self) -> &Child {
        &self.child
    }

    fn handle_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Owned<Child> {
    fn sleep(secs: u32) -> Owned<Child> {
        Owned(
            Command::new("sleep")
                .arg(secs.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn owned sleep"),
        )
    }
}

impl<C: KilledByHandle> Owned<C> {
    fn pid(&self) -> u32 {
        self.0.handle().id()
    }

    fn exit_status(&mut self) -> Option<ExitStatus> {
        self.0
            .handle_mut()
            .try_wait()
            .expect("try_wait owned child")
    }

    fn alive(&mut self) -> bool {
        self.exit_status().is_none()
    }
}

impl<C: KilledByHandle> Drop for Owned<C> {
    fn drop(&mut self) {
        let _ = self.0.handle_mut().kill();
        let _ = self.0.handle_mut().wait();
    }
}

fn write_lock(dir: &Path, text: &str) {
    std::fs::write(dir.join("daemon.lock"), text).unwrap();
}

fn read_lock(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("daemon.lock")).unwrap()
}

fn stderr(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

/// Runs the built binary's `stop` against a data dir; nothing else in this file signals a process directly.
fn stop(dir: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_agentglimd"))
        .args(["stop", "--data"])
        .arg(dir)
        .stdin(Stdio::null())
        .output()
        .expect("run agentglimd stop")
}

fn health(port: u16) -> u16 {
    client()
        .get(format!("http://127.0.0.1:{port}/api/v1/health"))
        .send()
        .map(|r| r.status().as_u16())
        .unwrap_or(0)
}

fn wait_healthy(port: u16, within: Duration) {
    let t0 = Instant::now();
    while t0.elapsed() < within {
        if health(port) == 200 {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("no /health on port {port} within {within:?}");
}

#[test]
fn stop_refuses_a_lock_with_the_wrong_start_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut sentinel = Owned::sleep(60);
    // The pid is real and alive, the recorded start time is not: the old pid-only path would have killed it.
    write_lock(dir.path(), &format!("{} 1 0000deadbeef\n", sentinel.pid()));

    let out = stop(dir.path());
    assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
    let err = stderr(&out);
    assert!(err.contains("refusing to stop"), "{err}");
    assert!(
        !err.contains(dir.path().to_str().unwrap()),
        "no absolute paths in the refusal: {err}"
    );

    std::thread::sleep(Duration::from_millis(300));
    assert!(sentinel.alive(), "the owned sentinel must not be signalled");
    assert_eq!(
        read_lock(dir.path()),
        format!("{} 1 0000deadbeef\n", sentinel.pid()),
        "a refused stop leaves the lock untouched"
    );
}

#[test]
fn stop_stops_the_verified_daemon() {
    let dir = tempfile::tempdir().unwrap();
    let mut d = Daemon::start(dir.path());
    let pid = d.pid();
    assert!(pid_alive(pid));

    let out = stop(dir.path());
    assert_eq!(out.status.code(), Some(0), "stderr: {}", stderr(&out));
    assert!(
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
        "reports which pid stopped: {}",
        String::from_utf8_lossy(&out.stdout)
    );

    let t0 = Instant::now();
    let status = loop {
        if let Some(st) = d.child.as_mut().unwrap().try_wait().unwrap() {
            d.child = None;
            break st;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "daemon did not exit"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(status.success(), "daemon exit status {status}");
    assert!(
        !dir.path().join("daemon.lock").exists(),
        "the daemon removes its own lock on a clean exit"
    );
}

#[test]
fn stop_refuses_a_lock_naming_a_dead_pid() {
    let dir = tempfile::tempdir().unwrap();
    // An owned child we end ourselves: the lock will name a pid that is provably not running.
    let mut child = Owned::sleep(60);
    let dead_pid = child.pid();
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(!pid_alive(dead_pid), "the child must be gone");
    write_lock(dir.path(), &format!("{dead_pid} 12345 nonce\n"));

    let out = stop(dir.path());
    assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
    let err = stderr(&out);
    assert!(err.contains("not running"), "{err}");
    assert_eq!(
        read_lock(dir.path()),
        format!("{dead_pid} 12345 nonce\n"),
        "nothing was signalled or cleaned up"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn stop_refuses_a_reused_pid() {
    let dir = tempfile::tempdir().unwrap();
    let mut sentinel = Owned::sleep(60);
    let real = start_time(sentinel.pid()).expect("start time of an owned child");
    write_lock(
        dir.path(),
        &format!("{} {} nonce\n", sentinel.pid(), real + 1),
    );

    let out = stop(dir.path());
    assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("refusing to stop"),
        "{}",
        stderr(&out)
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(sentinel.alive(), "a reused pid must never be signalled");
}

#[test]
fn stop_refuses_a_malformed_lock() {
    let dir = tempfile::tempdir().unwrap();
    for text in ["", "garbage\n", "0 5 nonce\n", "1234 notatime nonce\n"] {
        write_lock(dir.path(), text);
        let out = stop(dir.path());
        assert_eq!(out.status.code(), Some(3), "{text:?}: {}", stderr(&out));
        assert!(stderr(&out).contains("refusing to stop"), "{text:?}");
        assert_eq!(read_lock(dir.path()), text, "{text:?} left untouched");
    }
}

#[test]
fn stop_without_a_lock_reports_nothing_to_stop() {
    let dir = tempfile::tempdir().unwrap();
    let out = stop(dir.path());
    assert_eq!(out.status.code(), Some(0), "stderr: {}", stderr(&out));
    assert!(stderr(&out).contains("nothing to stop"), "{}", stderr(&out));
}

#[test]
fn two_starters_one_wins_and_the_loser_leaves_the_winner_alone() {
    let dir = tempfile::tempdir().unwrap();
    let p1 = common::free_port();
    let mut winner = Owned(common::spawn(dir.path(), p1));
    wait_healthy(p1, Duration::from_secs(10));
    let lock_before = read_lock(dir.path());
    assert_eq!(
        lock_before.split_whitespace().next(),
        Some(winner.pid().to_string().as_str()),
        "the winner owns the lock"
    );

    let p2 = common::free_port();
    let mut loser = Owned(common::spawn(dir.path(), p2));
    let t0 = Instant::now();
    let status = loop {
        if let Some(st) = loser.exit_status() {
            break st;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "the second starter must give up, not hang"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(status.code(), Some(3), "second starter: {status}");
    assert_eq!(read_lock(dir.path()), lock_before, "the lock is untouched");
    assert_eq!(health(p1), 200, "the winner keeps serving");
    assert!(winner.alive(), "the winner was never signalled");
}

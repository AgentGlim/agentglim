//! Isolation: the daemon must never read the developer's real home by default, must keep the runtime probes on mock
//! loopback ports this test process exclusively owns, and must still honour an explicit fixture HOME when a test
//! passes one.
//!
//! The hostile home below is junk shaped like real agent storage. Nothing may read it implicitly; an explicit HOME
//! override must read exactly that path and nothing else.
//!
//! Cases that need a fresh process (process-global endpoints, environment, static state) run the `subprocess_helper`
//! case in a child test binary, so nothing in this process can be surprised by them. No case ever contacts a listener
//! it does not own, and no process is ever signalled by name or pattern.

mod common;

use common::{client, Daemon};
use serde_json::Value;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SOURCES: [&str; 6] = [
    "plans-harness",
    "claude-code",
    "codex",
    "opencode",
    "agy",
    "pi",
];

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A home full of plausible agent storage whose every record is junk: detection may see the directories, parsing must
/// never take the daemon down, and nothing may be read without an explicit override.
fn hostile_home(root: &Path) -> PathBuf {
    let h = root.join("hostile-home");
    write(
        &h.join(".claude/projects/-fixture-project/session-1.jsonl"),
        "{\"type\":\"user\",\"message\":\"junk\"}\nnot json at all\n",
    );
    write(
        &h.join(".codex/sessions/2026/01/01/rollout-1.jsonl"),
        "junk\n{\"type\":\"turn\"}\n",
    );
    write(&h.join(".pi/agent/sessions/s1.jsonl"), "junk\n");
    write(
        &h.join(".local/share/opencode/storage/session/broken.json"),
        "{not json",
    );
    write(&h.join(".gemini/antigravity-cli/brain/x.jsonl"), "junk\n");
    h
}

fn status(d: &Daemon) -> Value {
    client()
        .get(d.url("/status"))
        .header("Authorization", format!("Bearer {}", d.token))
        .send()
        .unwrap()
        .json()
        .unwrap()
}

fn config(d: &Daemon) -> Value {
    client()
        .get(d.url("/config"))
        .header("Authorization", format!("Bearer {}", d.token))
        .send()
        .unwrap()
        .json()
        .unwrap()
}

fn source<'a>(s: &'a Value, id: &str) -> &'a Value {
    s["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .unwrap_or_else(|| panic!("source {id} missing from {s}"))
}

/// Event counts per source, read through a read-only URI (no `-wal`/`-shm` writes).
fn events_by_source(data: &Path) -> Vec<(String, i64)> {
    let uri = format!("file:{}?mode=ro", data.join("state.db").display());
    let c = rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    let mut st = c
        .prepare("SELECT source, COUNT(*) FROM events GROUP BY source")
        .unwrap();
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// Polls `/status` until the poller published a first pass and `f` holds.
fn until<F: Fn(&Value) -> bool>(d: &Daemon, what: &str, f: F) -> Value {
    let t0 = Instant::now();
    loop {
        let s = status(d);
        if s["updated_ms"].as_u64().unwrap_or(0) > 0 && f(&s) {
            return s;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(15),
            "timed out waiting for {what}: {s}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Every source reported not detected with a reason, no session counted, and no hostile path in sight.
fn assert_nothing_detected(s: &Value, hostile: &Path) {
    let hostile_str = hostile.to_str().unwrap();
    assert_eq!(
        s["sessions"]["total"].as_u64(),
        Some(0),
        "an empty home has no sessions: {s}"
    );
    for id in SOURCES {
        let src = source(s, id);
        assert_eq!(src["detected"], false, "{id} must not be detected: {src}");
        assert!(
            src["reason"].as_str().is_some_and(|r| !r.is_empty()),
            "{id} must say why it is not detected: {src}"
        );
        assert!(
            !src.to_string().contains(hostile_str),
            "{id} must not look at the hostile home: {src}"
        );
    }
}

/// No event in `state.db` came from one of the watched agent sources.
fn assert_no_agent_events(data: &Path) {
    for (src, n) in events_by_source(data) {
        assert!(
            !SOURCES.contains(&src.as_str()),
            "unexpected {n} events from {src} in {data:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------
// A listener this test owns: the unrelated service no daemon may ever contact.
// ---------------------------------------------------------------------------------------------------------------

/// A loopback listener that counts every connection it accepts and never answers. The count is the sentinel: it must
/// stay zero, because a helper that cannot own the endpoint must fail setup instead of pointing a daemon at it.
struct Sentinel {
    port: u16,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Sentinel {
    fn adopt(port: u16, listener: TcpListener) -> Sentinel {
        listener
            .set_nonblocking(true)
            .expect("nonblocking sentinel listener");
        let accept = listener.try_clone().expect("clone sentinel listener");
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (h, s) = (Arc::clone(&hits), Arc::clone(&stop));
        let thread = std::thread::spawn(move || {
            let mut held = Vec::new();
            while !s.load(Ordering::SeqCst) {
                match accept.accept() {
                    Ok((conn, _)) => {
                        h.fetch_add(1, Ordering::SeqCst);
                        // Keep the connection open so a client cannot mistake the sentinel for a closed port.
                        held.push(conn);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Sentinel {
            port,
            hits,
            stop,
            thread: Some(thread),
        }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for Sentinel {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Subprocess helper plumbing.
// ---------------------------------------------------------------------------------------------------------------

/// Name of the helper case inside this binary; the parent selects a mode through `AG_HELPER_MODE`.
const HELPER_TEST: &str = "subprocess_helper";

/// Runs [`subprocess_helper`] in a fresh copy of this test binary (libtest, one thread, exact name). The child starts
/// with no `HOME`/`USERPROFILE` of its own unless a case sets one, so it can never read the developer's home.
fn run_helper(mode: &str, envs: &[(&str, &str)]) -> Output {
    let exe = std::env::current_exe().expect("current test binary");
    let mut cmd = Command::new(exe);
    cmd.args(["--exact", HELPER_TEST, "--nocapture", "--test-threads=1"])
        .env("AG_HELPER_MODE", mode)
        .env_remove("HOME")
        .env_remove("USERPROFILE")
        .stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.output().expect("run helper subprocess")
}

fn helper_ok(out: &Output, what: &str) {
    assert!(
        out.status.success(),
        "{what}: helper subprocess failed ({:?})\n--- stdout ---\n{}--- stderr ---\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

fn helper_stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// Entry point for cases that need their own process. Without `AG_HELPER_MODE` it does nothing, so an ordinary run
/// simply reports it as passed.
#[test]
fn subprocess_helper() {
    let Ok(mode) = std::env::var("AG_HELPER_MODE") else {
        return;
    };
    match mode.as_str() {
        "mock-sentinel" => helper_mock_sentinel(),
        "resolver" => helper_resolver(),
        "homes" => helper_homes(),
        other => panic!("unknown AG_HELPER_MODE {other}"),
    }
}

/// Child: every mock runtime endpoint is already owned by the parent process. Helper setup must refuse to continue,
/// name the endpoint it could not own, and never start a daemon against it.
fn helper_mock_sentinel() {
    let ports = std::env::var("AG_MOCK_PORTS").expect("AG_MOCK_PORTS");
    let target: u16 = ports
        .split(',')
        .next()
        .and_then(|p| p.trim().parse().ok())
        .expect("first mock port");

    // 1. Setup fails and names the endpoint it does not own.
    let err = common::try_mock_runtime_endpoints()
        .err()
        .unwrap_or_else(|| panic!("setup must refuse mock endpoints owned by another process"));
    assert!(
        err.contains(&format!("127.0.0.1:{target}")),
        "the failure must name the unowned endpoint 127.0.0.1:{target}: {err}"
    );

    // 2. The spawn path refuses too, before a daemon process exists to send a probe.
    let data = tempfile::tempdir().unwrap();
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Daemon::start_env(data.path(), common::free_port(), &[])
    }));
    assert!(
        attempt.is_err(),
        "a daemon must never be started against an endpoint the helper does not own"
    );

    // 3. Leave time for a stray client to appear before reporting; the parent owns the counting sentinels.
    std::thread::sleep(Duration::from_millis(300));
    println!("REFUSED_PORT={target}");
}

/// Child: resolve `HOME`/`USERPROFILE` in a private environment instead of mutating the test process's.
fn helper_resolver() {
    let dir = PathBuf::from(std::env::var("AG_RESOLVER_DIR").expect("AG_RESOLVER_DIR"));
    match std::env::var("AG_RESOLVER_CASE")
        .expect("AG_RESOLVER_CASE")
        .as_str()
    {
        "both-unset" => {}
        "empty-home" => {
            std::env::set_var("HOME", "");
            std::env::set_var("USERPROFILE", &dir);
        }
        "home-only" => {
            std::env::set_var("HOME", &dir);
            std::env::remove_var("USERPROFILE");
        }
        other => panic!("unknown AG_RESOLVER_CASE {other}"),
    }
    println!(
        "RESOLVED={}",
        agentglimd::adapters::resolve_home().display()
    );
}

/// Child: run a daemon on the *default* home (which must be gone once its owner drops), then on an explicit home
/// (which the helper must never remove). The parent keeps observing after this process has exited.
fn helper_homes() {
    let root = PathBuf::from(std::env::var("AG_HELPER_ROOT").expect("AG_HELPER_ROOT"));
    let explicit =
        PathBuf::from(std::env::var("AG_HELPER_EXPLICIT_HOME").expect("AG_HELPER_EXPLICIT_HOME"));

    let data = root.join("data-default");
    std::fs::create_dir_all(&data).unwrap();
    let mut d = Daemon::start_env(&data, common::free_port(), &[]);
    let home = d
        .default_home()
        .expect("a daemon without an explicit home gets an owned default one")
        .to_path_buf();
    assert!(
        home.is_dir(),
        "the default home exists while its daemon runs: {}",
        home.display()
    );
    assert_eq!(client().get(d.url("/health")).send().unwrap().status(), 200);
    println!("DEFAULT_HOME={}", home.display());
    let stopped = d
        .term(Duration::from_secs(10))
        .expect("default-home daemon stops on SIGTERM");
    assert!(stopped.success(), "clean stop: {stopped:?}");
    drop(d);
    assert!(
        !home.exists(),
        "the owned default home is removed with its owner: {}",
        home.display()
    );
    println!("DEFAULT_HOME_GONE=1");

    let data2 = root.join("data-explicit");
    std::fs::create_dir_all(&data2).unwrap();
    std::fs::write(explicit.join("keep.txt"), b"keep").unwrap();
    let mut d2 = Daemon::start_env(
        &data2,
        common::free_port(),
        &[("HOME", explicit.to_str().unwrap())],
    );
    assert!(
        d2.default_home().is_none(),
        "an explicit HOME must not create a default home"
    );
    let stopped2 = d2
        .term(Duration::from_secs(10))
        .expect("explicit-home daemon stops on SIGTERM");
    assert!(stopped2.success(), "clean stop: {stopped2:?}");
    drop(d2);
    assert_eq!(
        std::fs::read_to_string(explicit.join("keep.txt"))
            .expect("explicit home survives the helper"),
        "keep"
    );
    println!("EXPLICIT_HOME_KEPT=1");
}

// ---------------------------------------------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_hostile_home_is_not_read_by_default() {
    let t = tempfile::tempdir().unwrap();
    let hostile = hostile_home(t.path());

    // Fast intervals: nothing in `envs` sets HOME, so the helper supplies an owned empty home and the daemon cannot
    // see the hostile tree (or the developer's real home) even though the test process itself has one.
    let data = t.path().join("data");
    let d = Daemon::start_env(
        &data,
        common::free_port(),
        &[("AG_POLL_MS", "100"), ("AG_DISCOVER_MS", "100")],
    );
    let s = until(&d, "every source to report not detected", |s| {
        s["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x["detected"] == false)
    });
    assert_nothing_detected(&s, &hostile);
    assert_no_agent_events(&data);

    // The plain default path (no env overrides at all) is hermetic too.
    let data2 = t.path().join("data2");
    let d2 = Daemon::start(&data2);
    let s2 = until(&d2, "not detected again", |s| {
        s["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x["detected"] == false)
    });
    assert_nothing_detected(&s2, &hostile);
    assert_no_agent_events(&data2);
}

#[test]
fn an_explicit_fixture_home_still_wins() {
    let t = tempfile::tempdir().unwrap();
    let hostile = hostile_home(t.path());
    let d = Daemon::start_env(
        &t.path().join("data"),
        common::free_port(),
        &[
            ("HOME", hostile.to_str().unwrap()),
            ("AG_POLL_MS", "100"),
            ("AG_DISCOVER_MS", "100"),
        ],
    );
    let s = until(&d, "the fixture claude-code root to be detected", |s| {
        source(s, "claude-code")["detected"] == true
    });
    let src = source(&s, "claude-code");
    let paths = src["paths"].as_array().unwrap();
    assert_eq!(paths.len(), 1, "{src}");
    assert_eq!(
        paths[0].as_str().unwrap(),
        hostile.join(".claude/projects").display().to_string(),
        "the explicit fixture root is the one that was read"
    );
    assert!(src["reason"].is_null(), "{src}");
}

#[test]
fn runtime_probes_use_the_closed_mock_ports() {
    let t = tempfile::tempdir().unwrap();
    let d = Daemon::start_env(
        &t.path().join("data"),
        common::free_port(),
        &[("AG_DISCOVER_MS", "100")],
    );

    // The effective config points at the endpoints this test process owns, so no default port (11434 / 8080 / 8081)
    // and no other process's listener can be probed.
    let cfg = config(&d);
    let urls = &cfg["config"]["runtime_urls"];
    let mock = d.mock();
    for id in ["ollama", "llamacpp", "strata"] {
        let want = mock.url(id);
        assert_eq!(urls[id], want.as_str(), "{cfg}");
        let port: u16 = want
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .expect("mock url has a port");
        assert!(
            (19361..=19379).contains(&port),
            "mock port out of range: {want}"
        );
        assert!(
            ![11434u16, 8080, 8081].contains(&port),
            "a default production runtime port must never be probed: {want}"
        );
    }

    let s = until(&d, "all three runtimes to probe as down", |s| {
        s["runtimes"].as_array().unwrap().len() == 3
            && s["runtimes"].as_array().unwrap().iter().all(|r| {
                matches!(
                    r["state"]["state"].as_str(),
                    Some("down") | Some("owner_off")
                )
            })
    });
    let ids: Vec<&str> = s["runtimes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["ollama", "llamacpp", "strata"], "{s}");

    // The probes really arrived at the endpoints this process owns (nothing else could answer them).
    let t0 = Instant::now();
    while mock.connections("ollama") == 0 && mock.connections("llamacpp") == 0 {
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "the mock endpoints never received a probe"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    // /status never waits on a probe.
    for _ in 0..5 {
        let t0 = Instant::now();
        status(&d);
        assert!(
            t0.elapsed() < Duration::from_millis(300),
            "status took {:?}",
            t0.elapsed()
        );
    }
}

/// The daemon copies a non-empty HOME into an empty USERPROFILE itself; with HOME removed, detection must still find
/// the USERPROFILE root. This case needs `HOME` unset, which the helper cannot express, so it spawns directly.
#[test]
fn userprofile_only_home_is_detected_precache() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("up-home");
    write(
        &home.join(".claude/projects/-fixture/session.jsonl"),
        "{\"type\":\"user\",\"message\":\"hi\"}\n",
    );
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    // Owned mock runtime endpoints: the attempt cannot reach a service installed on this machine.
    let mock = common::mock_runtime_endpoints();
    std::fs::write(data.join("config.json"), mock.config_json()).unwrap();
    let empty = common::empty_home();

    let port = common::free_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_agentglimd"))
        .args(["run", "--port", &port.to_string(), "--data"])
        .arg(&data)
        .env_remove("HOME")
        .env("USERPROFILE", &home)
        .env("AG_POLL_MS", "100")
        .env("AG_DISCOVER_MS", "100")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn agentglimd");

    // Wait for health.
    let c = client();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(10) {
        if c.get(format!("http://127.0.0.1:{port}/api/v1/health"))
            .send()
            .map(|r| r.status().as_u16())
            .unwrap_or(0)
            == 200
        {
            break;
        }
        if let Some(st) = child.try_wait().unwrap() {
            panic!("daemon exited early: {st}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let token = std::fs::read_to_string(data.join("token"))
        .unwrap()
        .trim()
        .to_string();

    let s: Value = c
        .get(format!("http://127.0.0.1:{port}/api/v1/status"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .unwrap()
        .json()
        .unwrap();
    let src = source(&s, "claude-code");
    assert_eq!(src["detected"], true, "{src}");
    let paths = src["paths"].as_array().unwrap();
    assert_eq!(paths.len(), 1, "{src}");
    assert_eq!(
        paths[0].as_str().unwrap(),
        home.join(".claude/projects").display().to_string(),
        "{src}"
    );

    // Stop this case's own child by its pid, then reap it.
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let _ = child.wait();
    drop(empty);
}

#[test]
fn concurrent_homes_survive_each_others_teardown() {
    let t = tempfile::tempdir().unwrap();
    let home1 = t.path().join("home1");
    let home2 = t.path().join("home2");
    write(
        &home1.join(".claude/projects/-a/session.jsonl"),
        "{\"type\":\"user\",\"message\":\"a\"}\n",
    );
    write(
        &home2.join(".codex/sessions/2026/01/01/rollout-1.jsonl"),
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/tmp\",\"originator\":\"codex\",\"cli_version\":\"1\",\"model_provider\":\"openai\"}}\n",
    );
    let data1 = t.path().join("data1");
    let data2 = t.path().join("data2");
    let p1 = common::free_port();
    let p2 = common::free_port();
    let mut d1 = Daemon::start_env(
        &data1,
        p1,
        &[
            ("HOME", home1.to_str().unwrap()),
            ("AG_POLL_MS", "100000"),
            ("AG_DISCOVER_MS", "100000"),
        ],
    );
    let d2 = Daemon::start_env(
        &data2,
        p2,
        &[
            ("HOME", home2.to_str().unwrap()),
            ("AG_POLL_MS", "100000"),
            ("AG_DISCOVER_MS", "100000"),
        ],
    );
    assert_eq!(status(&d1)["sources"].as_array().unwrap().len(), 6);
    assert_eq!(status(&d2)["sources"].as_array().unwrap().len(), 6);
    d1.term(std::time::Duration::from_secs(5));
    // The second daemon and both homes remain intact.
    assert_eq!(
        client()
            .get(format!("http://127.0.0.1:{p2}/api/v1/health"))
            .send()
            .unwrap()
            .status(),
        200
    );
    assert!(home1.exists());
    assert!(home2.exists());
    drop(d2);
}

#[test]
fn occupied_port_fails_before_any_client_request() {
    let t = tempfile::tempdir().unwrap();
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    // Own the daemon port for the whole attempt; the daemon must not be able to bind it.
    let (port, _listener) = common::owned_listener();
    // Own the runtime endpoints too, so the attempt cannot reach a service installed on this machine either.
    let mock = common::mock_runtime_endpoints();
    std::fs::write(data.join("config.json"), mock.config_json()).unwrap();
    let home = common::empty_home();

    let mut child = Command::new(env!("CARGO_BIN_EXE_agentglimd"))
        .args(["run", "--port", &port.to_string(), "--data"])
        .arg(&data)
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn agentglimd on occupied port");

    let t0 = std::time::Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break st;
        }
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(5),
            "daemon did not exit on occupied port"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    assert!(!status.success(), "binding an occupied port must fail");
    // No client request was ever sent; listener still owned by this test.
    let _ = child.wait();
    drop(mock);
    drop(home);
    common::release_port(port);
}

/// Occupying a mock runtime endpoint in another process must fail helper setup before any daemon can reach it. Each
/// run rotates which owned endpoint the child meets first, so all three endpoints are covered deterministically.
#[test]
fn an_occupied_mock_endpoint_fails_setup_before_any_request() {
    // Three ports this process owns for the whole case; `free_port` never hands them out again.
    let (p_ollama, l1) = common::owned_listener();
    let (p_llamacpp, l2) = common::owned_listener();
    let (p_strata, l3) = common::owned_listener();
    let ollama = Sentinel::adopt(p_ollama, l1);
    let llamacpp = Sentinel::adopt(p_llamacpp, l2);
    let strata = Sentinel::adopt(p_strata, l3);
    let base = [ollama.port, llamacpp.port, strata.port];

    for shift in 0..3 {
        let rotated = [base[shift], base[(shift + 1) % 3], base[(shift + 2) % 3]];
        let ports = format!("{},{},{}", rotated[0], rotated[1], rotated[2]);
        let out = run_helper("mock-sentinel", &[("AG_MOCK_PORTS", ports.as_str())]);
        helper_ok(&out, &format!("occupied mock endpoint {}", rotated[0]));
        let stdout = helper_stdout(&out);
        assert!(
            stdout.contains(&format!("REFUSED_PORT={}", rotated[0])),
            "the child must refuse the endpoint it does not own ({}): {stdout}",
            rotated[0]
        );
        let hits = ollama.hits() + llamacpp.hits() + strata.hits();
        assert_eq!(
            hits, 0,
            "a sentinel received {hits} connection(s) while setup refused {ports}"
        );
    }

    // A last look after all runs: nothing may ever have reached an unrelated listener.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        ollama.hits() + llamacpp.hits() + strata.hits(),
        0,
        "no request may ever reach a listener the helper does not own"
    );
    common::release_port(ollama.port);
    common::release_port(llamacpp.port);
    common::release_port(strata.port);
}

/// The default temporary home must really be removed, not leaked in process-global storage. The child uses it and
/// exits; the parent, which shares no state with it, observes that the directory is gone. An explicit home of the
/// same child survives untouched.
#[test]
fn default_temporary_homes_are_cleaned_and_explicit_homes_are_kept() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("child-root");
    let explicit = t.path().join("explicit-home");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&explicit).unwrap();
    // Ports the child may bind: three runtime endpoints plus two daemon ports; this process never hands them out.
    let reserved = common::reserve_ports(5);
    let mock_ports = format!("{},{},{}", reserved[0], reserved[1], reserved[2]);
    let daemon_ports = format!("{},{}", reserved[3], reserved[4]);

    let out = run_helper(
        "homes",
        &[
            ("AG_HELPER_ROOT", root.to_str().unwrap()),
            ("AG_HELPER_EXPLICIT_HOME", explicit.to_str().unwrap()),
            ("AG_MOCK_PORTS", mock_ports.as_str()),
            ("AG_DAEMON_PORTS", daemon_ports.as_str()),
        ],
    );
    helper_ok(&out, "default and explicit homes");
    for p in &reserved {
        common::release_port(*p);
    }
    let stdout = helper_stdout(&out);
    assert!(stdout.contains("DEFAULT_HOME_GONE=1"), "{stdout}");
    assert!(stdout.contains("EXPLICIT_HOME_KEPT=1"), "{stdout}");

    let reported = stdout
        .lines()
        .find_map(|l| l.split("DEFAULT_HOME=").nth(1))
        .map(str::trim)
        .unwrap_or_else(|| panic!("the child must report its default home: {stdout}"));
    let home = PathBuf::from(reported);
    assert!(
        !home.exists(),
        "the parent observes the default home gone after the helper exited: {}",
        home.display()
    );
    assert!(
        !home.starts_with(t.path()),
        "the default home is a private temp dir, not the caller's root: {}",
        home.display()
    );
    assert_eq!(
        std::fs::read_to_string(explicit.join("keep.txt")).unwrap(),
        "keep",
        "an explicit home is never removed by the helper"
    );

    // The child really started a daemon there (it installed its token) before the home was cleaned up.
    assert!(
        root.join("data-default").join("token").is_file(),
        "the child ran a real daemon on its default home"
    );
}

/// Two callers of the default home get their own roots: stopping one daemon removes only that daemon's home.
#[test]
fn default_homes_are_private_and_do_not_remove_each_other() {
    let t = tempfile::tempdir().unwrap();
    let d1 = Daemon::start_env(&t.path().join("data1"), common::free_port(), &[]);
    let d2 = Daemon::start_env(&t.path().join("data2"), common::free_port(), &[]);
    let h1 = d1
        .default_home()
        .expect("first daemon has a default home")
        .to_path_buf();
    let h2 = d2
        .default_home()
        .expect("second daemon has a default home")
        .to_path_buf();
    assert_ne!(h1, h2, "each default home is a separate owned root");
    assert!(h1.is_dir() && h2.is_dir());
    assert_eq!(status(&d1)["sources"].as_array().unwrap().len(), 6);

    drop(d1); // stops the first daemon and removes only its own root
    assert!(
        !h1.exists(),
        "the stopped daemon's default home is removed: {}",
        h1.display()
    );
    assert!(
        h2.exists(),
        "a concurrent helper's default home is untouched: {}",
        h2.display()
    );
    assert_eq!(status(&d2)["sources"].as_array().unwrap().len(), 6);
}

/// `HOME`/`USERPROFILE` resolution is exercised in child processes: an empty `HOME` falls through to `USERPROFILE`
/// and empty values never resolve to a real user home, without racing this process's environment.
#[test]
fn empty_home_resolves_to_userprofile_in_a_private_environment() {
    let t = tempfile::tempdir().unwrap();
    let userprofile = t.path().join("userprofile-home");
    std::fs::create_dir_all(&userprofile).unwrap();
    let dir_text = userprofile.display().to_string();

    let cases: [(&str, String); 3] = [
        ("both-unset", String::new()),
        ("empty-home", dir_text.clone()),
        ("home-only", dir_text.clone()),
    ];
    for (case, want) in cases {
        let out = run_helper(
            "resolver",
            &[
                ("AG_RESOLVER_CASE", case),
                ("AG_RESOLVER_DIR", dir_text.as_str()),
            ],
        );
        helper_ok(&out, &format!("resolver case {case}"));
        let stdout = helper_stdout(&out);
        assert!(
            stdout.contains(&format!("RESOLVED={want}")),
            "resolver case {case}: expected {want:?} in {stdout}"
        );
    }
}

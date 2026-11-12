//! Test helpers: spawn the real binary on a free port in 19361-19379, stop it by its own pid.
//!
//! Hermetic by default: a spawned daemon gets an owned, empty temporary home (never the developer's) and a
//! `config.json` whose runtime URLs point at mock loopback endpoints this process bound itself. A caller's own
//! `HOME`/`USERPROFILE` always wins; a caller's `config.json` keeps every value it sets, and any runtime URL it omits
//! is filled in from the owned mock, so no probe can reach a service installed on this machine.
//!
//! Ownership rules kept by this module:
//! - the mock endpoints are bound before any daemon or client exists, and setup fails loudly if any bind fails; an
//!   unowned endpoint is never used;
//! - a default home belongs to the [`Spawned`]/[`Daemon`] handle that created it and is removed when that drops;
//!   explicit homes are never touched;
//! - every child is stopped by its own `Child` handle (never by name or pattern).
#![allow(dead_code)]

use std::net::TcpListener;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct PortState {
    next: u16,
    /// Numbers reserved for a child process: this process must never bind them itself.
    reserved: Vec<u16>,
    /// Ports handed out by [`free_port`] with lease time. Released explicitly on owner drop or reclaimed after a
    /// grace period when bindable again.
    leased: Vec<(u16, std::time::Instant)>,
}

static PORTS: Mutex<PortState> = Mutex::new(PortState {
    next: 19360,
    reserved: Vec::new(),
    leased: Vec::new(),
});

/// Default ports of the three mock runtime endpoints. [`free_port`] never hands these out, so a daemon port is never
/// a mock port.
pub const MOCK_OLLAMA_PORT: u16 = 19378;
pub const MOCK_LLAMACPP_PORT: u16 = 19377;
pub const MOCK_STRATA_PORT: u16 = 19376;
const MOCK_RUNTIME_PORTS: [u16; 3] = [MOCK_OLLAMA_PORT, MOCK_LLAMACPP_PORT, MOCK_STRATA_PORT];

pub fn free_port() -> u16 {
    // A parent process may reserve ports for this one (`AG_DAEMON_PORTS`); use those first, so a subprocess and its
    // parent never race for the same 19-port pool.
    if let Some(p) = reserved_for_child() {
        return p;
    }
    let mock = mock_ports();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let mut st = PORTS.lock().unwrap();
        let now = std::time::Instant::now();
        let grace = std::time::Duration::from_millis(500);
        st.leased.retain(|&(p, leased_at)| {
            if now.duration_since(leased_at) < grace {
                return true;
            }
            TcpListener::bind(("127.0.0.1", p)).is_err()
        });
        // Try a full sweep.
        for _ in 0..200 {
            let p = st.next;
            st.next = if p >= 19379 { 19361 } else { p + 1 };
            let usable = p != 19360
                && !MOCK_RUNTIME_PORTS.contains(&p)
                && !mock.contains(&p)
                && !st.reserved.contains(&p)
                && !st.leased.iter().any(|&(q, _)| q == p);
            if usable && TcpListener::bind(("127.0.0.1", p)).is_ok() {
                st.leased.push((p, std::time::Instant::now()));
                return p;
            }
        }
        drop(st);
        if std::time::Instant::now() >= deadline {
            panic!("no free port in 19361-19379");
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

/// Ports a parent reserved for this child process through `AG_DAEMON_PORTS`, handed out in order.
fn reserved_for_child() -> Option<u16> {
    static CHILD_PORTS: OnceLock<Mutex<Vec<u16>>> = OnceLock::new();
    let ports = CHILD_PORTS.get_or_init(|| {
        let list = std::env::var("AG_DAEMON_PORTS")
            .map(|t| {
                t.split(',')
                    .filter_map(|p| p.trim().parse::<u16>().ok())
                    .collect()
            })
            .unwrap_or_default();
        Mutex::new(list)
    });
    let mut ports = ports.lock().unwrap();
    if ports.is_empty() {
        None
    } else {
        Some(ports.remove(0))
    }
}

/// Reserve `count` ports for a child process. This process will never hand them out through [`free_port`] again, so a
/// subprocess can bind its own endpoints there without racing the tests running next to it.
///
/// The ports are checked to be bindable when reserved, but not held: the subprocess binds them itself.
pub fn reserve_ports(count: usize) -> Vec<u16> {
    let mock = mock_ports();
    let mut st = PORTS.lock().unwrap();
    let mut out = Vec::with_capacity(count);
    for _ in 0..200 {
        if out.len() == count {
            return out;
        }
        let p = st.next;
        st.next = if p >= 19379 { 19361 } else { p + 1 };
        let usable = p != 19360
            && !MOCK_RUNTIME_PORTS.contains(&p)
            && !mock.contains(&p)
            && !st.reserved.contains(&p);
        if usable && TcpListener::bind(("127.0.0.1", p)).is_ok() {
            st.reserved.push(p);
            out.push(p);
        }
    }
    panic!("could not reserve {count} ports in 19361-19379");
}

/// Release a port previously handed out by [`free_port`], so it can be reused promptly. Safe to call for any port.
pub fn release_port(port: u16) {
    if let Ok(mut st) = PORTS.lock() {
        st.leased.retain(|&(p, _)| p != port);
        st.reserved.retain(|&p| p != port);
    }
}

/// Bind and hold a listener on an owned port in the allowed range. The caller keeps the listener alive for the
/// duration of its use and stops it by dropping the handle.
pub fn owned_listener() -> (u16, TcpListener) {
    let p = free_port();
    let l = TcpListener::bind(("127.0.0.1", p)).expect("bind owned port in range");
    (p, l)
}

/// One mock runtime endpoint: a loopback listener bound by this process, the thread accepting on it, and the number
/// of connections it served. Dropping it stops the thread and closes the socket.
struct MockEndpoint {
    port: u16,
    /// Held only to own the port for as long as this endpoint exists.
    _listener: TcpListener,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MockEndpoint {
    fn bind(port: u16) -> Result<MockEndpoint, String> {
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
            format!("mock runtime endpoint 127.0.0.1:{port} is not ours to use ({e})")
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("mock runtime endpoint 127.0.0.1:{port}: {e}"))?;
        let accept = listener
            .try_clone()
            .map_err(|e| format!("mock runtime endpoint 127.0.0.1:{port}: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(AtomicUsize::new(0));
        let (s, c) = (Arc::clone(&stop), Arc::clone(&connections));
        let thread = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                match accept.accept() {
                    // Accept and close: a probe fails fast instead of reaching anything installed here.
                    Ok((conn, _)) => {
                        c.fetch_add(1, Ordering::SeqCst);
                        let _ = conn.shutdown(std::net::Shutdown::Both);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(MockEndpoint {
            port,
            _listener: listener,
            stop,
            connections,
            thread: Some(thread),
        })
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

impl Drop for MockEndpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct MockSet {
    ollama: MockEndpoint,
    llamacpp: MockEndpoint,
    strata: MockEndpoint,
}

/// The three mock runtime endpoints this process owns, in their configured order.
#[derive(Clone)]
pub struct MockRuntimes {
    inner: Arc<MockSet>,
}

/// Ports the mock endpoints bind. Fixed by default. A collision case injects its own set through `AG_MOCK_PORTS`
/// (three comma-separated ports) so a parent process can own them and a child process proves it refuses to continue.
fn mock_ports() -> [u16; 3] {
    match std::env::var("AG_MOCK_PORTS") {
        Err(_) => MOCK_RUNTIME_PORTS,
        Ok(text) => {
            let ports: Vec<u16> = text
                .split(',')
                .filter_map(|p| p.trim().parse::<u16>().ok())
                .collect();
            assert_eq!(
                ports.len(),
                3,
                "AG_MOCK_PORTS needs three comma-separated ports, got {text:?}"
            );
            [ports[0], ports[1], ports[2]]
        }
    }
}

impl MockRuntimes {
    /// Bind all three endpoints or fail. A partial set is never returned: the already-bound listeners are dropped
    /// on the error path, so an incomplete bind leaves nothing owned.
    fn bind() -> Result<MockRuntimes, String> {
        let ports = mock_ports();
        let mut bound: Vec<MockEndpoint> = Vec::with_capacity(3);
        for port in ports {
            bound.push(MockEndpoint::bind(port)?);
        }
        let mut it = bound.into_iter();
        let ollama = it.next().expect("ollama endpoint");
        let llamacpp = it.next().expect("llamacpp endpoint");
        let strata = it.next().expect("strata endpoint");
        Ok(MockRuntimes {
            inner: Arc::new(MockSet {
                ollama,
                llamacpp,
                strata,
            }),
        })
    }

    fn endpoint(&self, runtime: &str) -> &MockEndpoint {
        match runtime {
            "ollama" => &self.inner.ollama,
            "llamacpp" => &self.inner.llamacpp,
            "strata" => &self.inner.strata,
            other => panic!("unknown runtime {other}"),
        }
    }

    /// Base URL of an owned endpoint.
    pub fn url(&self, runtime: &str) -> String {
        self.endpoint(runtime).url()
    }

    /// Ports of the three owned endpoints, in `ollama`, `llamacpp`, `strata` order.
    pub fn ports(&self) -> [u16; 3] {
        [
            self.inner.ollama.port,
            self.inner.llamacpp.port,
            self.inner.strata.port,
        ]
    }

    /// Connections served by an endpoint so far.
    pub fn connections(&self, runtime: &str) -> usize {
        self.endpoint(runtime).connections()
    }

    /// A `config.json` body that points every runtime at this process's mock endpoints.
    pub fn config_json(&self) -> String {
        format!(
            r#"{{"runtime_urls":{{"ollama":"{}","llamacpp":"{}","strata":"{}"}}}}"#,
            self.url("ollama"),
            self.url("llamacpp"),
            self.url("strata")
        )
    }

    /// Merge the owned mock URLs into a caller config: every value the caller set is kept, a missing
    /// `runtime_urls.<id>` is filled with the owned mock URL. Returns `None` when `base` is not a JSON object (the
    /// caller's text is then used verbatim, so a deliberately invalid config still reaches the daemon unchanged).
    pub fn merge_config(&self, base: Option<&str>) -> Option<String> {
        let mut root = match base {
            None => serde_json::json!({}),
            Some(text) => match serde_json::from_str::<serde_json::Value>(text) {
                Ok(v) if v.is_object() => v,
                _ => return None,
            },
        };
        let urls = root
            .as_object_mut()
            .expect("checked JSON object")
            .entry("runtime_urls")
            .or_insert_with(|| serde_json::json!({}));
        let urls = urls.as_object_mut()?;
        for id in ["ollama", "llamacpp", "strata"] {
            urls.entry(id.to_string())
                .or_insert_with(|| serde_json::Value::String(self.url(id)));
        }
        Some(root.to_string())
    }
}

fn mock_slot() -> &'static OnceLock<Result<MockRuntimes, String>> {
    static MOCK: OnceLock<Result<MockRuntimes, String>> = OnceLock::new();
    &MOCK
}

/// Bind (once per process) the three mock runtime endpoints and hand back a handle that keeps them owned, or report
/// exactly which endpoint could not be bound.
pub fn try_mock_runtime_endpoints() -> Result<MockRuntimes, String> {
    mock_slot().get_or_init(MockRuntimes::bind).clone()
}

/// [`try_mock_runtime_endpoints`] for setup paths: an endpoint this process does not own is a setup failure, never
/// something to start a daemon against.
pub fn mock_runtime_endpoints() -> MockRuntimes {
    match try_mock_runtime_endpoints() {
        Ok(m) => m,
        Err(e) => panic!(
            "refusing to start a daemon: {e}. A runtime probe must never reach a listener this test does not own."
        ),
    }
}

/// An owned empty home: a fresh temporary directory removed when the guard drops. It is never cached in static
/// storage, so the removal really happens instead of being skipped at process exit.
pub struct EmptyHome {
    dir: tempfile::TempDir,
}

impl EmptyHome {
    pub fn new() -> EmptyHome {
        let dir = tempfile::tempdir().expect("create empty test home");
        EmptyHome { dir }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Default for EmptyHome {
    fn default() -> Self {
        EmptyHome::new()
    }
}

/// One empty home per caller, owner-scoped: two helpers never share or delete each other's root.
pub fn empty_home() -> EmptyHome {
    EmptyHome::new()
}

/// A daemon child together with everything this helper owns for it: its default empty home (removed on drop) and the
/// mock runtime endpoints its config points at. Callers stop the child through the usual `Child` methods.
pub struct Spawned {
    pub child: Child,
    pub home: Option<EmptyHome>,
    pub mock: MockRuntimes,
}

impl Spawned {
    /// The default home this helper created for the child, or `None` when the caller supplied `HOME`/`USERPROFILE`.
    pub fn default_home(&self) -> Option<&Path> {
        self.home.as_ref().map(EmptyHome::path)
    }

    pub fn mock(&self) -> &MockRuntimes {
        &self.mock
    }

    /// `Child::wait_with_output` plus a deterministic drop of the owned home afterwards.
    pub fn wait_with_output(self) -> std::io::Result<Output> {
        let Spawned { child, home, mock } = self;
        let out = child.wait_with_output();
        drop(home);
        drop(mock);
        out
    }
}

impl Deref for Spawned {
    type Target = Child;

    fn deref(&self) -> &Child {
        &self.child
    }
}

impl DerefMut for Spawned {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

pub fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

pub fn spawn(data: &Path, port: u16) -> Spawned {
    spawn_env(data, port, &[])
}

/// Spawns a daemon with the hermetic defaults (owned empty home, owned mock runtime URLs).
pub fn spawn_env(data: &Path, port: u16, envs: &[(&str, &str)]) -> Spawned {
    spawn_full(data, port, envs, None)
}

/// Spawns a daemon with an explicit `config.json`; any runtime URL it omits is filled from the owned mock.
pub fn spawn_with_config(
    data: &Path,
    port: u16,
    envs: &[(&str, &str)],
    config_json: &str,
) -> Spawned {
    spawn_full(data, port, envs, Some(config_json))
}

fn spawn_full(data: &Path, port: u16, envs: &[(&str, &str)], config_json: Option<&str>) -> Spawned {
    // Own the mock endpoints before anything else: no config, directory or child exists until this succeeds.
    let mock = mock_runtime_endpoints();
    std::fs::create_dir_all(data).expect("create test data dir");
    let cfg_path = data.join("config.json");
    let base = match config_json {
        Some(text) => Some(text.to_string()),
        None => std::fs::read_to_string(&cfg_path).ok(),
    };
    match mock.merge_config(base.as_deref()) {
        Some(text) => write_atomic(&cfg_path, &text),
        None => {
            if let Some(text) = config_json {
                // Caller config that is not a JSON object: hand it over verbatim so the daemon judges it.
                write_atomic(&cfg_path, text);
            }
        }
    }
    let explicit = envs
        .iter()
        .any(|(k, v)| matches!(*k, "HOME" | "USERPROFILE") && !v.is_empty());
    let home = if explicit { None } else { Some(empty_home()) };
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agentglimd"));
    cmd.args(["run", "--port", &port.to_string(), "--data"])
        .arg(data)
        .envs(home_envs(envs, home.as_ref().map(EmptyHome::path)))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let child = cmd.spawn().expect("spawn agentglimd");
    Spawned { child, home, mock }
}

/// Two starters may write the config at once; the rename keeps a reader from seeing half a file.
fn write_atomic(path: &Path, text: &str) {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, text).expect("write test config");
    std::fs::rename(&tmp, path).expect("install test config");
}

/// A caller's explicit HOME/USERPROFILE wins; otherwise both point at the owned `default_home`, so adapters never read
/// the developer's real home. One key alone is mirrored, so the daemon stays hermetic either way.
fn home_envs(envs: &[(&str, &str)], default_home: Option<&Path>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = envs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let find = |k: &str| {
        envs.iter()
            .find(|(e, _)| *e == k)
            .map(|(_, v)| v.to_string())
            .filter(|v| !v.is_empty())
    };
    match (find("HOME"), find("USERPROFILE")) {
        (Some(_), Some(_)) => {}
        (Some(h), None) => out.push(("USERPROFILE".into(), h)),
        (None, Some(p)) => out.push(("HOME".into(), p)),
        (None, None) => {
            let empty = default_home
                .expect("a daemon without an explicit home needs an owned default home")
                .display()
                .to_string();
            out.push(("HOME".into(), empty.clone()));
            out.push(("USERPROFILE".into(), empty));
        }
    }
    out
}

pub struct Daemon {
    pub child: Option<Child>,
    pub port: u16,
    pub data: PathBuf,
    pub token: String,
    pub home: Option<EmptyHome>,
    pub mock: MockRuntimes,
}

impl Daemon {
    pub fn start(data: &Path) -> Daemon {
        Self::start_on(data, free_port())
    }

    pub fn start_on(data: &Path, port: u16) -> Daemon {
        Self::start_env(data, port, &[])
    }

    /// Starts with extra env vars (e.g. HOME of a fixture home, poll intervals).
    pub fn start_env(data: &Path, port: u16, envs: &[(&str, &str)]) -> Daemon {
        Self::wrap(spawn_env(data, port, envs), data, port)
    }

    /// Starts with an explicit `config.json` (runtime URLs of the caller's choosing).
    pub fn start_with_config(
        data: &Path,
        port: u16,
        envs: &[(&str, &str)],
        config_json: &str,
    ) -> Daemon {
        Self::wrap(spawn_with_config(data, port, envs, config_json), data, port)
    }

    fn wrap(spawned: Spawned, data: &Path, port: u16) -> Daemon {
        let Spawned { child, home, mock } = spawned;
        let mut d = Daemon {
            child: Some(child),
            port,
            data: data.to_path_buf(),
            token: String::new(),
            home,
            mock,
        };
        d.wait_healthy(Duration::from_secs(5));
        d.token = std::fs::read_to_string(data.join("token"))
            .unwrap()
            .trim()
            .to_string();
        d
    }

    /// The owned mock endpoints this daemon's config points at.
    pub fn mock(&self) -> &MockRuntimes {
        &self.mock
    }

    /// The default home created for this daemon, or `None` when the caller supplied one.
    pub fn default_home(&self) -> Option<&Path> {
        self.home.as_ref().map(EmptyHome::path)
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}/api/v1{path}", self.port)
    }

    pub fn wait_healthy(&mut self, within: Duration) {
        let c = client();
        let t0 = Instant::now();
        while t0.elapsed() < within {
            if let Ok(r) = c.get(self.url("/health")).send() {
                if r.status() == 200 {
                    return;
                }
            }
            if let Some(Ok(Some(st))) = self.child.as_mut().map(|c| c.try_wait()) {
                panic!("daemon exited early: {st}");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("daemon not healthy within {within:?}");
    }

    pub fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    /// SIGTERM by our own child's pid, then wait up to `within`.
    pub fn term(&mut self, within: Duration) -> Option<ExitStatus> {
        let pid = self.pid().to_string();
        Command::new("kill").args(["-TERM", &pid]).status().unwrap();
        let t0 = Instant::now();
        let child = self.child.as_mut().unwrap();
        while t0.elapsed() < within {
            if let Some(st) = child.try_wait().unwrap() {
                self.child = None;
                return Some(st);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }

    /// SIGKILL by our own child's pid (std Child::kill), reaped.
    pub fn kill9(&mut self) {
        let mut c = self.child.take().unwrap();
        c.kill().unwrap();
        c.wait().unwrap();
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        // Kill and reap our own child first; the owned home and mocks are fields, so they drop after this body.
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        release_port(self.port);
    }
}

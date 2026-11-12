//! agentglimd CLI: run | stop | open | token | service (05).

use agentglimd::api::{self, AppState};
use agentglimd::auth::tokens;
use agentglimd::config::Config;
use agentglimd::core::bus::Bus;
use agentglimd::core::lock::DaemonLock;
use agentglimd::core::poller;
use agentglimd::core::tasks::TaskRunner;
use agentglimd::store::Store;
use agentglimd::{adapters, logging, runtimes};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const USAGE: &str = "usage: agentglimd [run] [--port N] [--data DIR] | stop [--data DIR] | open [--port N] | token [--data DIR] | service install|uninstall|status";

struct Args {
    cmd: String,
    port: Option<u16>,
    data: PathBuf,
}

fn default_data() -> PathBuf {
    if let Some(d) = std::env::var_os("AGENTGLIM_DATA") {
        return d.into();
    }
    let home = agentglimd::adapters::resolve_home();
    home.join(".agentglim")
}

fn parse() -> Result<Args, String> {
    let mut a = Args {
        cmd: "run".into(),
        port: None,
        data: default_data(),
    };
    let mut it = std::env::args().skip(1);
    let mut first = true;
    while let Some(x) = it.next() {
        match x.as_str() {
            "--port" => {
                let v = it.next().ok_or("--port needs a value")?;
                a.port = Some(v.parse().map_err(|_| format!("bad port '{v}'"))?);
            }
            "--data" => a.data = it.next().ok_or("--data needs a value")?.into(),
            "-h" | "--help" => return Err(USAGE.into()),
            c if first && !c.starts_with('-') => a.cmd = c.to_string(),
            other => {
                if a.cmd != "service" {
                    return Err(format!("unknown argument '{other}'\n{USAGE}"));
                }
            }
        }
        first = false;
    }
    Ok(a)
}

fn main() -> ExitCode {
    let args = match parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match args.cmd.as_str() {
        "run" => run(args),
        "token" => {
            println!("{}", tokens::token_path(&args.data).display());
            ExitCode::SUCCESS
        }
        "open" => {
            println!("http://127.0.0.1:{}/", args.port.unwrap_or(19360));
            ExitCode::SUCCESS
        }
        "stop" => stop(&args),
        "service" => {
            eprintln!("service install|uninstall|status ships in sub-item 05");
            ExitCode::from(2)
        }
        other => {
            eprintln!("unknown command '{other}'\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// Stops the daemon recorded in the lock file, after proving that pid is still the process that wrote the lock.
/// Nothing is signalled unless the pid and its process start time match the lock; there is no pid-only fallback.
fn stop(args: &Args) -> ExitCode {
    use agentglimd::core::lock::{pid_alive, verify_owner, LockError};

    let id = match verify_owner(&args.data) {
        Ok(id) => id,
        // No lock: the daemon is not running (nothing to stop, nothing to signal).
        Err(LockError::NoLock) => {
            eprintln!("no daemon lock; nothing to stop");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("refusing to stop: {e}");
            return ExitCode::from(3);
        }
    };

    if let Err(e) = signal_term(id.pid) {
        eprintln!("refusing to stop: {e}");
        return ExitCode::from(3);
    }
    let t0 = Instant::now();
    while t0.elapsed() < STOP_WAIT {
        if !pid_alive(id.pid) {
            println!("stopped daemon pid {}", id.pid);
            return ExitCode::SUCCESS;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    eprintln!(
        "daemon pid {} did not exit within {} s",
        id.pid,
        STOP_WAIT.as_secs()
    );
    ExitCode::from(1)
}

/// How long `stop` waits for the verified daemon to exit.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// SIGTERM to exactly this pid. Unix only; the pid was verified against the lock immediately before this call.
#[cfg(unix)]
fn signal_term(pid: u32) -> Result<(), String> {
    let ok = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|e| format!("cannot run kill for pid {pid}: {e}"))?
        .success();
    if ok {
        Ok(())
    } else {
        Err(format!("kill -TERM {pid} failed"))
    }
}

/// Windows stop stays unimplemented until sub-item 05 stops the daemon through the service manager.
#[cfg(not(unix))]
fn signal_term(_pid: u32) -> Result<(), String> {
    Err("stop is not supported on this platform until sub-item 05 (service manager)".into())
}

fn run(args: Args) -> ExitCode {
    if let Err(e) = std::fs::create_dir_all(&args.data) {
        eprintln!("cannot create data dir: {e}");
        return ExitCode::from(2);
    }
    let mut cfg = match Config::load(&args.data) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("refusing to start: {e}");
            return ExitCode::from(2);
        }
    };
    if let Some(p) = args.port {
        cfg.port = p;
        if let Err(e) = cfg.validate() {
            eprintln!("refusing to start: {e}");
            return ExitCode::from(2);
        }
    }
    let lock = match DaemonLock::acquire(&args.data) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("refusing to start: {e}");
            return ExitCode::from(3);
        }
    };
    let _guard = match logging::init(&args.data) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("cannot open logs: {e}");
            return ExitCode::from(2);
        }
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = rt.block_on(serve(args.data.clone(), cfg, lock.reclaimed));
    drop(lock);
    code
}

async fn serve(data: PathBuf, cfg: Config, reclaimed: bool) -> ExitCode {
    let store = match Store::open(&data.join("state.db")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("refusing to start: database: {e}");
            return ExitCode::from(2);
        }
    };
    let token = match tokens::load_or_create(&data) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("refusing to start: token: {e}");
            return ExitCode::from(2);
        }
    };
    let bus = Arc::new(Bus::new(store.clone()).expect("bus"));
    let tasks = TaskRunner::new(store.clone(), bus.clone());
    let interrupted = tasks.recover().unwrap_or(0);
    {
        // Retention: prune at start and hourly; the period re-reads retention_days from the live config.
        let store = store.clone();
        let days = cfg.retention_days;
        match store.prune_events(days) {
            Ok(n) => tracing::info!(pruned = n, days, "event retention applied"),
            Err(e) => tracing::warn!(error = %e, "event retention failed"),
        }
    }
    let mut cfg = cfg;
    // Normalize empty HOME/USERPROFILE so adapters and status use one nonempty resolution.
    if std::env::var("HOME").map(|v| v.is_empty()).unwrap_or(true) {
        if let Ok(p) = std::env::var("USERPROFILE") {
            if !p.is_empty() {
                std::env::set_var("HOME", &p);
            }
        }
    }
    if std::env::var("USERPROFILE")
        .map(|v| v.is_empty())
        .unwrap_or(true)
    {
        if let Ok(h) = std::env::var("HOME") {
            if !h.is_empty() {
                std::env::set_var("USERPROFILE", &h);
            }
        }
    }
    let home: PathBuf = agentglimd::adapters::resolve_home();
    if cfg.flags_dir.is_none() {
        cfg.flags_dir = Some(cfg.resolve_flags_dir(&home).display().to_string());
    }
    let addr = SocketAddr::new(cfg.bind.parse().expect("validated bind"), cfg.port);
    let state = AppState {
        store,
        bus: bus.clone(),
        tasks: tasks.clone(),
        token: Arc::new(token),
        sources: Arc::new(adapters::registry(&cfg)),
        runtimes: Arc::new(runtimes::registry(&cfg)),
        config: Arc::new(RwLock::new(cfg)),
        data_dir: data,
        started: Instant::now(),
        status: Arc::new(agentglimd::core::poller::StatusCache::new()),
    };
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let poller = poller::spawn_poller(
        poller::PollerDeps {
            store: state.store.clone(),
            bus: bus.clone(),
            sources: state.sources.clone(),
            runtimes: state.runtimes.clone(),
            status: state.status.clone(),
            env: agentglimd::core::Env {
                home,
                vars: Default::default(),
            },
            intervals: poller::Intervals::from_env(),
            refresh: tasks.refresh_rx(),
        },
        stop_rx,
    );
    {
        let (store, config) = (state.store.clone(), state.config.clone());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            tick.tick().await;
            loop {
                tick.tick().await;
                let days = config.read().map(|c| c.retention_days).unwrap_or(30);
                if let Err(e) = store.prune_events(days) {
                    tracing::warn!(error = %e, "event retention failed");
                }
            }
        });
    }
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("refusing to start: bind {addr}: {e}");
            return ExitCode::from(2);
        }
    };
    tracing::info!(%addr, reclaimed_lock = reclaimed, interrupted, "agentglimd started");
    let _ = bus.publish("daemon", "daemon", serde_json::json!({"state": "started"}));
    let app = api::router(state).into_make_service_with_connect_info::<SocketAddr>();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
    });
    wait_for_signal().await;
    let _ = stop_tx.send(true);
    if tokio::time::timeout(Duration::from_secs(2), poller)
        .await
        .is_err()
    {
        tracing::warn!("poller did not stop in 2 s");
    }
    let n = tasks
        .shutdown(agentglimd::core::tasks::SHUTDOWN_GRACE)
        .await;
    tracing::info!(interrupted = n, "shutdown requested; tasks interrupted");
    let _ = bus.publish("daemon", "daemon", serde_json::json!({"state": "stopping"}));
    let _ = tx.send(());
    if tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .is_err()
    {
        tracing::warn!("connections did not drain in 2 s; exiting");
    }
    tracing::info!("agentglimd stopped");
    ExitCode::SUCCESS
}

#[cfg(unix)]
async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

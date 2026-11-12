//! Runtime probes against a local mock (std TcpListener on a free 1936x port) serving recorded-shape fixtures.

mod common;

use agentglimd::config::Config;
use agentglimd::core::{Runtime, RuntimeState};
use agentglimd::runtimes::{llamacpp::LlamaCpp, ollama::Ollama, registry, strata::Strata};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

fn fixture(name: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/runtimes")
        .join(name);
    std::fs::read_to_string(p).unwrap()
}

/// Mock HTTP server: path -> (status, body); unknown paths 404. Stopped (and joined) on drop.
struct Mock {
    port: u16,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    th: Option<JoinHandle<()>>,
}

impl Mock {
    fn start(routes: &[(&str, u16, String)]) -> Mock {
        let port = common::free_port();
        let l = TcpListener::bind(("127.0.0.1", port)).unwrap();
        l.set_nonblocking(true).unwrap();
        let routes: HashMap<String, (u16, String)> = routes
            .iter()
            .map(|(p, s, b)| (p.to_string(), (*s, b.clone())))
            .collect();
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (h, s) = (hits.clone(), stop.clone());
        let th = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Ok((mut c, _)) = l.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                h.fetch_add(1, Ordering::SeqCst);
                c.set_nonblocking(false).unwrap();
                c.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut buf = Vec::new();
                let mut b = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match c.read(&mut b) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&b[..n]),
                    }
                }
                let req = String::from_utf8_lossy(&buf);
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                let (st, body) = routes.get(&path).cloned().unwrap_or((404, "{}".into()));
                let _ = write!(
                    c,
                    "HTTP/1.1 {st} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Mock {
            port,
            hits,
            stop,
            th: Some(th),
        }
    }
    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.th.take() {
            let _ = t.join();
        }
    }
}

fn llama_routes() -> Vec<(&'static str, u16, String)> {
    vec![
        ("/health", 200, fixture("llamacpp_health.json")),
        ("/slots", 200, fixture("llamacpp_slots.json")),
    ]
}

/// A port nothing listens on (bound then released).
fn dead_base() -> String {
    format!("http://127.0.0.1:{}", common::free_port())
}

#[tokio::test]
async fn runtimes_ollama_up_from_fixture() {
    let m = Mock::start(&[("/api/ps", 200, fixture("ollama_api_ps.json"))]);
    let st = Ollama { base: m.base() }.probe().await;
    assert_eq!(
        st,
        RuntimeState::Up {
            models: vec!["llama3.2:3b".into(), "nomic-embed-text:latest".into()],
            vram_bytes: 3_600_000_000,
            ram_bytes: 400_000_000,
            slots: 0,
            ctx: 0,
            tps: 0.0,
        }
    );
    assert_eq!(m.hits(), 1);
}

#[tokio::test]
async fn runtimes_llamacpp_up_from_fixture() {
    let m = Mock::start(&llama_routes());
    let st = LlamaCpp { base: m.base() }.probe().await;
    assert_eq!(
        st,
        RuntimeState::Up {
            models: vec!["qwen2.5-coder-7b-instruct-q4_k_m.gguf".into()],
            vram_bytes: 0,
            ram_bytes: 0,
            slots: 2,
            ctx: 8192,
            tps: 0.0,
        }
    );
    assert_eq!(m.hits(), 2);
}

#[tokio::test]
async fn runtimes_down_on_error_status_bad_body_or_no_server() {
    let m = Mock::start(&[
        ("/api/ps", 500, "{}".into()),
        ("/health", 503, r#"{"status":"loading model"}"#.into()),
    ]);
    assert_eq!(Ollama { base: m.base() }.probe().await, RuntimeState::Down);
    assert_eq!(
        LlamaCpp { base: m.base() }.probe().await,
        RuntimeState::Down
    );
    let bad = Mock::start(&[("/api/ps", 200, "not json".into())]);
    assert_eq!(
        Ollama { base: bad.base() }.probe().await,
        RuntimeState::Down
    );
    assert_eq!(
        Ollama { base: dead_base() }.probe().await,
        RuntimeState::Down
    );
    assert_eq!(
        LlamaCpp { base: dead_base() }.probe().await,
        RuntimeState::Down
    );
}

#[tokio::test]
async fn runtimes_strata_owner_off_makes_zero_requests() {
    let m = Mock::start(&llama_routes());
    let flags = tempfile::tempdir().unwrap();
    let s = Strata {
        base: m.base(),
        flags_dir: Some(flags.path().to_path_buf()),
    };
    // No flag: probes like llama.cpp.
    assert!(matches!(s.probe().await, RuntimeState::Up { slots: 2, .. }));
    let before = m.hits();
    assert_eq!(before, 2);
    std::fs::write(flags.path().join("local_off_owner"), "").unwrap();
    assert_eq!(s.probe().await, RuntimeState::OwnerOff);
    assert_eq!(s.probe().await, RuntimeState::OwnerOff);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        m.hits(),
        before,
        "mock must get zero requests while owner_off"
    );
}

#[tokio::test]
async fn runtimes_registry_uses_config_urls() {
    let m = Mock::start(&[("/api/ps", 200, fixture("ollama_api_ps.json"))]);
    let mut cfg = Config::default();
    cfg.runtime_urls.insert("ollama".into(), m.base());
    cfg.runtime_urls.insert("llamacpp".into(), dead_base());
    cfg.runtime_urls.insert("strata".into(), dead_base());
    let r = registry(&cfg);
    assert!(matches!(r[0].probe().await, RuntimeState::Up { .. }));
    assert_eq!(r[1].probe().await, RuntimeState::Down);
    assert_eq!(r[2].probe().await, RuntimeState::Down);
}

#[test]
fn runtimes_status_lists_three_runtimes() {
    let ollama = Mock::start(&[("/api/ps", 200, fixture("ollama_api_ps.json"))]);
    let llama = Mock::start(&llama_routes());
    let strata = Mock::start(&llama_routes());
    let data = tempfile::tempdir().unwrap();
    let flags: PathBuf = data.path().join("flags");
    std::fs::create_dir(&flags).unwrap();
    std::fs::write(flags.join("local_off_owner"), "").unwrap();
    let cfg = serde_json::json!({
        "runtime_urls": {"ollama": ollama.base(), "llamacpp": llama.base(), "strata": strata.base()},
        "flags_dir": flags.to_str().unwrap(),
    });
    std::fs::write(data.path().join("config.json"), cfg.to_string()).unwrap();
    let d = common::Daemon::start(data.path());
    let v: Value = common::client()
        .get(d.url("/status"))
        .header("Authorization", format!("Bearer {}", d.token))
        .send()
        .unwrap()
        .json()
        .unwrap();
    drop(d);
    let rts = v["runtimes"].as_array().unwrap();
    let by_id: HashMap<&str, &Value> = rts
        .iter()
        .map(|r| (r["id"].as_str().unwrap(), &r["state"]))
        .collect();
    assert_eq!(rts.len(), 3, "{v}");
    assert_eq!(by_id["ollama"]["state"], "up");
    assert_eq!(by_id["ollama"]["vram_bytes"], 3_600_000_000u64);
    assert_eq!(by_id["llamacpp"]["state"], "up");
    assert_eq!(by_id["llamacpp"]["ctx"], 8192);
    assert_eq!(by_id["strata"]["state"], "owner_off");
    assert_eq!(strata.hits(), 0);
}

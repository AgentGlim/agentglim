mod common;
use common::{client, Daemon};
use serde_json::{json, Value};

#[test]
fn api_v1_contract() {
    let dir = tempfile::tempdir().unwrap();
    let d = Daemon::start(dir.path());
    let c = client();
    let auth = format!("Bearer {}", d.token);

    // health: public on localhost, no paths, api_version header
    let r = c.get(d.url("/health")).send().unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["api_version"], "1");
    let h: Value = r.json().unwrap();
    assert_eq!(h["ok"], true);
    assert_eq!(h["api_version"], 1);
    assert!(!h.to_string().contains(dir.path().to_str().unwrap()));

    // status: 401 without / with wrong token, 200 with token (both header forms)
    let r = c.get(d.url("/status")).send().unwrap();
    assert_eq!(r.status(), 401);
    assert_eq!(r.headers()["api_version"], "1");
    let e: Value = r.json().unwrap();
    assert_eq!(e["error"]["code"], "unauthorized");
    assert_eq!(
        c.get(d.url("/status"))
            .header("Authorization", "Bearer nope")
            .send()
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(d.url("/status"))
            .header("Authorization", &auth)
            .send()
            .unwrap()
            .status(),
        200
    );
    let s: Value = c
        .get(d.url("/status"))
        .header("X-Agentglim-Token", &d.token)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(s["api_version"], 1);
    assert!(s["sources"].is_array());

    // DNS rebinding: foreign Host header refused
    let r = c
        .get(d.url("/status"))
        .header("Authorization", &auth)
        .header("Host", "evil.example")
        .send()
        .unwrap();
    assert_eq!(r.status(), 400);

    // tasks: create 201, duplicate 409, unknown field 422, bad kind 422, cancel, 404
    let post = |b: Value| {
        c.post(d.url("/tasks"))
            .header("Authorization", &auth)
            .json(&b)
            .send()
            .unwrap()
    };
    assert_eq!(post(json!({"id": "t-1", "kind": "noop"})).status(), 201);
    let dup = post(json!({"id": "t-1", "kind": "noop"}));
    assert_eq!(dup.status(), 409);
    assert_eq!(
        dup.json::<Value>().unwrap()["error"]["code"],
        "duplicate_task"
    );
    assert_eq!(
        post(json!({"id": "t-2", "kind": "noop", "extra": 1})).status(),
        422
    );
    assert_eq!(post(json!({"id": "t-3", "kind": "rm -rf"})).status(), 422);
    assert_eq!(post(json!({"id": "t 4", "kind": "noop"})).status(), 422);
    assert_eq!(
        post(json!({"id": "s-1", "kind": "sleep", "ms": 60000})).status(),
        201
    );
    let r = c
        .post(d.url("/tasks/s-1/cancel"))
        .header("Authorization", &auth)
        .send()
        .unwrap();
    assert_eq!(r.json::<Value>().unwrap()["task"]["state"], "cancelled");
    assert_eq!(
        c.post(d.url("/tasks/none/cancel"))
            .header("Authorization", &auth)
            .send()
            .unwrap()
            .status(),
        404
    );
    let list: Value = c
        .get(d.url("/tasks"))
        .header("Authorization", &auth)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(list["tasks"].as_array().unwrap().len(), 2);

    // config: GET, PATCH validated (remote bind refused, unknown field refused), good PATCH persisted
    let g: Value = c
        .get(d.url("/config"))
        .header("Authorization", &auth)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(g["config"]["bind"], "127.0.0.1");
    let patch = |b: Value| {
        c.patch(d.url("/config"))
            .header("Authorization", &auth)
            .json(&b)
            .send()
            .unwrap()
    };
    assert_eq!(patch(json!({"bind": "0.0.0.0"})).status(), 422);
    assert_eq!(patch(json!({"colour": "red"})).status(), 422);
    assert_eq!(patch(json!({"retention_days": 7})).status(), 200);
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(saved["retention_days"], 7);

    // logs: JSON lines, level filter, bad level 400; token never logged
    std::thread::sleep(std::time::Duration::from_millis(300));
    let l: Value = c
        .get(d.url("/logs?level=info"))
        .header("Authorization", &auth)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert!(!l["lines"].as_array().unwrap().is_empty());
    assert!(l["lines"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x["level"] == "INFO"));
    assert_eq!(
        c.get(d.url("/logs?level=loud"))
            .header("Authorization", &auth)
            .send()
            .unwrap()
            .status(),
        400
    );
    let logtext = std::fs::read_to_string(dir.path().join("logs/agentglimd.log")).unwrap();
    assert!(!logtext.contains(&d.token));

    // unknown route: 404 envelope (after auth)
    let r = c
        .get(d.url("/nope"))
        .header("Authorization", &auth)
        .send()
        .unwrap();
    assert_eq!(r.status(), 404);
    assert_eq!(r.json::<Value>().unwrap()["error"]["code"], "not_found");
}

#[test]
fn method_not_allowed_envelope() {
    let dir = tempfile::tempdir().unwrap();
    let d = Daemon::start(dir.path());
    let r = client()
        .delete(d.url("/tasks"))
        .header("Authorization", format!("Bearer {}", d.token))
        .send()
        .unwrap();
    assert_eq!(r.status(), 405);
    assert_eq!(r.headers()["api_version"], "1");
    let e: Value = r.json().unwrap();
    assert_eq!(e["error"]["code"], "method_not_allowed");
    assert!(e["error"]["message"].is_string());
}

#[test]
fn bearer_scheme_case_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    let d = Daemon::start(dir.path());
    let c = client();
    for scheme in ["bearer", "BEARER", "Bearer", "bEaReR"] {
        let r = c
            .get(d.url("/status"))
            .header("Authorization", format!("{scheme} {}", d.token))
            .send()
            .unwrap();
        assert_eq!(r.status(), 200, "scheme {scheme}");
    }
    let r = c
        .get(d.url("/status"))
        .header("Authorization", format!("Basic {}", d.token))
        .send()
        .unwrap();
    assert_eq!(r.status(), 401);
}

fn write_log_lines(data: &std::path::Path, n: usize) {
    let dir = data.join("logs");
    std::fs::create_dir_all(&dir).unwrap();
    let text: String = (0..n)
        .map(|i| {
            format!(
                "{{\"timestamp\":\"2026-11-04T10:00:00Z\",\"level\":\"INFO\",\"target\":\"fixture\",\"fields\":{{\"message\":\"line\",\"i\":{i}}}}}\n"
            )
        })
        .collect();
    std::fs::write(dir.join("agentglimd.log"), text).unwrap();
}

fn get_logs(d: &Daemon, q: &str) -> Value {
    client()
        .get(d.url(&format!("/logs{q}")))
        .header("Authorization", format!("Bearer {}", d.token))
        .send()
        .unwrap()
        .json()
        .unwrap()
}

#[test]
fn logs_next_never_skips_when_capped() {
    let dir = tempfile::tempdir().unwrap();
    write_log_lines(dir.path(), 1200);
    let d = Daemon::start(dir.path());
    let a = get_logs(&d, "");
    assert_eq!(a["lines"].as_array().unwrap().len(), 500);
    assert_eq!(a["next"], 500);
    assert_eq!(a["reset"], false);
    let b = get_logs(&d, "?since=500");
    assert_eq!(b["lines"][0]["fields"]["i"], 500);
    assert_eq!(b["next"], 1000);
    let c = get_logs(&d, "?since=1000");
    assert_eq!(c["lines"][0]["fields"]["i"], 1000);
    assert_eq!(c["lines"][199]["fields"]["i"], 1199);
    // the daemon's own lines follow the fixture lines
    assert!(c["next"].as_u64().unwrap() >= 1200);
    assert_eq!(c["reset"], false);
}

#[test]
fn logs_cursor_resets_after_rotation() {
    let dir = tempfile::tempdir().unwrap();
    write_log_lines(dir.path(), 800);
    let d = Daemon::start(dir.path());
    let mut next = 0;
    loop {
        let p = get_logs(&d, &format!("?since={next}"));
        let n = p["next"].as_u64().unwrap();
        if n == next {
            break;
        }
        next = n;
    }
    assert!(next >= 800);
    // simulate rotation/truncation: the current file starts over with fewer lines
    write_log_lines(dir.path(), 3);
    let p = get_logs(&d, &format!("?since={next}"));
    assert_eq!(p["reset"], true);
    assert_eq!(p["lines"][0]["fields"]["i"], 0);
    let n = p["next"].as_u64().unwrap();
    assert!((3..next).contains(&n), "next {n}");
    assert_eq!(get_logs(&d, &format!("?since={n}"))["reset"], false);
}

fn get_status(d: &Daemon, c: &reqwest::blocking::Client) -> Value {
    c.get(d.url("/status"))
        .header("Authorization", format!("Bearer {}", d.token))
        .send()
        .unwrap()
        .json()
        .unwrap()
}

/// A runtime that accepts connections and never answers must not slow `/status` (no probe inside a request).
#[test]
fn status_does_not_wait_on_a_hanging_runtime() {
    let (port, l) = common::owned_listener();
    common::mock_runtime_endpoints();
    let held = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let h2 = held.clone();
    l.set_nonblocking(true).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let s2 = stop.clone();
    let th = std::thread::spawn(move || {
        while !s2.load(std::sync::atomic::Ordering::SeqCst) {
            match l.accept() {
                Ok((c, _)) => h2.lock().unwrap().push(c),
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
            }
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let url = format!("http://127.0.0.1:{port}");
    std::fs::write(
        dir.path().join("config.json"),
        json!({"runtime_urls": {"ollama": url, "llamacpp": url, "strata": url}}).to_string(),
    )
    .unwrap();
    let d = Daemon::start_env(dir.path(), common::free_port(), &[("AG_POLL_MS", "100")]);
    let c = client();
    for _ in 0..5 {
        let t0 = std::time::Instant::now();
        let v = get_status(&d, &c);
        let took = t0.elapsed();
        assert!(
            took < std::time::Duration::from_millis(300),
            "took {took:?}"
        );
        assert_eq!(v["runtimes"].as_array().unwrap().len(), 3);
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    th.join().unwrap();
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) {
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

/// Same fixture home as `tests/poll_loop.rs`: the cached status reports stored sessions.
#[test]
fn status_counts_sessions_from_fixture_home() {
    let fx = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    for (dir, ver) in [
        ("claude-code", "2.0"),
        ("codex", "0.50"),
        ("plans-harness", "v1-r2"),
    ] {
        copy_dir(&fx.join(dir).join(ver).join("home"), &home);
    }
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let d = Daemon::start_env(
        &data,
        common::free_port(),
        &[
            ("HOME", home.to_str().unwrap()),
            ("AG_POLL_MS", "100"),
            ("AG_DISCOVER_MS", "300"),
        ],
    );
    let c = client();
    let t0 = std::time::Instant::now();
    loop {
        let v = get_status(&d, &c);
        let sum: u64 = v["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["sessions"].as_u64().unwrap())
            .sum();
        if v["sessions"]["total"].as_u64().unwrap() > 0 {
            assert_eq!(v["sessions"]["total"].as_u64().unwrap(), sum);
            assert!(v["updated_ms"].as_u64().unwrap() > 0);
            break;
        }
        assert!(t0.elapsed().as_secs() < 10, "sessions.total stayed 0: {v}");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[test]
fn config_patch_persists_and_reports_restart_required() {
    let dir = tempfile::tempdir().unwrap();
    let d = Daemon::start(dir.path());
    let c = client();
    let auth = format!("Bearer {}", d.token);
    let r: Value = c
        .patch(d.url("/config"))
        .header("Authorization", &auth)
        .json(&json!({"sources": {"claude-code": false}, "history_days": 7}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(r["config"]["sources"]["claude-code"], false);
    assert_eq!(r["config"]["history_days"], 7);
    assert_eq!(
        r["restart_required_for"],
        json!(["bind", "port", "sources", "history_days"])
    );

    let g: Value = c
        .get(d.url("/config"))
        .header("Authorization", &auth)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(
        g["restart_required_for"],
        json!(["bind", "port", "sources", "history_days"])
    );

    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(saved["sources"]["claude-code"], false);
    assert_eq!(saved["history_days"], 7);
}

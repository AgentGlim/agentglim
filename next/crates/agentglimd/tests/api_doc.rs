//! Doc contract: every `<!-- example: METHOD PATH [body] -->` + ```json block in docs/api-v1.md is replayed against
//! the live daemon (in doc order) and compared by object key sets and value types, recursively.
mod common;
use common::{client, Daemon};
use serde_json::Value;

/// Objects under these keys are free-form maps (dynamic keys); only their type is compared.
const FREE_MAPS: &[&str] = &["fields", "sources", "roots", "runtime_urls"];

struct Example {
    method: String,
    path: String,
    body: Option<String>,
    json: Value,
}

fn examples(doc: &str) -> Vec<Example> {
    let mut out = Vec::new();
    let mut lines = doc.lines();
    while let Some(line) = lines.next() {
        let Some(rest) = line.trim().strip_prefix("<!-- example:") else {
            continue;
        };
        let rest = rest
            .trim_end()
            .strip_suffix("-->")
            .expect("example tag closes")
            .trim();
        let mut parts = rest.splitn(3, ' ');
        let method = parts.next().unwrap().to_string();
        let path = parts.next().expect("example path").to_string();
        let body = parts.next().map(|b| b.trim().to_string());
        let open = lines.next().expect("json block after tag");
        assert_eq!(
            open.trim(),
            "```json",
            "tag `{rest}` must be followed by ```json"
        );
        let mut text = String::new();
        for l in lines.by_ref() {
            if l.trim() == "```" {
                break;
            }
            text.push_str(l);
            text.push('\n');
        }
        let json = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("doc example `{rest}` is not JSON: {e}"));
        out.push(Example {
            method,
            path,
            body,
            json,
        });
    }
    out
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn compare(doc: &Value, live: &Value, at: &str, errs: &mut Vec<String>) {
    if doc.is_null() || live.is_null() {
        return;
    }
    if kind(doc) != kind(live) {
        errs.push(format!("{at}: doc {} vs live {}", kind(doc), kind(live)));
        return;
    }
    match (doc, live) {
        (Value::Object(d), Value::Object(l)) => {
            let free = FREE_MAPS.iter().any(|k| at.ends_with(&format!(".{k}")));
            if free {
                return;
            }
            let dk: Vec<_> = d.keys().collect();
            let lk: Vec<_> = l.keys().collect();
            if dk != lk {
                errs.push(format!("{at}: doc keys {dk:?} vs live keys {lk:?}"));
            }
            for (k, dv) in d {
                if let Some(lv) = l.get(k) {
                    compare(dv, lv, &format!("{at}.{k}"), errs);
                }
            }
        }
        (Value::Array(d), Value::Array(l)) => {
            if let (Some(dv), Some(lv)) = (d.first(), l.first()) {
                compare(dv, lv, &format!("{at}[0]"), errs);
            }
        }
        _ => {}
    }
}

#[test]
fn doc_examples_match_live_daemon() {
    let doc_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/api-v1.md");
    let doc = std::fs::read_to_string(doc_path).expect("read docs/api-v1.md");
    let ex = examples(&doc);
    assert!(
        ex.len() >= 8,
        "expected tagged examples, found {}",
        ex.len()
    );

    let dir = tempfile::tempdir().unwrap();
    let d = Daemon::start(dir.path());
    let c = client();
    let mut errs = Vec::new();
    for e in &ex {
        let method: reqwest::Method = e.method.parse().expect("method");
        let mut req = c
            .request(method, d.url(&e.path))
            .header("Authorization", format!("Bearer {}", d.token));
        if let Some(b) = &e.body {
            req = req
                .header("Content-Type", "application/json")
                .body(b.clone());
        }
        let r = req.send().unwrap();
        let live: Value = r
            .json()
            .unwrap_or_else(|err| panic!("{} {}: body not JSON: {err}", e.method, e.path));
        compare(
            &e.json,
            &live,
            &format!("{} {}", e.method, e.path),
            &mut errs,
        );
    }
    assert!(errs.is_empty(), "doc/live mismatches:\n{}", errs.join("\n"));
}

#[test]
fn comparator_catches_drift() {
    let mut errs = Vec::new();
    compare(
        &serde_json::json!({"a": 1, "b": {"c": "x"}}),
        &serde_json::json!({"a": "1", "b": {"d": "x"}}),
        "t",
        &mut errs,
    );
    assert_eq!(errs.len(), 2, "{errs:?}");
}

/// The tagged `up` runtime example, replayed against a daemon whose ollama URL is a fixture mock.
#[test]
fn up_runtime_example_matches_live_daemon() {
    use std::io::{Read, Write};
    let doc_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/api-v1.md");
    let doc = std::fs::read_to_string(doc_path).expect("read docs/api-v1.md");
    let tag = "<!-- example-up: GET /status -->";
    let after = &doc[doc.find(tag).expect("example-up tag") + tag.len()..];
    let block = after
        .split("```json")
        .nth(1)
        .and_then(|b| b.split("```").next())
        .expect("up json block");
    let want: Value = serde_json::from_str(block).expect("up example is JSON");

    let body = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/runtimes/ollama_api_ps.json"),
    )
    .unwrap();
    let mport = common::free_port();
    let l = std::net::TcpListener::bind(("127.0.0.1", mport)).unwrap();
    l.set_nonblocking(true).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let s2 = stop.clone();
    let th = std::thread::spawn(move || {
        while !s2.load(std::sync::atomic::Ordering::SeqCst) {
            let Ok((mut c, _)) = l.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            };
            c.set_nonblocking(false).unwrap();
            c.set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut buf = Vec::new();
            let mut b = [0u8; 1024];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match c.read(&mut b) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&b[..n]),
                }
            }
            let _ = write!(
                c,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        serde_json::json!({"runtime_urls": {"ollama": format!("http://127.0.0.1:{mport}")}})
            .to_string(),
    )
    .unwrap();
    let d = Daemon::start_env(
        dir.path(),
        common::free_port(),
        &[("AG_POLL_MS", "100"), ("AG_DISCOVER_MS", "300")],
    );
    let c = client();
    let t0 = std::time::Instant::now();
    let mut live = Value::Null;
    while t0.elapsed() < std::time::Duration::from_secs(10) {
        let v: Value = c
            .get(d.url("/status"))
            .header("Authorization", format!("Bearer {}", d.token))
            .send()
            .unwrap()
            .json()
            .unwrap();
        if v["runtimes"][0]["state"]["state"] == "up" {
            live = v["runtimes"][0].clone();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    th.join().unwrap();
    assert!(!live.is_null(), "ollama never reported up");
    let mut errs = Vec::new();
    compare(&want, &live, "runtime", &mut errs);
    assert!(errs.is_empty(), "{errs:?}");
    assert_eq!(live["state"]["models"].as_array().unwrap().len(), 2);
}

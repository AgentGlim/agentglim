//! `/status` against a daemon spawned with HOME = fixture home (detected) or an empty home.
mod common;

use std::path::Path;

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

fn status_with_home(home: &Path, data: &Path) -> serde_json::Value {
    let d = common::Daemon::start_env(
        data,
        common::free_port(),
        &[("HOME", home.to_str().unwrap())],
    );
    let r = common::client()
        .get(d.url("/status"))
        .bearer_auth(&d.token)
        .send()
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().unwrap();
    drop(d); // kills and reaps our own child by handle
    v
}

fn source<'a>(v: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    v["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap_or_else(|| panic!("{id} missing from /status: {v}"))
}

const IDS: [&str; 6] = [
    "plans-harness",
    "claude-code",
    "codex",
    "opencode",
    "agy",
    "pi",
];

#[test]
fn adapters_status_detected_with_fixture_home() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    for (a, ver) in [
        ("plans-harness", "v1-r2"),
        ("claude-code", "2.0"),
        ("codex", "0.50"),
        ("opencode", "1.0"),
        ("agy", "0.1"),
        ("pi", "0.60"),
    ] {
        copy_dir(&fx.join(a).join(ver).join("home"), &home);
    }
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let v = status_with_home(&home, &data);
    for id in IDS {
        let s = source(&v, id);
        println!("{id}: detected={}", s["detected"]);
        assert_eq!(s["detected"], true, "{s}");
        assert_eq!(s["caps"], serde_json::json!(["watch"]));
    }
    let arr = v["sources"].as_array().unwrap();
    assert_eq!(arr.len(), 6, "{v}");
    assert!(arr.iter().all(|s| s["id"] != "fake"));
}

#[test]
fn adapters_status_not_detected_with_empty_home() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let data = t.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let v = status_with_home(&home, &data);
    for id in IDS {
        let s = source(&v, id);
        println!("{id}: not detected: {}", s["reason"]);
        assert_eq!(s["detected"], false, "{s}");
        assert!(s["reason"].as_str().unwrap().contains("not found"), "{s}");
    }
}

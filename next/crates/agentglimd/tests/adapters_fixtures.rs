//! Adapter fixture tests: fixture home -> expected.json, not-detected on empty home, and an
//! mtime/size guard proving polls never write. `AG_BLESS=1` rewrites expected.json.
use agentglimd::adapters::{
    agy, claude_code, codex, opencode, pi, plans_harness, registry_with_home,
};
use agentglimd::config::Config;
use agentglimd::core::{Cursor, Detection, Env, Source};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

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

type Snap = BTreeMap<PathBuf, (u64, SystemTime)>;

fn snapshot(dir: &Path, out: &mut Snap) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        let m = std::fs::symlink_metadata(&p).unwrap();
        out.insert(p.clone(), (m.len(), m.modified().unwrap()));
        if m.is_dir() {
            snapshot(&p, out);
        }
    }
}

fn snap(dir: &Path) -> Snap {
    let mut s = Snap::new();
    snapshot(dir, &mut s);
    s
}

/// Copy of the fixture home for `adapter/version` in a temp dir.
fn home_copy(adapter: &str, version: &str) -> (tempfile::TempDir, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    copy_dir(&fixtures().join(adapter).join(version).join("home"), &home);
    (t, home)
}

fn make(id: &str, home: &Path) -> Box<dyn Source> {
    match id {
        plans_harness::ID => Box::new(plans_harness::PlansHarness::new(None, home, 30)),
        claude_code::ID => Box::new(claude_code::ClaudeCode::new(None, home, 30)),
        codex::ID => Box::new(codex::Codex::new(None, home, 30)),
        opencode::ID => Box::new(opencode::OpenCode::new(None, home, 30)),
        agy::ID => Box::new(agy::Agy::new(None, home, 30)),
        pi::ID => Box::new(pi::Pi::new(None, home, 30)),
        _ => unreachable!(),
    }
}

async fn check_fixture(id: &str, version: &str) {
    let (_t, home) = home_copy(id, version);
    let src = make(id, &home);
    let env = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    let det = src.detect(&env);
    println!("{id}: {det:?}");
    assert!(matches!(det, Detection::Detected { .. }), "{id}: {det:?}");
    assert_eq!(src.capabilities().names(), vec!["watch"]);
    let before = snap(&home);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(snap(&home), before, "{id}: poll changed files");
    let got = serde_json::to_value(&b.items).unwrap();
    let exp_path = fixtures().join(id).join(version).join("expected.json");
    if std::env::var_os("AG_BLESS").is_some() {
        let mut s = serde_json::to_string_pretty(&got).unwrap();
        s.push('\n');
        std::fs::write(&exp_path, s).unwrap();
    }
    let exp: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&exp_path).unwrap()).unwrap();
    assert_eq!(got, exp, "{id}: items differ from expected.json");
    assert!(!b.items.is_empty());
    // Second poll from the returned cursor: nothing new, still no writes.
    let b2 = src.poll(b.next).await.unwrap();
    assert!(b2.items.is_empty(), "{id}: repeated items {:?}", b2.items);
    assert_eq!(snap(&home), before, "{id}: second poll changed files");
    // Cursor(0) resets and replays the same items.
    let b3 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(serde_json::to_value(&b3.items).unwrap(), exp);
}

#[tokio::test]
async fn adapters_plans_harness_fixture() {
    check_fixture(plans_harness::ID, "v1-r2").await;
}

#[tokio::test]
async fn adapters_claude_code_fixture() {
    check_fixture(claude_code::ID, "2.0").await;
}

#[tokio::test]
async fn adapters_codex_fixture() {
    check_fixture(codex::ID, "0.50").await;
}

#[tokio::test]
async fn adapters_opencode_fixture() {
    check_fixture(opencode::ID, "1.0").await;
}

#[tokio::test]
async fn adapters_agy_fixture() {
    check_fixture(agy::ID, "0.1").await;
}

#[tokio::test]
async fn adapters_pi_fixture() {
    check_fixture(pi::ID, "0.60").await;
}

#[tokio::test]
async fn adapters_not_detected_on_empty_home() {
    let t = tempfile::tempdir().unwrap();
    let env = Env {
        home: t.path().to_path_buf(),
        vars: Default::default(),
    };
    let srcs = registry_with_home(&Config::default(), t.path());
    assert_eq!(srcs.len(), 6);
    for s in &srcs {
        match s.detect(&env) {
            Detection::NotDetected { reason } => {
                println!("{}: not detected: {reason}", s.id());
                assert!(reason.contains("not found"));
                assert!(!reason.contains(&t.path().display().to_string()));
            }
            d => panic!("{} detected on empty home: {d:?}", s.id()),
        }
        let b = s.poll(Cursor(0)).await.unwrap();
        assert!(b.items.is_empty());
    }
    assert!(std::fs::read_dir(t.path()).unwrap().next().is_none());
}

#[tokio::test]
async fn adapters_root_override() {
    let (_t, home) = home_copy(codex::ID, "0.50");
    let mut cfg = Config::default();
    cfg.roots.insert(
        codex::ID.into(),
        home.join(".codex/sessions").display().to_string(),
    );
    let empty = tempfile::tempdir().unwrap();
    let srcs = registry_with_home(&cfg, empty.path());
    let cx = srcs.iter().find(|s| s.id() == codex::ID).unwrap();
    let env = Env {
        home: empty.path().to_path_buf(),
        vars: Default::default(),
    };
    assert!(matches!(cx.detect(&env), Detection::Detected { .. }));
    assert!(!cx.poll(Cursor(0)).await.unwrap().items.is_empty());
}

#[tokio::test]
async fn adapters_mtime_guard_all_fixtures() {
    // Every adapter against a combined temp copy of all fixture homes; snapshot after every poll.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    for (a, v) in [
        (plans_harness::ID, "v1-r2"),
        (claude_code::ID, "2.0"),
        (codex::ID, "0.50"),
        (opencode::ID, "1.0"),
        (agy::ID, "0.1"),
        (pi::ID, "0.60"),
    ] {
        copy_dir(&fixtures().join(a).join(v).join("home"), &home);
    }
    let before = snap(t.path());
    let srcs = registry_with_home(&Config::default(), &home);
    for s in &srcs {
        let mut c = Cursor(0);
        for _ in 0..3 {
            c = s.poll(c).await.unwrap().next;
            assert_eq!(snap(t.path()), before, "{} wrote during poll", s.id());
        }
    }
}

#[tokio::test]
async fn adapters_claude_code_tails_appended_lines() {
    let (_t, home) = home_copy(claude_code::ID, "2.0");
    let src = make(claude_code::ID, &home);
    let b = src.poll(Cursor(0)).await.unwrap();
    let f = home.join(".claude/projects/-work-demo-app/7f3c2a1e-0b4d-4c8e-9a51-2d6f0e8b1c33.jsonl");
    // Finish the partial last line; the next poll yields exactly that user step.
    let mut text = std::fs::read_to_string(&f).unwrap();
    text.push_str("ten\"},\"timestamp\":\"2026-10-30T09:01:00.000Z\"}\n");
    std::fs::write(&f, text).unwrap();
    let b2 = src.poll(b.next).await.unwrap();
    assert_eq!(b2.items.len(), 1, "{:?}", b2.items);
    assert_eq!(b2.items[0].data["role"], "user");
    assert_eq!(b2.items[0].session, "7f3c2a1e-0b4d-4c8e-9a51-2d6f0e8b1c33");
    assert!(b2.next.0 > b.next.0);
}

const ALL: [(&str, &str); 6] = [
    (plans_harness::ID, "v1-r2"),
    (claude_code::ID, "2.0"),
    (codex::ID, "0.50"),
    (opencode::ID, "1.0"),
    (agy::ID, "0.1"),
    (pi::ID, "0.60"),
];

#[tokio::test]
async fn adapters_offsets_restore_no_reread() {
    for (id, ver) in ALL.into_iter().filter(|(id, _)| *id != plans_harness::ID) {
        let (_t, home) = home_copy(id, ver);
        let a = make(id, &home);
        let b = a.poll(Cursor(0)).await.unwrap();
        assert!(!b.items.is_empty(), "{id}");
        let offs = a.offsets();
        assert!(!offs.is_empty(), "{id}: no offsets");
        assert!(offs
            .iter()
            .all(|o| !o.path.contains('\\') && !o.path.starts_with('/')));
        // A fresh instance restored from the offsets must not reread anything.
        let c = make(id, &home);
        c.restore_offsets(offs.clone());
        let b2 = c.poll(Cursor(b.next.0.max(1))).await.unwrap();
        assert!(b2.items.is_empty(), "{id}: reread {:?}", b2.items);
        assert!(b2.next.0 >= 1);
        // A restored size larger than the file means truncation: restart at 0.
        let d = make(id, &home);
        d.restore_offsets(
            offs.iter()
                .map(|o| agentglimd::core::FileOffset {
                    path: o.path.clone(),
                    offset: o.offset + 100_000,
                    size: o.size + 100_000,
                })
                .collect(),
        );
        let b3 = d.poll(Cursor(1)).await.unwrap();
        assert_eq!(b3.items, b.items, "{id}: truncation did not restart at 0");
    }
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(text.as_bytes()).unwrap();
}

#[tokio::test]
async fn adapters_append_after_restore_yields_only_new() {
    let new_line = |id: &str| -> (&str, String) {
        match id {
            "codex" => (
                ".codex/sessions/2026/10/30/rollout-2026-10-30T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl",
                "{\"timestamp\":\"2026-10-30T10:01:00.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[]}}\n".into(),
            ),
            "agy" => (
                ".gemini/antigravity-cli/brain/4c1d9e70-2b35-4a8f-9d64-0e7a1f3b5c28/.system_generated/logs/transcript.jsonl",
                "{\"type\":\"user_input\",\"timestamp\":\"2026-10-31T08:01:00.000Z\"}\n".into(),
            ),
            _ => (
                ".pi/agent/sessions/--work-demo-app--/2026-10-31T09-00-00-000Z_5e2f7a90-1c3d-4b6e-8f01-a2b3c4d5e6f7.jsonl",
                "{\"type\":\"message\",\"timestamp\":\"2026-10-31T09:01:00.000Z\",\"message\":{\"role\":\"user\"}}\n".into(),
            ),
        }
    };
    for (id, ver) in [(codex::ID, "0.50"), (agy::ID, "0.1"), (pi::ID, "0.60")] {
        let (_t, home) = home_copy(id, ver);
        let a = make(id, &home);
        a.poll(Cursor(0)).await.unwrap();
        let offs = a.offsets();
        let (rel, line) = new_line(id);
        append(&home.join(rel), &line);
        let c = make(id, &home);
        c.restore_offsets(offs);
        let b = c.poll(Cursor(1)).await.unwrap();
        assert_eq!(b.items.len(), 1, "{id}: {:?}", b.items);
        assert_eq!(b.items[0].data["role"], "user");
        // And a live instance tails the same append after a discover.
        let live = make(id, &home);
        let first = live.poll(Cursor(0)).await.unwrap();
        append(&home.join(rel), &line);
        let more = live.poll(first.next).await.unwrap();
        assert_eq!(more.items.len(), 1, "{id}: {:?}", more.items);
    }
}

#[tokio::test]
async fn adapters_opencode_new_message_after_restore() {
    let (_t, home) = home_copy(opencode::ID, "1.0");
    let a = make(opencode::ID, &home);
    a.poll(Cursor(0)).await.unwrap();
    let offs = a.offsets();
    let dir = home.join(".local/share/opencode/storage/message/ses_demo0001");
    std::fs::write(
        dir.join("msg_0004.json"),
        r#"{"id":"msg_0004","sessionID":"ses_demo0001","role":"user","time":{"created":1793354500000}}"#,
    )
    .unwrap();
    let c = make(opencode::ID, &home);
    c.restore_offsets(offs);
    let b = c.poll(Cursor(1)).await.unwrap();
    assert_eq!(b.items.len(), 1, "{:?}", b.items);
    assert_eq!(b.items[0].data["role"], "user");
    // Completing the in-flight assistant message emits its step and spend.
    std::fs::write(
        dir.join("msg_0003.json"),
        r#"{"id":"msg_0003","sessionID":"ses_demo0001","role":"assistant","time":{"created":1793354411000,"completed":1793354420000},"modelID":"claude-sonnet-4","tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.001}"#,
    )
    .unwrap();
    let b2 = c.poll(b.next).await.unwrap();
    assert_eq!(b2.items.len(), 2, "{:?}", b2.items);
}

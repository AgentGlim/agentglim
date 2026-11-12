//! Focused JSONL bounded-ingestion regressions (v2-r3).

mod common;

use agentglimd::adapters::{claude_code, opencode, MAX_BYTES_PER_PASS, MAX_FILES_PER_PASS};
use agentglimd::core::{Cursor, Detection, Env, RecordKey, Source};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::Duration;
use tempfile::TempDir;

fn mk_claude(home: &Path) {
    fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
}

fn claude_line(n: u64) -> String {
    format!(
        "{{\"type\":\"user\",\"timestamp\":1700000000000,\"sessionId\":\"s1\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"line {}\"}}]}}}}\n",
        n
    )
}

#[tokio::test]
async fn jsonl_12k_exact_drain_and_fairness() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    mk_claude(home);
    let a_path = home.join(".claude/projects/p/a.jsonl");
    let b_path = home.join(".claude/projects/p/b.jsonl");
    let mut fa = File::create(&a_path).unwrap();
    for i in 0..12000u64 {
        fa.write_all(claude_line(i).as_bytes()).unwrap();
    }
    fa.flush().unwrap();
    let mut fb = File::create(&b_path).unwrap();
    fb.write_all(b"{\"type\":\"user\",\"timestamp\":1700000000000,\"sessionId\":\"b-session\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"b\"}]}}\n").unwrap();
    fb.flush().unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let mut cursor = Cursor(0);
    let mut total = 0usize;
    let mut first_had_b = false;
    let mut passes = 0usize;
    loop {
        let b = src.poll(cursor).await.unwrap();
        if passes == 0 {
            first_had_b = b.items.iter().any(|i| i.session == "b-session");
        }
        total += b.items.len();
        cursor = b.next;
        passes += 1;
        if b.items.is_empty() {
            break;
        }
        if passes > 100 {
            panic!("too many passes");
        }
    }
    assert_eq!(total, 12003, "exact drain count");
    assert!(
        first_had_b,
        "competing file must progress before first backlog ends"
    );
}

#[tokio::test]
async fn jsonl_charged_byte_limit() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    mk_claude(home);
    let p = home.join(".claude/projects/p/big.jsonl");
    let mut f = File::create(&p).unwrap();
    for _ in 0..40000u64 {
        f.write_all(claude_line(1).as_bytes()).unwrap();
    }
    f.flush().unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(b.next.0 <= MAX_BYTES_PER_PASS, "charged {} > cap", b.next.0);
    assert!(!b.items.is_empty());
}

#[tokio::test]
async fn jsonl_visited_entry_limit() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    let dir = home.join(".claude/projects/p");
    fs::create_dir_all(&dir).unwrap();
    for i in 0..300u64 {
        let p = dir.join(format!("s{}.jsonl", i));
        let mut f = File::create(&p).unwrap();
        f.write_all(claude_line(i).as_bytes()).unwrap();
        f.flush().unwrap();
    }
    let src = claude_code::ClaudeCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    // One pass must not process every file when there are more than the cap.
    let unique_sessions: std::collections::BTreeSet<_> =
        b.items.iter().map(|i| i.session.clone()).collect();
    assert!(unique_sessions.len() <= MAX_FILES_PER_PASS);
    // Drain the rest.
    let mut cursor = b.next;
    let mut passes = 1usize;
    loop {
        let bb = src.poll(cursor).await.unwrap();
        if bb.items.is_empty() {
            break;
        }
        cursor = bb.next;
        passes += 1;
        if passes > 100 {
            panic!("too many passes");
        }
    }
}

#[tokio::test]
async fn jsonl_oversized_suffix_not_emitted() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    mk_claude(home);
    let p = home.join(".claude/projects/p/o.jsonl");
    let mut f = File::create(&p).unwrap();
    // oversized physical row: 300k spaces + valid JSON, must be discarded
    let payload = claude_line(777);
    let mut big = vec![b' '; 300_000];
    big.extend_from_slice(payload.trim_end_matches('\n').as_bytes());
    big.push(b'\n');
    f.write_all(&big).unwrap();
    f.write_all(claude_line(888).as_bytes()).unwrap();
    f.flush().unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let mut cursor = Cursor(0);
    let mut saw_fake = false;
    loop {
        let b = src.poll(cursor).await.unwrap();
        for it in &b.items {
            if let Some(ts) = it.data.get("ts") {
                let _ = ts;
            }
            if it.data.to_string().contains("777") {
                saw_fake = true;
            }
        }
        cursor = b.next;
        if b.items.is_empty() {
            break;
        }
    }
    assert!(!saw_fake, "oversized row suffix was emitted");
    // count Step items across the single pass is validated by no fake suffix
    assert!(!saw_fake, "oversized row suffix was emitted");
}

#[tokio::test]
async fn jsonl_discard_state_across_restart() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    mk_claude(home);
    let p = home.join(".claude/projects/p/d.jsonl");
    // First chunk: oversized row without newline (will be chunk-discarded)
    let mut f = File::create(&p).unwrap();
    let big = vec![b'x'; 300_000];
    f.write_all(&big).unwrap();
    f.flush().unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(b
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Error));
    let cp = src.checkpoint();

    // Append the rest of the oversized row + a good line.
    let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all(b"\n").unwrap();
    f.write_all(claude_line(5).as_bytes()).unwrap();
    f.flush().unwrap();

    // Restore into a new adapter; discard state must persist (no fake parse).
    let src2 = claude_code::ClaudeCode::new(None, home, 30);
    src2.restore_checkpoint(cp);
    let first = src2.poll(Cursor(1)).await.unwrap();
    let mut total = first.items.len();
    let mut cursor = first.next;
    loop {
        let bb = src2.poll(cursor).await.unwrap();
        total += bb.items.len();
        cursor = bb.next;
        if bb.items.is_empty() {
            break;
        }
    }
    // At least the good line's Step should appear; discard errors may also appear.
    assert!(total >= 1, "only good line after discard, got {}", total);
}

#[tokio::test]
async fn jsonl_malformed_matching_file_not_detected() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    let dir = home.join(".claude/projects/p");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("bad.jsonl"), "garbage\nnot json\n").unwrap();
    let src = claude_code::ClaudeCode::new(None, home, 30);
    let env = Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    };
    let det = src.detect(&env);
    assert!(matches!(det, Detection::NotDetected { .. }), "{:?}", det);
}

#[tokio::test]
async fn jsonl_empty_tree_not_detected() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    fs::create_dir_all(home.join(".claude/projects")).unwrap();
    let src = claude_code::ClaudeCode::new(None, home, 30);
    let env = Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    };
    let det = src.detect(&env);
    assert!(matches!(det, Detection::NotDetected { .. }), "{:?}", det);
}
#[tokio::test]
async fn jsonl_replacement_while_stopped_new_inode() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/r.jsonl");
    fs::write(&p, claude_line(1)).unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(!b.items.is_empty());
    let cp = src.checkpoint();

    // Replace with same-size content via a new inode.
    let tmp = home.join(".claude/projects/p/r.jsonl.new");
    fs::write(&tmp, claude_line(2)).unwrap();
    fs::rename(&tmp, &p).unwrap();

    let src2 = claude_code::ClaudeCode::new(None, home, 30);
    src2.restore_checkpoint(cp);
    let mut cursor = Cursor(1);
    let mut total = 0usize;
    loop {
        let bb = src2.poll(cursor).await.unwrap();
        total += bb.items.len();
        cursor = bb.next;
        if bb.items.is_empty() {
            break;
        }
    }
    assert!(
        total >= 2,
        "replacement content was not re-read (got {})",
        total
    );
}

#[tokio::test]
async fn jsonl_completed_sweep_removal_and_reappearance() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/z.jsonl");
    fs::write(&p, claude_line(9)).unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let _ = src.poll(Cursor(0)).await.unwrap();

    // Remove the file; wait for a completed rediscovery sweep.
    fs::remove_file(&p).unwrap();
    let mut offsets_empty = false;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(500));
        let _ = src.poll(Cursor(1)).await.unwrap();
        if src.offsets().is_empty() {
            offsets_empty = true;
            break;
        }
    }
    // Rediscovery interval is 15s; allow enough time.
    if !offsets_empty {
        std::thread::sleep(Duration::from_secs(16));
        let _ = src.poll(Cursor(1)).await.unwrap();
        offsets_empty = src.offsets().is_empty();
    }
    assert!(
        offsets_empty,
        "missing path was not removed after completed sweep"
    );

    // Reappearance should start fresh.
    fs::write(&p, claude_line(10)).unwrap();
    std::thread::sleep(Duration::from_secs(16));
    let b = src.poll(Cursor(1)).await.unwrap();
    assert!(!b.items.is_empty(), "reappeared file was not processed");
}

#[tokio::test]
async fn jsonl_opencode_replacement_while_stopped_new_inode() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    let dir = home.join(".local/share/opencode/storage/message/ses_demo0001");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(home.join(".local/share/opencode/storage/session/demo-app")).unwrap();
    fs::write(
        home.join(".local/share/opencode/storage/session/demo-app/ses_demo0001.json"),
        r#"{"id":"ses_demo0001","directory":"/work/demo-app","title":"t","version":"1.0.0","time":{"created":1793354400000}}"#,
    )
    .unwrap();
    let p = dir.join("msg_0001.json");
    fs::write(
        &p,
        r#"{"id":"msg_0001","sessionID":"ses_demo0001","role":"user","time":{"created":1793354401000}}"#,
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(!b.items.is_empty());
    let cp = src.checkpoint();

    // Replace with a new inode (same or different size).
    let tmp = dir.join("msg_0001.json.new");
    fs::write(
        &tmp,
        r#"{"id":"msg_0001","sessionID":"ses_demo0001","role":"user","time":{"created":1793354402000}}"#,
    )
    .unwrap();
    fs::rename(&tmp, &p).unwrap();

    let src2 = opencode::OpenCode::new(None, home, 30);
    src2.restore_checkpoint(cp);
    let mut cursor = Cursor(1);
    let mut total = 0usize;
    loop {
        let bb = src2.poll(cursor).await.unwrap();
        total += bb.items.len();
        cursor = bb.next;
        if bb.items.is_empty() {
            break;
        }
    }
    assert!(
        total >= 1,
        "replacement content was not re-read (got {})",
        total
    );
}

#[tokio::test]
async fn jsonl_opencode_persisted_state_round_trip() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    let dir = home.join(".local/share/opencode/storage/message/ses_demo0001");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(home.join(".local/share/opencode/storage/session/demo-app")).unwrap();
    fs::write(
        home.join(".local/share/opencode/storage/session/demo-app/ses_demo0001.json"),
        r#"{"id":"ses_demo0001","directory":"/work/demo-app","title":"t","version":"1.0.0","time":{"created":1793354400000}}"#,
    )
    .unwrap();
    let p = dir.join("msg_0001.json");
    fs::write(
        &p,
        r#"{"id":"msg_0001","sessionID":"ses_demo0001","role":"assistant","time":{"created":1793354401000,"completed":1793354410000},"modelID":"claude-sonnet-4","tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.001}"#,
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(!b.items.is_empty());
    let cp = src.checkpoint();

    // restore into a fresh adapter; poll should produce no duplicates
    let src2 = opencode::OpenCode::new(None, home, 30);
    src2.restore_checkpoint(cp.clone());
    let b2 = src2.poll(Cursor(1)).await.unwrap();
    assert!(
        b2.items.is_empty(),
        "restart re-emitted items: {:?}",
        b2.items
    );

    // checkpoint round-trips
    let cp2 = src2.checkpoint();
    assert_eq!(cp2, cp, "checkpoint did not round-trip");
}

#[tokio::test]
async fn jsonl_opencode_append_after_restart_no_new_header() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    let dir = home.join(".local/share/opencode/storage/message/ses_demo0001");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(home.join(".local/share/opencode/storage/session/demo-app")).unwrap();
    fs::write(
        home.join(".local/share/opencode/storage/session/demo-app/ses_demo0001.json"),
        r#"{"id":"ses_demo0001","directory":"/work/demo-app","title":"t","version":"1.0.0","time":{"created":1793354400000}}"#,
    )
    .unwrap();
    fs::write(
        dir.join("msg_0001.json"),
        r#"{"id":"msg_0001","sessionID":"ses_demo0001","role":"user","time":{"created":1793354401000}}"#,
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(!b.items.is_empty());
    let cp = src.checkpoint();

    // Append a new message file (no session header expected).
    fs::write(
        dir.join("msg_0002.json"),
        r#"{"id":"msg_0002","sessionID":"ses_demo0001","role":"assistant","time":{"created":1793354402000,"completed":1793354403000},"modelID":"claude-sonnet-4","tokens":{"input":1,"output":2,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.001}"#,
    )
    .unwrap();

    let src2 = opencode::OpenCode::new(None, home, 30);
    src2.restore_checkpoint(cp);
    let mut cursor = Cursor(1);
    let mut total = 0usize;
    let mut saw_session = false;
    loop {
        let bb = src2.poll(cursor).await.unwrap();
        for it in &bb.items {
            if it.kind == agentglimd::core::ItemKind::Session {
                saw_session = true;
            }
        }
        total += bb.items.len();
        cursor = bb.next;
        if bb.items.is_empty() {
            break;
        }
    }
    assert!(total >= 2, "appended message not processed (got {})", total);
    assert!(!saw_session, "session header re-emitted after restart");
}

#[tokio::test]
async fn jsonl_short_append_yields_one_step() {
    use agentglimd::adapters::claude_code::ClaudeCode;
    use std::io::Write;
    let t = TempDir::new().unwrap();
    let home = t.path();
    std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/a.jsonl");
    std::fs::write(&p, claude_line(1)).unwrap();

    let src = ClaudeCode::new(None, home, 30);
    let b1 = src.poll(Cursor(0)).await.unwrap();
    assert!(b1
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Session));
    assert_eq!(
        b1.items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
            .count(),
        1
    );

    // append second record to same inode
    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all(claude_line(2).as_bytes()).unwrap();
    f.flush().unwrap();

    let b2 = src.poll(b1.next).await.unwrap();
    assert_eq!(
        b2.items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Session)
            .count(),
        0,
        "session replayed on short append"
    );
    assert_eq!(
        b2.items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
            .count(),
        1,
        "expected exactly one new step, got {:?}",
        b2.items
    );
}

#[tokio::test]
async fn jsonl_short_append_after_restore() {
    use agentglimd::adapters::claude_code::ClaudeCode;
    use std::io::Write;
    let t = TempDir::new().unwrap();
    let home = t.path();
    std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/a.jsonl");
    std::fs::write(&p, claude_line(1)).unwrap();

    let src = ClaudeCode::new(None, home, 30);
    let _b1 = src.poll(Cursor(0)).await.unwrap();
    let cp = src.checkpoint();

    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all(claude_line(2).as_bytes()).unwrap();
    f.flush().unwrap();

    let src2 = ClaudeCode::new(None, home, 30);
    src2.restore_checkpoint(cp);
    let mut total_steps = 0usize;
    let mut total_sessions = 0usize;
    let mut cursor = Cursor(1);
    loop {
        let bb = src2.poll(cursor).await.unwrap();
        total_steps += bb
            .items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
            .count();
        total_sessions += bb
            .items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Session)
            .count();
        cursor = bb.next;
        if bb.items.is_empty() {
            break;
        }
    }
    assert_eq!(total_sessions, 0, "session replayed after restore");
    assert_eq!(
        total_steps, 1,
        "expected one new step after restore, got {}",
        total_steps
    );
}

#[tokio::test]
async fn jsonl_append_growth_beyond_256() {
    use agentglimd::adapters::claude_code::ClaudeCode;
    use std::io::Write;
    let t = TempDir::new().unwrap();
    let home = t.path();
    std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/a.jsonl");
    // initial short file (< 256 bytes)
    let line1 = "{\"type\":\"user\",\"timestamp\":1700000000000,\"sessionId\":\"s1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n";
    std::fs::write(&p, line1).unwrap();
    assert!(line1.len() < 256);

    let src = ClaudeCode::new(None, home, 30);
    let b1 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        b1.items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
            .count(),
        1
    );

    // append enough to push total beyond 256 bytes
    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    for _ in 0..5 {
        f.write_all(claude_line(2).as_bytes()).unwrap();
    }
    f.flush().unwrap();

    let b2 = src.poll(b1.next).await.unwrap();
    assert_eq!(
        b2.items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Session)
            .count(),
        0
    );
    // exactly the 5 new steps
    assert_eq!(
        b2.items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
            .count(),
        5,
        "got {:?}",
        b2.items
    );
}

#[tokio::test]
async fn jsonl_identities_match_emitted_items() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/a.jsonl");
    std::fs::write(&p, format!("{}{}", claude_line(1), claude_line(2))).unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let b = src.poll(Cursor(0)).await.unwrap();
    assert!(!b.items.is_empty());
    assert_eq!(
        src.identities().len(),
        b.items.len(),
        "one identity per emitted item"
    );
    for k in src.identities() {
        match k {
            RecordKey::Offset { .. } => {}
            _ => panic!("expected offset identity"),
        }
    }
}

#[tokio::test]
async fn jsonl_identical_lines_distinct_offsets_retained() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/a.jsonl");
    let line = claude_line(7);
    std::fs::write(&p, format!("{}{}", line, line)).unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let mut cursor = Cursor(0);
    let mut total_steps = 0usize;
    loop {
        let b = src.poll(cursor).await.unwrap();
        total_steps += b
            .items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
            .count();
        cursor = b.next;
        if b.items.is_empty() {
            break;
        }
    }
    assert_eq!(total_steps, 2, "two identical lines must yield two steps");

    // positions distinct
    // after full drain identities reflects last (empty) poll; check via a fresh poll? Instead check count of positions
    // Re-poll from 0 on a fresh adapter to inspect identities.
    let src2 = claude_code::ClaudeCode::new(None, home, 30);
    let _ = src2.poll(Cursor(0)).await.unwrap();
    let ids2 = src2.identities();
    let mut positions: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    for k in ids2 {
        if let RecordKey::Offset { position, .. } = k {
            positions.insert(position);
        }
    }
    assert!(
        positions.len() >= 2,
        "distinct offsets required, got {:?}",
        positions
    );
}

#[tokio::test]
async fn jsonl_mtime_only_change_emits_nothing() {
    let t = TempDir::new().unwrap();
    let home = t.path();
    std::fs::create_dir_all(home.join(".claude/projects/p")).unwrap();
    let p = home.join(".claude/projects/p/a.jsonl");
    // grown beyond 256 bytes
    let mut content = String::new();
    for i in 0..20u64 {
        content.push_str(&claude_line(i));
    }
    assert!(content.len() > 256);
    std::fs::write(&p, &content).unwrap();

    let src = claude_code::ClaudeCode::new(None, home, 30);
    let b1 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b1.items.is_empty());
    let cp = src.checkpoint();

    // touch mtime only, same inode
    let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
    let times = std::fs::FileTimes::new()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(10));
    f.set_times(times).unwrap();
    drop(f);

    // live
    let b2 = src.poll(b1.next).await.unwrap();
    assert!(b2.items.is_empty(), "touch must not emit: {:?}", b2.items);

    // restored
    let src2 = claude_code::ClaudeCode::new(None, home, 30);
    src2.restore_checkpoint(cp);
    let mut total = 0usize;
    let mut cursor = Cursor(1);
    loop {
        let bb = src2.poll(cursor).await.unwrap();
        total += bb.items.len();
        cursor = bb.next;
        if bb.items.is_empty() {
            break;
        }
    }
    assert_eq!(total, 0, "restored touch must not emit");
}

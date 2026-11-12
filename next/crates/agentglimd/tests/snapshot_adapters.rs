use agentglimd::adapters::{opencode, plans_harness, MAX_BYTES_PER_PASS, MAX_FILES_PER_PASS};
use agentglimd::core::{Cursor, Detection, Env, Source};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

fn ph_home(n: usize) -> (TempDir, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    for i in 0..n {
        let rdir = home
            .join("projects/dev/plans")
            .join(format!("p{i:03}"))
            .join("_build")
            .join("r1");
        fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
        fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();
        fs::write(rdir.join("workers/alpha/REPORT.md"), "done").unwrap();
        fs::write(rdir.join("BUILD-LOG.md"), "a\nb\nc\n").unwrap();
    }
    (t, home)
}

fn oc_home() -> (TempDir, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = home.join(".local/share/opencode/storage");
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    fs::write(
        base.join("message/ses1/m1.json"),
        r#"{"id":"m1","sessionID":"ses1","role":"user","time":{"created":101}}"#,
    )
    .unwrap();
    (t, home)
}

#[tokio::test]
async fn snapshot_plans_harness_detection_empty_malformed() {
    // empty home
    let t = tempfile::tempdir().unwrap();
    let env = Env {
        home: t.path().to_path_buf(),
        vars: Default::default(),
    };
    let src = plans_harness::PlansHarness::new(None, t.path(), 30);
    match src.detect(&env) {
        Detection::NotDetected { reason } => assert!(reason.contains("not found")),
        d => panic!("expected not detected, got {d:?}"),
    }

    // malformed: root exists but no plan/_build
    let home = t.path().join("home2");
    fs::create_dir_all(home.join("projects/dev/plans/junk")).unwrap();
    let env2 = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    let src2 = plans_harness::PlansHarness::new(None, &home, 30);
    match src2.detect(&env2) {
        Detection::NotDetected { reason } => assert!(reason.contains("not found")),
        d => panic!("expected not detected, got {d:?}"),
    }

    // empty _build directory
    let home3 = t.path().join("home3");
    fs::create_dir_all(home3.join("projects/dev/plans/p/_build")).unwrap();
    let env3 = Env {
        home: home3.clone(),
        vars: Default::default(),
    };
    let src3 = plans_harness::PlansHarness::new(None, &home3, 30);
    match src3.detect(&env3) {
        Detection::NotDetected { reason } => assert!(reason.contains("not found")),
        d => panic!("expected not detected, got {d:?}"),
    }
}

#[tokio::test]
async fn snapshot_opencode_detection_empty_sqlite_unrecognized() {
    // empty home
    let t = tempfile::tempdir().unwrap();
    let env = Env {
        home: t.path().to_path_buf(),
        vars: Default::default(),
    };
    let src = opencode::OpenCode::new(None, t.path(), 30);
    match src.detect(&env) {
        Detection::NotDetected { reason } => assert!(reason.contains("not found")),
        d => panic!("expected not detected, got {d:?}"),
    }

    // empty storage dir + sqlite db
    let home = t.path().join("home2");
    let storage = home.join(".local/share/opencode/storage");
    fs::create_dir_all(&storage).unwrap();
    fs::write(home.join(".local/share/opencode/opencode.db"), "").unwrap();
    let env2 = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    let src2 = opencode::OpenCode::new(None, &home, 30);
    match src2.detect(&env2) {
        Detection::NotDetected { reason } => assert!(reason.contains("SQLite")),
        d => panic!("expected sqlite not supported, got {d:?}"),
    }

    // unrecognized storage layout
    let home3 = t.path().join("home3");
    let storage3 = home3.join(".local/share/opencode/storage");
    fs::create_dir_all(&storage3).unwrap();
    fs::write(storage3.join("random.txt"), "x").unwrap();
    let env3 = Env {
        home: home3.clone(),
        vars: Default::default(),
    };
    let src3 = opencode::OpenCode::new(None, &home3, 30);
    match src3.detect(&env3) {
        Detection::NotDetected { reason } => assert!(reason.contains("not found")),
        d => panic!("expected not detected, got {d:?}"),
    }

    // empty session/ and message/ dirs
    let home4 = t.path().join("home4");
    fs::create_dir_all(home4.join(".local/share/opencode/storage/session/proj")).unwrap();
    fs::create_dir_all(home4.join(".local/share/opencode/storage/message/ses1")).unwrap();
    let env4 = Env {
        home: home4.clone(),
        vars: Default::default(),
    };
    let src4 = opencode::OpenCode::new(None, &home4, 30);
    match src4.detect(&env4) {
        Detection::NotDetected { reason } => assert!(reason.contains("empty")),
        d => panic!("expected empty not detected, got {d:?}"),
    }
}

#[tokio::test]
async fn snapshot_plans_harness_many_rounds_drain() {
    let (_t, home) = ph_home(250);
    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let mut cursor = Cursor(0);
    let mut total_runs = 0usize;
    let mut polls = 0usize;
    while polls < 20 {
        let b = src.poll(cursor).await.unwrap();
        total_runs += b
            .items
            .iter()
            .filter(|i| i.kind == agentglimd::core::ItemKind::Run)
            .count();
        cursor = b.next;
        polls += 1;
        if b.items.is_empty() {
            break;
        }
        assert!(b.items.len() <= MAX_FILES_PER_PASS + 5);
    }
    assert_eq!(total_runs, 250);
}

#[tokio::test]
async fn snapshot_plans_harness_append_and_revisions() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();
    fs::write(rdir.join("BUILD-LOG.md"), "v1\n").unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty());

    // change
    fs::write(rdir.join("BUILD-LOG.md"), "v1\nv2\n").unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Run));

    // revert to original content (new mtime)
    std::thread::sleep(Duration::from_millis(10));
    fs::write(rdir.join("BUILD-LOG.md"), "v1\n").unwrap();
    let b2 = src.poll(b1.next).await.unwrap();
    assert!(b2
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Run));
}

#[tokio::test]
async fn snapshot_plans_harness_unchanged_not_reread() {
    let (_t, home) = ph_home(3);
    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "unchanged should not emit: {:?}",
        b1.items
    );
}

#[tokio::test]
async fn snapshot_plans_harness_old_history_skipped_new_ingested() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();
    let log = rdir.join("BUILD-LOG.md");
    fs::write(&log, "old\n").unwrap();
    // make it old
    let f = fs::OpenOptions::new().write(true).open(&log).unwrap();
    let times =
        fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(10 * 86400));
    f.set_times(times).unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 1);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    // old history skipped: no run item for this round
    assert!(
        b0.items.is_empty(),
        "old history should be skipped: {:?}",
        b0.items
    );

    // newer change
    std::thread::sleep(Duration::from_millis(10));
    fs::write(&log, "old\nnew\n").unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Run));
}

#[tokio::test]
async fn snapshot_plans_harness_restart_restore() {
    let (_t, home) = ph_home(2);
    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty());
    let offs = src.offsets();
    // unchanged restore should not reread
    let src2 = plans_harness::PlansHarness::new(None, &home, 30);
    src2.restore_offsets(offs);
    let b1 = src2.poll(Cursor(b0.next.0.max(1))).await.unwrap();
    assert!(b1.items.is_empty(), "restore reread: {:?}", b1.items);
}

#[tokio::test]
async fn snapshot_opencode_many_files_drain() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = home.join(".local/share/opencode/storage");
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    for i in 0..250 {
        fs::write(
            base.join("message/ses1").join(format!("m{i:03}.json")),
            format!(
                r#"{{"id":"m{i:03}","sessionID":"ses1","role":"user","time":{{"created":{}}}}}"#,
                200 + i
            ),
        )
        .unwrap();
    }
    let src = opencode::OpenCode::new(None, &home, 30);
    let mut cursor = Cursor(0);
    let mut total_steps = 0usize;
    let mut polls = 0usize;
    while polls < 50 {
        let b = src.poll(cursor).await.unwrap();
        total_steps += b.items.len();
        cursor = b.next;
        polls += 1;
        if b.items.is_empty() {
            break;
        }
    }
    assert!(total_steps >= 250);
}

#[tokio::test]
async fn snapshot_opencode_unchanged_not_reread() {
    let (_t, home) = oc_home();
    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1.items.is_empty(), "unchanged reread: {:?}", b1.items);
}

#[tokio::test]
async fn snapshot_opencode_restore_and_new_message() {
    let (_t, home) = oc_home();
    let src = opencode::OpenCode::new(None, &home, 30);
    src.poll(Cursor(0)).await.unwrap();
    let offs = src.offsets();
    let dir = home.join(".local/share/opencode/storage/message/ses_demo0001");
    // ensure dir exists
    let _ = fs::create_dir_all(&dir);
    // add new message
    let dir2 = home.join(".local/share/opencode/storage/message/ses1");
    fs::write(
        dir2.join("m_new.json"),
        r#"{"id":"m_new","sessionID":"ses1","role":"user","time":{"created":999}}"#,
    )
    .unwrap();
    let src2 = opencode::OpenCode::new(None, &home, 30);
    src2.restore_offsets(offs);
    let b = src2.poll(Cursor(1)).await.unwrap();
    assert!(b
        .items
        .iter()
        .any(|i| i.data.get("role") == Some(&serde_json::json!("user"))));
}

#[tokio::test]
async fn snapshot_opencode_sqlite_detection() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let storage = home.join(".local/share/opencode/storage");
    fs::create_dir_all(&storage).unwrap();
    fs::write(home.join(".local/share/opencode/opencode.db"), "").unwrap();
    let src = opencode::OpenCode::new(None, &home, 30);
    let env = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    match src.detect(&env) {
        Detection::NotDetected { reason } => assert!(reason.contains("SQLite")),
        d => panic!("expected sqlite, got {d:?}"),
    }
}

#[tokio::test]
async fn snapshot_bounds_constants() {
    const { assert!(MAX_BYTES_PER_PASS > 0) };
    const { assert!(MAX_FILES_PER_PASS > 0) };
}

// ===== NEW TESTS FOR SNAPSHOT RECOVERY =====

#[tokio::test]
async fn snapshot_plans_harness_6mb_log_drains_to_eof() {
    // Test that a 6,000,000-byte harness log drains to EOF unchanged
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();

    // Create a 6MB log file (each line ~10 bytes, so ~600,000 lines)
    let line = "x\n".repeat(1000); // 2000 bytes per chunk
    let mut log_content = String::new();
    for _ in 0..3000 {
        log_content.push_str(&line);
    }
    assert!(log_content.len() >= 6_000_000);
    fs::write(rdir.join("BUILD-LOG.md"), log_content).unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let mut cursor = Cursor(0);
    let mut total_lines = 0usize;
    let mut polls = 0usize;
    while polls < 50 {
        let b = src.poll(cursor).await.unwrap();
        for item in &b.items {
            if item.kind == agentglimd::core::ItemKind::Run {
                if let Some(lines) = item.data.get("build_log_lines").and_then(|v| v.as_u64()) {
                    total_lines = lines as usize;
                }
            }
        }
        cursor = b.next;
        polls += 1;
        if b.items.is_empty() {
            break;
        }
    }
    // Should have read all lines
    assert!(
        total_lines >= 600_000,
        "Expected ~600k lines, got {}",
        total_lines
    );

    // Second poll should return nothing (fully consumed)
    let b2 = src.poll(cursor).await.unwrap();
    assert!(
        b2.items.is_empty(),
        "Second poll should be empty: {:?}",
        b2.items
    );
}

#[tokio::test]
async fn snapshot_plans_harness_append_reads_suffix_only() {
    // Test that append reads only the suffix, not the whole file
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();

    // Initial log: 1000 lines
    let initial_log = "line\n".repeat(1000);
    fs::write(rdir.join("BUILD-LOG.md"), &initial_log).unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty());
    let offs0 = src.offsets();

    // Append 10 more lines
    let append_log = initial_log + &"append\n".repeat(10);
    fs::write(rdir.join("BUILD-LOG.md"), &append_log).unwrap();

    let b1 = src.poll(b0.next).await.unwrap();
    // Should only see the 10 new lines worth of change
    let run_item = b1
        .items
        .iter()
        .find(|i| i.kind == agentglimd::core::ItemKind::Run);
    assert!(run_item.is_some(), "Should emit Run for append");

    // Check offset advanced by ~60 bytes (10 lines * 6 bytes), not full file
    let offs1 = src.offsets();
    let offset0 = offs0
        .iter()
        .find(|o| o.path.contains("BUILD-LOG.md"))
        .map(|o| o.offset)
        .unwrap_or(0);
    let offset1 = offs1
        .iter()
        .find(|o| o.path.contains("BUILD-LOG.md"))
        .map(|o| o.offset)
        .unwrap_or(0);
    let consumed = offset1.saturating_sub(offset0);
    // 10 lines * 6 bytes = 60 bytes, plus some overhead
    assert!(
        consumed < 200,
        "Append should only consume ~60 bytes, got {}",
        consumed
    );
}

#[tokio::test]
async fn snapshot_plans_harness_worker_done_creation_removal_while_stopped() {
    // Test that worker DONE creation/removal while stopped is observed on restart
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    // No DONE file initially
    fs::write(rdir.join("BUILD-LOG.md"), "start\n").unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty());
    let cp = src.checkpoint();

    // Simulate stopped: create DONE file
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();

    // Restore and poll
    let src2 = plans_harness::PlansHarness::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    let b1 = src2.poll(Cursor(b0.next.0.max(1))).await.unwrap();

    // Should detect worker done change
    let child_items: Vec<_> = b1
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Child)
        .collect();
    assert!(
        !child_items.is_empty(),
        "Should detect worker DONE creation: {:?}",
        b1.items
    );

    // Now remove DONE file while stopped again
    fs::remove_file(rdir.join("workers/alpha/DONE")).unwrap();
    let cp2 = src2.checkpoint();
    let src3 = plans_harness::PlansHarness::new(None, &home, 30);
    src3.restore_checkpoint(cp2);
    let b2 = src3.poll(Cursor(b1.next.0.max(1))).await.unwrap();

    let child_items2: Vec<_> = b2
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Child)
        .collect();
    assert!(
        !child_items2.is_empty(),
        "Should detect worker DONE removal: {:?}",
        b2.items
    );
}

#[tokio::test]
async fn snapshot_opencode_same_size_replacement_while_stopped() {
    // Test that same-size OpenCode replacement while stopped is observed
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = home.join(".local/share/opencode/storage");
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    // Initial message A
    fs::write(
        base.join("message/ses1/m1.json"),
        r#"{"id":"m1","sessionID":"ses1","role":"user","time":{"created":101}}"#,
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty());
    let cp = src.checkpoint();

    // Simulate stopped: replace message with same-size but different content
    std::thread::sleep(Duration::from_millis(10)); // ensure mtime changes
    fs::write(
        base.join("message/ses1/m1.json"),
        r#"{"id":"m1","sessionID":"ses1","role":"assistant","time":{"created":101,"completed":102}}"#,
    )
    .unwrap();

    // Restore and poll
    let src2 = opencode::OpenCode::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    let b1 = src2.poll(Cursor(b0.next.0.max(1))).await.unwrap();

    // Should detect the change (role changed from user to assistant with completed)
    let step_items: Vec<_> = b1
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
        .collect();
    assert!(
        !step_items.is_empty(),
        "Should detect same-size replacement: {:?}",
        b1.items
    );
}

#[tokio::test]
async fn snapshot_plans_harness_a_b_a_across_restart() {
    // Test snapshot A→B→A across restart with exact replay identity
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();

    // State A
    fs::write(rdir.join("BUILD-LOG.md"), "A\n").unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let cp0 = src.checkpoint();

    // State B
    std::thread::sleep(Duration::from_millis(10));
    fs::write(rdir.join("BUILD-LOG.md"), "B\n").unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    let cp1 = src.checkpoint();

    // State A again (revert)
    std::thread::sleep(Duration::from_millis(10));
    fs::write(rdir.join("BUILD-LOG.md"), "A\n").unwrap();
    let _b2 = src.poll(b1.next).await.unwrap();
    let cp2 = src.checkpoint();

    // Now restore from cp0 (state A), then cp1 (state B), then cp2 (state A)
    // Each should emit exactly one Run event

    // Restore cp0
    let src_a1 = plans_harness::PlansHarness::new(None, &home, 30);
    src_a1.restore_checkpoint(cp0);
    let ba1 = src_a1.poll(Cursor(1)).await.unwrap();
    let run_count_a1 = ba1
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Run)
        .count();
    assert_eq!(run_count_a1, 0, "Restore A should not emit (already at A)");

    // Restore cp1 (state B)
    let src_b = plans_harness::PlansHarness::new(None, &home, 30);
    src_b.restore_checkpoint(cp1);
    let bb = src_b.poll(Cursor(1)).await.unwrap();
    let run_count_b = bb
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Run)
        .count();
    assert_eq!(run_count_b, 1, "Restore B should emit one Run");

    // Restore cp2 (state A again)
    let src_a2 = plans_harness::PlansHarness::new(None, &home, 30);
    src_a2.restore_checkpoint(cp2);
    let ba2 = src_a2.poll(Cursor(1)).await.unwrap();
    let run_count_a2 = ba2
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Run)
        .count();
    // Committed unchanged restore is silent: cp2 is the latest committed state (A), and nothing
    // changed after it was taken, so restoring it must emit 0 (r1 audit B4; see
    // tests/harness_recovery.rs::harness_true_a_b_a_transitions_appear_exactly_once for the
    // genuine A→B→A transition case).
    assert_eq!(
        run_count_a2, 0,
        "Restore of the latest committed A checkpoint must be silent"
    );
}

#[tokio::test]
async fn snapshot_aggregate_read_budget_and_oversized_document() {
    // Test aggregate read budget enforcement and oversized document handling
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = home.join(".local/share/opencode/storage");
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();

    // Create a file larger than MAX_BYTES_PER_PASS (4MB)
    let large_content = "x".repeat(5 * 1024 * 1024); // 5MB
    let large_doc = format!(
        r#"{{"id":"large","sessionID":"ses1","role":"user","time":{{"created":200}},"content":"{}"}}"#,
        large_content
    );
    fs::write(base.join("message/ses1/large.json"), large_doc).unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();

    // Should emit an error for oversized file, not crash
    let errors: Vec<_> = b0
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Error)
        .collect();
    assert!(
        !errors.is_empty(),
        "Should emit error for oversized document"
    );

    // Other files should still be processed in subsequent polls
    let small_doc = r#"{"id":"small","sessionID":"ses1","role":"user","time":{"created":201}}"#;
    fs::write(base.join("message/ses1/small.json"), small_doc).unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    let steps: Vec<_> = b1
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Step)
        .collect();
    assert!(
        !steps.is_empty(),
        "Should still process small files after oversized"
    );
}

#[tokio::test]
async fn snapshot_many_unchanged_with_late_changed_entry() {
    // Test many unchanged entries with eventual late changed entry
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();

    // Create log with many unchanged lines
    let log_content = "unchanged\n".repeat(1000);
    fs::write(rdir.join("BUILD-LOG.md"), &log_content).unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty());

    // Poll again - should be empty (all unchanged)
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "Unchanged should not emit: {:?}",
        b1.items
    );

    // Now add a late changed entry
    std::thread::sleep(Duration::from_millis(10));
    let new_log = log_content + "changed\n";
    fs::write(rdir.join("BUILD-LOG.md"), &new_log).unwrap();

    let b2 = src.poll(b1.next).await.unwrap();
    let run_items: Vec<_> = b2
        .items
        .iter()
        .filter(|i| i.kind == agentglimd::core::ItemKind::Run)
        .collect();
    assert!(
        !run_items.is_empty(),
        "Should detect late change: {:?}",
        b2.items
    );
}

#[tokio::test]
async fn snapshot_source_preservation_hashes_names_mtimes() {
    // Test that source-preservation hashes/names/mtimes are maintained
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let rdir = home
        .join("projects/dev/plans")
        .join("p")
        .join("_build")
        .join("r1");
    fs::create_dir_all(rdir.join("workers/alpha")).unwrap();
    fs::write(rdir.join("workers/alpha/DONE"), "").unwrap();
    fs::write(rdir.join("BUILD-LOG.md"), "test\n").unwrap();

    let src = plans_harness::PlansHarness::new(None, &home, 30);
    let _b0 = src.poll(Cursor(0)).await.unwrap();
    let cp = src.checkpoint();

    // Check checkpoint contains proper metadata
    assert!(!cp.files.is_empty(), "Checkpoint should have files");
    for fc in &cp.files {
        if fc.path.contains("BUILD-LOG.md") {
            assert!(fc.generation > 0, "Should have generation");
            assert!(!fc.fingerprint.is_empty(), "Should have fingerprint");
            assert!(fc.mtime_ms > 0, "Should have mtime");
            assert!(fc.revision.is_some(), "Should have revision");
        }
    }

    // Restore and verify metadata preserved
    let src2 = plans_harness::PlansHarness::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    let b1 = src2.poll(Cursor(1)).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "Restored state should not reread unchanged: {:?}",
        b1.items
    );
}

#[tokio::test]
async fn snapshot_opencode_checkpoint_persists_fingerprint_generation_revision() {
    // Test that OpenCode checkpoint persists fingerprints, generations, and revisions
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = home.join(".local/share/opencode/storage");
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    fs::write(
        base.join("message/ses1/m1.json"),
        r#"{"id":"m1","sessionID":"ses1","role":"user","time":{"created":101}}"#,
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let _b0 = src.poll(Cursor(0)).await.unwrap();
    let cp = src.checkpoint();

    // Check checkpoint contains proper metadata
    assert!(!cp.files.is_empty(), "Checkpoint should have files");
    for fc in &cp.files {
        if fc.path.contains("m1.json") {
            assert!(!fc.fingerprint.is_empty(), "Should have fingerprint");
            assert!(fc.generation > 0, "Should have generation");
            assert!(fc.revision.is_some(), "Should have revision");
            assert!(fc.mtime_ms > 0, "Should have mtime");
        }
    }

    // Restore and verify
    let src2 = opencode::OpenCode::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    let b1 = src2.poll(Cursor(1)).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "Restored state should not reread unchanged: {:?}",
        b1.items
    );
}

// ===== OpenCode bounded-drain and revision recovery (v3-r2) =====

use agentglimd::core::{Batch, ItemKind};

/// Poll until a call returns no items, at most `max_polls` calls.
async fn poll_batches(src: &dyn Source, mut cursor: Cursor, max_polls: usize) -> Vec<Batch> {
    let mut out = Vec::new();
    for _ in 0..max_polls {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        let empty = b.items.is_empty();
        out.push(b);
        if empty {
            break;
        }
    }
    out
}

fn steps_of(batches: &[Batch]) -> Vec<u64> {
    batches
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| i.kind == ItemKind::Step)
        .filter_map(|i| i.data.get("ts").and_then(|v| v.as_u64()))
        .collect()
}

fn spend_inputs(batches: &[Batch]) -> Vec<u64> {
    batches
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| i.kind == ItemKind::Spend)
        .filter_map(|i| i.data.get("input_tokens").and_then(|v| v.as_u64()))
        .collect()
}

fn error_files(batches: &[Batch]) -> Vec<String> {
    batches
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| i.kind == ItemKind::Error)
        .filter_map(|i| {
            i.data
                .get("file")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect()
}

fn oc_root(home: &std::path::Path) -> PathBuf {
    home.join(".local/share/opencode/storage")
}

fn write_session(base: &std::path::Path) {
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
}

fn user_msg(ts: u64) -> String {
    format!(r#"{{"id":"m{ts}","sessionID":"ses1","role":"user","time":{{"created":{ts}}}}}"#)
}

/// A completed assistant document whose only difference between `input` values is one digit after
/// more than 400 bytes of padding: same inode, same size, same mtime, changed beyond the short
/// prefix.
fn padded_assistant_doc(input: u64) -> String {
    let padding = "p".repeat(400);
    format!(
        r#"{{"path":{{"padding":"{padding}"}},"id":"m1","sessionID":"ses1","role":"assistant","time":{{"created":100,"completed":101}},"modelID":"m","tokens":{{"input":{input},"output":1,"reasoning":0,"cache":{{"read":0,"write":0}}}},"cost":0.1}}"#
    )
}

fn set_modified(p: &std::path::Path, t: SystemTime) {
    let f = fs::OpenOptions::new().write(true).open(p).unwrap();
    f.set_times(fs::FileTimes::new().set_modified(t)).unwrap();
}

#[tokio::test]
async fn snapshot_opencode_same_inode_same_size_beyond_prefix_live_and_restored() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let msg = base.join("message/ses1/m1.json");
    let first = padded_assistant_doc(1);
    let second = padded_assistant_doc(2);
    assert_eq!(first.len(), second.len(), "mutation must keep the size");
    assert!(first.len() > 400);
    fs::write(&msg, &first).unwrap();
    let m = fs::metadata(&msg).unwrap();
    let (size, mtime) = (m.len(), m.modified().unwrap());
    #[cfg(unix)]
    let ino = {
        use std::os::unix::fs::MetadataExt;
        m.ino()
    };

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        spend_inputs(std::slice::from_ref(&b0)),
        vec![1],
        "{:?}",
        b0.items
    );
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1.items.is_empty(), "unchanged reread: {:?}", b1.items);

    // Live: rewrite the same inode in place, keep size *and* mtime identical.
    fs::write(&msg, &second).unwrap();
    set_modified(&msg, mtime);
    let m2 = fs::metadata(&msg).unwrap();
    assert_eq!(m2.len(), size);
    assert_eq!(m2.modified().unwrap(), mtime);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(m2.ino(), ino, "rewrite must stay on the same inode");
    }

    let live = poll_batches(&src, b1.next, 5).await;
    assert_eq!(
        spend_inputs(&live),
        vec![2],
        "same-size suffix revision was not emitted once: {:?}",
        live.iter().map(|b| b.items.len()).collect::<Vec<_>>()
    );
    let quiet = src.poll(live.last().unwrap().next).await.unwrap();
    assert!(
        quiet.items.is_empty(),
        "revision repeated: {:?}",
        quiet.items
    );

    // Downtime: restore the checkpoint taken at input=2 after reverting to input=1 with the same
    // inode, size and mtime.
    let cp = src.checkpoint();
    fs::write(&msg, &first).unwrap();
    set_modified(&msg, mtime);

    let src2 = opencode::OpenCode::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    let downtime = poll_batches(&src2, Cursor(1), 5).await;
    assert_eq!(
        spend_inputs(&downtime),
        vec![1],
        "changed downtime content was not emitted once: {:?}",
        downtime.iter().map(|b| b.items.len()).collect::<Vec<_>>()
    );
    let quiet2 = src2.poll(downtime.last().unwrap().next).await.unwrap();
    assert!(
        quiet2.items.is_empty(),
        "downtime revision repeated: {:?}",
        quiet2.items
    );

    // An unchanged restored checkpoint stays silent.
    let src3 = opencode::OpenCode::new(None, &home, 30);
    src3.restore_checkpoint(src2.checkpoint());
    let silent = poll_batches(&src3, Cursor(1), 5).await;
    assert!(
        silent.iter().all(|b| b.items.is_empty()),
        "unchanged restored checkpoint re-emitted: {:?}",
        silent.iter().map(|b| b.items.len()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn snapshot_opencode_restart_mid_drain_unique_complete() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    for i in 0..260u64 {
        fs::write(
            base.join("message/ses1").join(format!("m{i:03}.json")),
            user_msg(1000 + i),
        )
        .unwrap();
    }

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert!(!b0.items.is_empty(), "first call drained nothing");
    assert!(
        b0.items.len() <= 2 * MAX_FILES_PER_PASS,
        "one call emitted {} items, above the visit bound",
        b0.items.len()
    );
    let first_steps = steps_of(std::slice::from_ref(&b0));
    assert!(first_steps.len() < 260, "drain did not stop mid-way");

    // Restart mid-drain: a fresh adapter restored from the checkpoint continues where it stopped.
    let cp = src.checkpoint();
    let src2 = opencode::OpenCode::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    // A bounded discovery sweep may need more than one call before the remaining files are known,
    // so a call can legitimately return nothing while the sweep continues. Drain to two
    // consecutive empty calls and require every observation.
    let mut cursor = b0.next;
    let mut batches = vec![b0];
    let mut empty_streak = 0usize;
    for _ in 0..40 {
        let b = src2.poll(cursor).await.unwrap();
        cursor = b.next;
        if b.items.is_empty() {
            empty_streak += 1;
        } else {
            empty_streak = 0;
        }
        batches.push(b);
        if empty_streak >= 2 {
            break;
        }
    }
    let ts = steps_of(&batches);
    let unique: std::collections::BTreeSet<u64> = ts.iter().copied().collect();
    assert_eq!(ts.len(), 260, "step observations: {}", ts.len());
    assert_eq!(
        unique.len(),
        260,
        "duplicate step observations after restart"
    );
    let sessions = batches
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| i.kind == ItemKind::Session)
        .count();
    assert_eq!(sessions, 1, "session re-announced after restart");
    assert!(batches
        .iter()
        .all(|b| b.items.len() <= 2 * MAX_FILES_PER_PASS));

    // A further poll from the last cursor emits nothing.
    let quiet = src2.poll(batches.last().unwrap().next).await.unwrap();
    assert!(quiet.items.is_empty(), "repeated: {:?}", quiet.items);
}

#[tokio::test]
async fn snapshot_opencode_aggregate_over_budget_bounded_calls() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    let dir = base.join("message/ses1");
    fs::create_dir_all(&dir).unwrap();

    // 26 documents of ~200 KiB each: an aggregate backlog well above MAX_BYTES_PER_PASS.
    let blob = "x".repeat(200 * 1024);
    for i in 0..26u64 {
        fs::write(
            dir.join(format!("big{i:02}.json")),
            format!(
                r#"{{"id":"big{i:02}","sessionID":"ses1","role":"user","time":{{"created":{}}},"blob":"{blob}"}}"#,
                5000 + i
            ),
        )
        .unwrap();
    }
    let doc_bytes = fs::metadata(dir.join("big00.json")).unwrap().len();
    assert!(doc_bytes * 26 > MAX_BYTES_PER_PASS);

    // A call may only read what the per-call budget allows: one document costs its sample plus its
    // payload, so at most MAX_BYTES_PER_PASS / doc_bytes documents can be emitted per call.
    let per_call = (MAX_BYTES_PER_PASS / doc_bytes) as usize;
    assert!(per_call >= 1);

    let src = opencode::OpenCode::new(None, &home, 30);
    let batches = poll_batches(&src, Cursor(0), 20).await;
    assert!(batches.len() > 1, "aggregate backlog drained in one call");
    for b in &batches {
        let steps = b.items.iter().filter(|i| i.kind == ItemKind::Step).count();
        assert!(
            steps <= per_call,
            "call emitted {steps} steps, above the {per_call} its byte budget allows"
        );
    }
    let ts = steps_of(&batches);
    assert_eq!(ts.len(), 26, "observations: {}", ts.len());
    let unique: std::collections::BTreeSet<u64> = ts.iter().copied().collect();
    assert_eq!(unique.len(), 26, "duplicate observations across calls");
}

#[tokio::test]
async fn snapshot_opencode_oversized_diagnosed_once_without_starvation() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let large = format!(
        r#"{{"id":"large","sessionID":"ses1","role":"user","time":{{"created":200}},"content":"{}"}}"#,
        "x".repeat(5 * 1024 * 1024)
    );
    fs::write(base.join("message/ses1/large.json"), large).unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        error_files(std::slice::from_ref(&b0)),
        vec!["message/ses1/large.json".to_string()],
        "oversized document not diagnosed: {:?}",
        b0.items
    );

    // The unchanged oversized document is not re-reported on the next call.
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "oversized diagnostic flooded: {:?}",
        b1.items
    );

    // A later small valid document is still processed.
    fs::write(base.join("message/ses1/small.json"), user_msg(201)).unwrap();
    let b2 = poll_batches(&src, b1.next, 5).await;
    let ts = steps_of(&b2);
    assert!(ts.contains(&201), "small document starved: {:?}", b2.len());

    // The oversized document is diagnosed again only once its physical version changes.
    fs::write(
        base.join("message/ses1/large.json"),
        format!(
            r#"{{"id":"large","sessionID":"ses1","role":"user","time":{{"created":300}},"content":"{}"}}"#,
            "y".repeat(5 * 1024 * 1024)
        ),
    )
    .unwrap();
    let b3 = poll_batches(&src, b2.last().unwrap().next, 5).await;
    assert_eq!(
        error_files(&b3),
        vec!["message/ses1/large.json".to_string()],
        "changed oversized document not re-diagnosed"
    );
}

#[tokio::test]
async fn snapshot_opencode_invalid_document_diagnosed_once_and_recovered() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let bad = base.join("message/ses1/bad.json");
    fs::write(
        &bad,
        r#"{"id":"m_bad","sessionID":"ses1","role":"user","time":{"created":"#,
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        error_files(std::slice::from_ref(&b0)),
        vec!["message/ses1/bad.json".to_string()],
        "invalid document not diagnosed: {:?}",
        b0.items
    );
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "invalid diagnostic flooded: {:?}",
        b1.items
    );

    // Completing the write makes it valid: it is read once and produces its observation.
    fs::write(&bad, user_msg(777)).unwrap();
    let drained = poll_batches(&src, b1.next, 5).await;
    assert_eq!(steps_of(&drained), vec![777], "{:?}", drained.len());
    assert!(error_files(&drained).is_empty());
}

#[tokio::test]
async fn snapshot_opencode_sample_and_ceiling_constants_are_consistent() {
    // Samples are bounded and smaller than the per-call budget they are charged against, and any
    // supported document plus its sample still fits a fresh call's budget.
    const {
        assert!(
            opencode::SAMPLE_WINDOW * opencode::SAMPLE_WINDOWS as u64 <= opencode::SAMPLE_MAX_BYTES
        )
    };
    const { assert!(opencode::MAX_DOC_BYTES + opencode::SAMPLE_MAX_BYTES < MAX_BYTES_PER_PASS) };
    assert_eq!(opencode::planned_sample_bytes(0), 0);
    assert_eq!(opencode::planned_sample_bytes(16), 16);
    assert_eq!(
        opencode::planned_sample_bytes(opencode::SAMPLE_FULL_MAX),
        opencode::SAMPLE_FULL_MAX
    );
    assert_eq!(
        opencode::planned_sample_bytes(opencode::SAMPLE_FULL_MAX + 1),
        opencode::SAMPLE_WINDOW * opencode::SAMPLE_WINDOWS as u64
    );
}

#[tokio::test]
async fn snapshot_opencode_diagnostic_only_poll_does_not_reset() {
    // A store holding only an oversized document emits just a diagnostic on the first call. That
    // call must still advance the cursor, otherwise the next poll would reset and re-diagnose.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("message/ses1/large.json"),
        format!(
            r#"{{"id":"large","sessionID":"ses1","role":"user","time":{{"created":200}},"content":"{}"}}"#,
            "x".repeat(5 * 1024 * 1024)
        ),
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)).len(), 0);
    assert!(!error_files(std::slice::from_ref(&b0)).is_empty());
    assert!(
        b0.next.0 > 0,
        "diagnostic-only batch returned Cursor(0), which would reset the source"
    );
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(
        b1.items.is_empty(),
        "diagnostic repeated after a diagnostic-only batch: {:?}",
        b1.items
    );
}

#[tokio::test]
async fn snapshot_opencode_mtime_only_change_emits_nothing() {
    // A metadata-only touch (identical bytes, new mtime) must not replay committed observations,
    // either live or after a checkpoint restore.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    let msg = base.join("message/ses1/m1.json");
    fs::write(
        &msg,
        r#"{"id":"m1","sessionID":"ses1","role":"user","time":{"created":101}}"#,
    )
    .unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    // Live.
    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1.items.is_empty(), "initial drain: {:?}", b1.items);
    let new_mtime = mtime + Duration::from_secs(5);
    set_modified(&msg, new_mtime);
    let live = poll_batches(&src, b1.next, 5).await;
    assert!(
        live.iter().all(|b| b.items.is_empty()),
        "live metadata-only touch replayed: {:?}",
        live.iter().map(|b| b.items.len()).collect::<Vec<_>>()
    );

    // After restore.
    let cp = src.checkpoint();
    let src2 = opencode::OpenCode::new(None, &home, 30);
    src2.restore_checkpoint(cp);
    set_modified(&msg, new_mtime + Duration::from_secs(5));
    let restored = poll_batches(&src2, Cursor(1), 5).await;
    assert!(
        restored.iter().all(|b| b.items.is_empty()),
        "restored metadata-only touch replayed: {:?}",
        restored.iter().map(|b| b.items.len()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn snapshot_opencode_metadata_only_change_large_document() {
    // A document larger than SAMPLE_FULL_MAX whose bytes are unchanged but whose mtime moves
    // must not be replayed: the adapter reads the full content and compares its hash before
    // emitting anything.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    let padding = "x".repeat(5000);
    let doc = format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":101}},"blob":"{}"}}"#,
        padding
    );
    assert!(doc.len() > opencode::SAMPLE_FULL_MAX as usize);
    let msg = base.join("message/ses1/m_large.json");
    fs::write(&msg, &doc).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1.items.is_empty(), "initial drain: {:?}", b1.items);

    set_modified(&msg, mtime + Duration::from_secs(5));
    let touched = poll_batches(&src, b1.next, 5).await;
    assert!(
        touched.iter().all(|b| b.items.is_empty()),
        "large metadata-only touch replayed: {:?}",
        touched.iter().map(|b| b.items.len()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn snapshot_opencode_same_size_content_edit_emits_one_step_and_spend() {
    // A genuine same-size content edit must still be observed exactly once.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();
    let msg = base.join("message/ses1/m1.json");
    let first = padded_assistant_doc(1);
    let second = padded_assistant_doc(2);
    assert_eq!(first.len(), second.len());
    fs::write(&msg, &first).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(spend_inputs(std::slice::from_ref(&b0)), vec![1]);
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1.items.is_empty(), "unchanged reread: {:?}", b1.items);

    // Genuine edit, size preserved, mtime preserved.
    fs::write(&msg, &second).unwrap();
    set_modified(&msg, mtime);

    let live = poll_batches(&src, b1.next, 5).await;
    assert_eq!(spend_inputs(&live), vec![2], "{:?}", live);
    let step_count = live
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| i.kind == ItemKind::Step)
        .count();
    let spend_count = live
        .iter()
        .flat_map(|b| b.items.iter())
        .filter(|i| i.kind == ItemKind::Spend)
        .count();
    assert_eq!(step_count, 1, "expected one Step, got {}", step_count);
    assert_eq!(spend_count, 1, "expected one Spend, got {}", spend_count);
    let quiet = src.poll(live.last().unwrap().next).await.unwrap();
    assert!(
        quiet.items.is_empty(),
        "revision repeated: {:?}",
        quiet.items
    );
}

#[tokio::test]
async fn snapshot_opencode_large_between_window_edit_not_detected() {
    // Historical name: under the v4 bounded design this case *pinned the blind spot* — an edit that
    // landed between the four sample windows of a document larger than SAMPLE_FULL_MAX, with size and
    // mtime preserved, was NOT detected and the test asserted zero items. v5 replaced
    // sample+mtime equality with a resumable full-content witness, so this same fixture now asserts
    // the opposite (authorized inversion): the preserved-metadata edit IS observed within six real
    // polls, and afterwards the unchanged document stays silent live and across a restart.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    fs::create_dir_all(base.join("session/demo")).unwrap();
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(
        base.join("session/demo/ses1.json"),
        r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
    )
    .unwrap();

    // >4 KiB document with one mutable byte in a gap between the sample windows.
    let padding = "p".repeat(10000);
    let doc1 = format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":101}},"blob":"{}"}}"#,
        padding
    );
    let mut chars: Vec<char> = doc1.chars().collect();
    let idx = 1000usize;
    assert!(idx < chars.len() - 256);
    assert_eq!(chars[idx], 'p');
    chars[idx] = 'q';
    let doc2: String = chars.into_iter().collect();
    assert_eq!(doc1.len(), doc2.len());
    assert!(doc1.len() > opencode::SAMPLE_FULL_MAX as usize);
    assert_ne!(doc1, doc2);

    let msg = base.join("message/ses1/m_large.json");
    fs::write(&msg, &doc1).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();
    #[cfg(unix)]
    let ino = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&msg).unwrap().ino()
    };

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        steps_of(std::slice::from_ref(&b0)),
        vec![101],
        "{:?}",
        b0.items
    );
    let b1 = src.poll(b0.next).await.unwrap();
    assert!(b1.items.is_empty(), "unchanged reread: {:?}", b1.items);

    // Same inode and length, same mtime, content differs only between the sample windows.
    fs::write(&msg, &doc2).unwrap();
    set_modified(&msg, mtime);
    let m2 = fs::metadata(&msg).unwrap();
    assert_eq!(m2.len(), m2.len());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(m2.ino(), ino, "the edit must keep the inode");
    }
    assert_eq!(m2.modified().unwrap(), mtime, "the edit keeps the mtime");

    let mut cursor = b1.next;
    let mut detected = 0usize;
    for _ in 0..6 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        detected += b.items.len();
    }
    assert!(
        detected > 0,
        "the between-window preserved-metadata edit must be observed within six real polls"
    );

    // After acceptance the unchanged document is silent, and an unchanged restart stays silent.
    for _ in 0..3 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert!(
            b.items.is_empty(),
            "an accepted revision was re-emitted while the document was unchanged: {:?}",
            b.items
        );
    }
    let checkpoint = src.checkpoint();
    let fresh = opencode::OpenCode::new(None, &home, 30);
    fresh.restore_checkpoint(checkpoint);
    let b = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        b.items.is_empty(),
        "an unchanged OpenCode restart re-emitted items: {:?}",
        b.items
    );
}

// ===== v5: whole-turn bounds, cadence and witness restart (OpenCode actual paths) =====

use agentglimd::core::TurnBudget;

#[tokio::test]
async fn snapshot_opencode_turn_budget_bounds_entries_visits_and_bytes() {
    // A real scheduled turn over a tree bigger than one turn's allowance: entries, file/work visits
    // and content bytes all stay inside the shared caps, and the counters are cumulative across the
    // detect+poll phases of the one turn (never a per-phase reset).
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let blob = "z".repeat(1500);
    for i in 0..420u64 {
        fs::write(
            base.join("message/ses1").join(format!("m{i:03}.json")),
            format!(
                r#"{{"id":"m{i:03}","sessionID":"ses1","role":"user","time":{{"created":{}}},"blob":"{blob}"}}"#,
                2000 + i
            ),
        )
        .unwrap();
    }

    let src = opencode::OpenCode::new(None, &home, 30);
    let mut cursor = Cursor(0);
    let mut total = 0usize;
    let (mut max_e, mut max_v, mut max_b, mut turns) = (0u64, 0u64, 0u64, 0u32);
    for turn in 0..40 {
        let budget = TurnBudget::default_allowance();
        src.begin_turn(budget.clone());
        let b = src.poll(cursor).await.unwrap();
        src.end_turn();
        let usage = budget.usage();
        turns += 1;
        max_e = max_e.max(usage.entries.used);
        max_v = max_v.max(usage.visits.used);
        max_b = max_b.max(usage.bytes.used);
        assert!(
            usage.entries.used <= 200,
            "turn {turn} spent {} directory entries",
            usage.entries.used
        );
        assert!(
            usage.visits.used <= 200,
            "turn {turn} spent {} work visits",
            usage.visits.used
        );
        assert!(
            usage.bytes.used <= 4_194_304,
            "turn {turn} charged {} content bytes",
            usage.bytes.used
        );
        assert!(
            src.work_stats().last_pass_file_visits <= 200,
            "one call visited {} files",
            src.work_stats().last_pass_file_visits
        );
        total += b.items.len();
        cursor = b.next;
        if total >= 421 {
            break;
        }
    }
    assert!(
        total >= 421,
        "the bounded turns never drained the tree: {total} items"
    );
    // One turn's counters are per turn (the shared budget is fresh each turn), and the last turn of
    // a drained tree still stays inside the caps.
    assert!(
        src.work_stats().entries <= 200 && src.work_stats().file_visits <= 200,
        "final turn exceeded the shared caps: {:?}",
        src.work_stats()
    );
    println!(
        "ETURNBUDGET turns={turns} items={total} max_entries={max_e} max_visits={max_v} max_bytes={max_b}          final_payload_bytes={} final_opens={}",
        src.work_stats().payload_bytes,
        src.work_stats().opens
    );
}

#[tokio::test]
async fn snapshot_opencode_cadence_continues_sweep_without_restarting_it() {
    // A scheduled poll between discovery ticks continues the open sweep and must not start a new one;
    // the discovery tick (`detect`, 15 s cadence) is what makes a fresh sweep due.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    for i in 0..300u64 {
        fs::write(
            base.join("message/ses1").join(format!("m{i:03}.json")),
            user_msg(4000 + i),
        )
        .unwrap();
    }
    let src = opencode::OpenCode::new(None, &home, 30);
    let mut cursor = Cursor(0);
    // First turn: no detect needed for a never-swept source; it starts the one initial sweep.
    for _ in 0..6 {
        let budget = TurnBudget::default_allowance();
        src.begin_turn(budget);
        let b = src.poll(cursor).await.unwrap();
        src.end_turn();
        cursor = b.next;
    }
    let sweeps_mid = src.work_stats().sweeps;
    assert_eq!(sweeps_mid, 0, "the first sweep must still be unfinished");
    // Poll-only turns must not restart discovery.
    for _ in 0..4 {
        let budget = TurnBudget::default_allowance();
        src.begin_turn(budget);
        let _ = src.poll(cursor).await.unwrap();
        src.end_turn();
    }
    assert!(
        src.work_stats().sweeps <= 1,
        "poll-only turns restarted discovery: {} sweeps",
        src.work_stats().sweeps
    );
    // The 15-second discovery tick marks a fresh sweep due, and the next turn completes one.
    let env = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    assert!(matches!(src.detect(&env), Detection::Detected { .. }));
    let _ = src.poll(cursor).await.unwrap();
    src.end_turn();
    assert!(
        budget.usage().entries.used > 0,
        "detect and poll must share the one turn allowance"
    );
}

#[tokio::test]
async fn snapshot_opencode_dangling_entry_never_proves_a_known_file_absent() {
    // An unprovable directory entry (here a dangling symlink) makes the sweep incomplete, so a known
    // file that vanished in the same sweep must NOT be dropped from the checkpoint.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let known = base.join("message/ses1/m_known.json");
    fs::write(&known, user_msg(500)).unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![500]);
    assert!(src.discovery_complete_now(), "a clean sweep is complete");

    // Vanish the known file and plant an uninspectable entry in the same subtree.
    fs::remove_file(&known).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        base.join("message/ses1/does-not-exist"),
        base.join("message/ses1/dangling.json"),
    )
    .unwrap();

    let mut cursor = b0.next;
    for _ in 0..6 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
    }
    assert!(
        !src.discovery_complete_now(),
        "an unprovable entry must never count as a completed sweep"
    );
    let cp = src.checkpoint();
    assert!(
        cp.files
            .iter()
            .any(|f| f.path == "message/ses1/m_known.json"),
        "an incomplete sweep removed a known file: {:?}",
        cp.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>()
    );
    assert!(
        src.work_stats().sweeps_errored > 0,
        "the incomplete sweep was not counted honestly"
    );
}

#[tokio::test]
async fn snapshot_opencode_restart_mid_verification_resumes_without_replay() {
    // A witness pass interrupted by the shared byte allowance persists its progress in the
    // checkpoint; a restored adapter resumes it, stays silent on unchanged content, and still
    // detects a preserved-metadata edit afterwards.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let padding = "p".repeat(200_000);
    let doc1 = format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":101}},"blob":"{padding}"}}"#
    );
    let mut chars: Vec<char> = doc1.chars().collect();
    chars[1000] = 'q';
    let doc2: String = chars.into_iter().collect();
    assert_eq!(doc1.len(), doc2.len());
    let msg = base.join("message/ses1/m_large.json");
    fs::write(&msg, &doc1).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![101]);

    // A tiny byte allowance can only verify a slice of the document: the pass stays unfinished and
    // its progress is persisted, then a restart resumes instead of replaying the document.
    let budget = TurnBudget::bounded(32 * 1024, 200, 200);
    src.begin_turn(budget.clone());
    let b1 = src.poll(b0.next).await.unwrap();
    src.end_turn();
    assert!(
        b1.items.is_empty(),
        "unchanged document replayed: {:?}",
        b1.items
    );
    assert!(
        src.work_stats().verifications_started > 0,
        "the unchanged large document was never verified"
    );
    assert!(
        src.work_stats().verifications_completed == 0,
        "a 200 KiB document cannot be fully verified inside 32 KiB"
    );
    let cp = src.checkpoint();
    let message = cp
        .files
        .iter()
        .find(|f| f.path.ends_with("m_large.json"))
        .expect("checkpoint has the document");
    let revision = message.revision.clone().unwrap_or_default();
    assert!(
        revision.starts_with('{'),
        "witness progress was not persisted in the versioned checkpoint field: {revision}"
    );

    fs::write(&msg, &doc2).unwrap();
    set_modified(&msg, mtime);
    let restored = opencode::OpenCode::new(None, &home, 30);
    restored.restore_checkpoint(cp);
    let mut cursor = Cursor(1);
    let mut detected = 0usize;
    for _ in 0..10 {
        let b = restored.poll(cursor).await.unwrap();
        cursor = b.next;
        detected += b.items.len();
    }
    assert!(
        detected > 0,
        "a resumed witness missed the preserved-metadata edit"
    );
    let quiet = restored.poll(cursor).await.unwrap();
    assert!(
        quiet.items.is_empty(),
        "the accepted revision repeated: {:?}",
        quiet.items
    );
}

// ===== v5-r2: producer identity, coherent witness, discovery cadence and removal honesty =====

/// A supported user message of `len` characters carrying one blob, so a same-length content edit is
/// possible at any byte while the four sample windows stay identical.
fn blob_user_msg(ts: u64, len: usize, flip_at: Option<usize>) -> String {
    let mut blob = "p".repeat(len);
    if let Some(at) = flip_at {
        blob.replace_range(at..at + 1, "q");
    }
    format!(
        r#"{{"id":"m{ts}","sessionID":"ses1","role":"user","time":{{"created":{ts}}},"blob":"{blob}"}}"#
    )
}

/// A scheduled turn (the one shared allowance): `detect` when `detect`, then one `poll`.
async fn scheduled_turn(
    src: &opencode::OpenCode,
    env: &Env,
    cursor: Cursor,
    detect: bool,
) -> (Batch, agentglimd::core::TurnUsage) {
    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    if detect {
        assert!(matches!(src.detect(env), Detection::Detected { .. }));
    }
    let b = src.poll(cursor).await.unwrap();
    src.end_turn();
    (b, budget.usage())
}

#[tokio::test]
async fn snapshot_opencode_identities_are_aligned_and_a_b_a_keeps_three_revisions() {
    // Every emitted item carries one durable producer identity (`RecordKey::revision`), aligned 1:1 with
    // `Batch::items`. A -> B -> A with preserved metadata is three distinct identities, an unchanged
    // document (including a metadata-only touch and a restart) emits none.
    use agentglimd::core::RecordKey;
    use serde_json::Value;
    use std::collections::BTreeSet;

    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let msg = base.join("message/ses1/m1.json");
    let doc_a = blob_user_msg(601, 10_000, Some(4_000));
    let doc_b = blob_user_msg(601, 10_000, Some(4_001));
    assert_eq!(doc_a.len(), doc_b.len());

    let src = opencode::OpenCode::new(None, &home, 30);
    let mut cursor = Cursor(0);
    let mut accepted: Vec<(String, Value)> = Vec::new();

    for (label, doc) in [("A", &doc_a), ("B", &doc_b), ("A again", &doc_a)] {
        fs::write(&msg, doc).unwrap();
        let mtime = fs::metadata(&msg).unwrap().modified().unwrap();
        let mut emitted = Vec::new();
        for _ in 0..8 {
            let b = src.poll(cursor).await.unwrap();
            cursor = b.next;
            let ids = src.identities();
            assert_eq!(
                ids.len(),
                b.items.len(),
                "{label}: identities must align 1:1 with the batch items"
            );
            assert!(
                ids.iter().all(|k| matches!(k, RecordKey::Revision { .. })),
                "{label}: snapshot identities must be revision keys: {ids:?}"
            );
            for (item, id) in b.items.iter().zip(ids.iter()) {
                // The fixture also holds one session document; this case is about the message revision.
                if item.kind == ItemKind::Step && item.data["ts"] == 601 {
                    emitted.push((id.key(), serde_json::to_value(item).unwrap()));
                }
            }
            if !emitted.is_empty() {
                break;
            }
        }
        assert!(
            !emitted.is_empty(),
            "the {label} revision was never observed"
        );
        accepted.extend(emitted);
        // Keep the physical write honest (a real write moves mtime) while the content decides.
        set_modified(&msg, mtime);
    }

    let keys: Vec<&String> = accepted.iter().map(|(k, _)| k).collect();
    let distinct: BTreeSet<&&String> = keys.iter().collect();
    assert_eq!(
        distinct.len(),
        keys.len(),
        "each accepted revision needs its own producer identity: {keys:?}"
    );
    assert_eq!(accepted.len(), 3, "A -> B -> A is exactly three items");
    assert_eq!(
        accepted[0].1, accepted[2].1,
        "the first and third revision carry the same payload; only the identity distinguishes them"
    );

    // A metadata-only touch and an unchanged document emit nothing at all.
    let touched = fs::metadata(&msg).unwrap().modified().unwrap() + Duration::from_secs(5);
    set_modified(&msg, touched);
    for _ in 0..4 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        assert!(
            b.items.is_empty(),
            "a metadata-only touch must stay silent: {:?}",
            b.items
        );
        assert!(
            src.identities().is_empty(),
            "a silent poll must not report stale producer identities"
        );
    }
    // An unchanged restart emits nothing and keeps the same identities available only for real items.
    let cp = src.checkpoint();
    let fresh = opencode::OpenCode::new(None, &home, 30);
    fresh.restore_checkpoint(cp);
    let b = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        b.items.is_empty(),
        "an unchanged restart re-emitted: {:?}",
        b.items
    );
    assert!(fresh.identities().is_empty());
}

#[tokio::test]
async fn snapshot_opencode_partial_witness_then_edit_publishes_one_coherent_document() {
    // A witness pass interrupted by the byte allowance, then an edit with preserved metadata: the completed
    // pass describes a mixture of two versions, so its payload must be rejected and re-verified. Exactly one
    // coherent document (the current version) may be published, never a mixed or stale one.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let msg = base.join("message/ses1/m1.json");
    let doc_a = blob_user_msg(701, 200_000, None);
    let doc_b = blob_user_msg(702, 200_000, None);
    assert_eq!(doc_a.len(), doc_b.len(), "same length, same inode");
    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![701]);

    // A tiny turn allowance verifies only a slice of the document: the pass is left half-done and persisted.
    let budget = TurnBudget::bounded(32 * 1024, 200, 200);
    src.begin_turn(budget);
    let b1 = src.poll(b0.next).await.unwrap();
    src.end_turn();
    assert!(
        b1.items.is_empty(),
        "the unchanged document replayed: {:?}",
        b1.items
    );
    assert!(
        src.work_stats().verifications_started > 0,
        "the unchanged large document was never verified"
    );
    assert_eq!(
        src.work_stats().verifications_completed,
        0,
        "a 200 KiB document cannot be fully verified inside 32 KiB"
    );
    assert!(
        src.checkpoint()
            .files
            .iter()
            .filter(|f| f.path.ends_with("m1.json"))
            .any(|f| f.revision.as_deref().is_some_and(|r| r.starts_with('{'))),
        "partial witness progress was not persisted"
    );

    // Same inode, same length, same mtime: only the content differs.
    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);

    let mut cursor = b1.next;
    let mut after = Vec::new();
    for _ in 0..10 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        after.extend(b.items.iter().cloned());
        if !after.is_empty() {
            break;
        }
    }
    let steps = steps_of(std::slice::from_ref(&Batch {
        items: after.clone(),
        next: cursor,
    }));
    assert_eq!(
        steps,
        vec![702],
        "exactly the current coherent version may be published, got {:?} with items {:?}",
        steps,
        after
    );
    assert!(
        after.iter().all(|i| i.kind != ItemKind::Error),
        "a coherent read may not degrade into a diagnostic: {after:?}"
    );
    // And once accepted, the document is silent.
    let mut quiet = Vec::new();
    for _ in 0..4 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        quiet.extend(b.items.iter().cloned());
    }
    assert!(
        quiet.is_empty(),
        "the accepted revision repeated: {quiet:?}"
    );
}

#[tokio::test]
async fn snapshot_opencode_sweep_cadence_obeys_the_fifteen_second_clock() {
    // A fresh discovery sweep starts no more often than every 15 s on a scheduled turn: no early sweep,
    // known-file verification still progresses on the intervening turns, the due sweep finds a new path,
    // and a long pause produces exactly one sweep instead of a catch-up storm.
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(base.join("message/ses1/m1.json"), user_msg(8001)).unwrap();
    // A large known document keeps verification work pending on every intervening turn.
    fs::write(
        base.join("message/ses1/m_big.json"),
        blob_user_msg(8002, 200_000, None),
    )
    .unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let t0 = Arc::new(AtomicU64::new(1_000_000));
    let clock = t0.clone();
    src.set_clock(Some(Arc::new(move || clock.load(Ordering::SeqCst))));
    let env = Env {
        home: home.clone(),
        vars: Default::default(),
    };

    // Turn 1: a never-swept source sweeps at once and finishes one complete sweep.
    let (b0, used) = scheduled_turn(&src, &env, Cursor(0), true).await;
    println!(
        "ETURN turn=1 entries={} visits={} bytes={} verify_bytes={} sweeps={} starts={}",
        used.entries.used,
        used.visits.used,
        used.bytes.used,
        src.work_stats().verify_bytes,
        src.work_stats().sweeps,
        src.sweep_starts()
    );
    assert!(
        src.discovery_complete_now(),
        "the first sweep must complete"
    );
    assert_eq!(src.sweep_starts(), 1, "a never-swept source sweeps once");
    let mut cursor = b0.next;

    // A brand-new path appears 2 s later: no early sweep, but content verification progresses.
    fs::write(base.join("message/ses1/m_new.json"), user_msg(8003)).unwrap();
    t0.fetch_add(2_000, Ordering::SeqCst);
    let (b1, used) = scheduled_turn(&src, &env, cursor, true).await;
    println!(
        "ETURN turn=2(+2s) entries={} visits={} bytes={} verify_bytes={} sweeps={} starts={}",
        used.entries.used,
        used.visits.used,
        used.bytes.used,
        src.work_stats().verify_bytes,
        src.work_stats().sweeps,
        src.sweep_starts()
    );
    cursor = b1.next;
    assert_eq!(
        src.sweep_starts(),
        1,
        "a scheduled turn 2 s after the last sweep started a fresh one"
    );
    assert!(
        src.work_stats().verify_bytes > 0,
        "the intervening turn made no known-file verification progress: {:?}",
        src.work_stats()
    );
    assert!(
        steps_of(std::slice::from_ref(&b1)).is_empty(),
        "an undiscovered path cannot be reported before the due sweep: {:?}",
        b1.items
    );

    // Still before the floor: still no new sweep.
    t0.fetch_add(12_999, Ordering::SeqCst);
    let (b2, _) = scheduled_turn(&src, &env, cursor, true).await;
    cursor = b2.next;
    assert_eq!(src.sweep_starts(), 1, "a sweep started before 15 s elapsed");

    // At the 15 s floor a fresh sweep is due and finds the new path exactly once.
    t0.fetch_add(1, Ordering::SeqCst);
    let (b3, used) = scheduled_turn(&src, &env, cursor, true).await;
    println!(
        "ETURN turn=3(+15s) entries={} visits={} bytes={} verify_bytes={} sweeps={} starts={}",
        used.entries.used,
        used.visits.used,
        used.bytes.used,
        src.work_stats().verify_bytes,
        src.work_stats().sweeps,
        src.sweep_starts()
    );
    cursor = b3.next;
    assert_eq!(
        src.sweep_starts(),
        2,
        "the 15 s discovery tick did not sweep"
    );
    let mut found: Vec<u64> = steps_of(std::slice::from_ref(&b3));
    let mut extra = Vec::new();
    for _ in 0..4 {
        let (b, _) = scheduled_turn(&src, &env, cursor, false).await;
        cursor = b.next;
        extra.extend(steps_of(std::slice::from_ref(&b)));
    }
    found.extend(extra);
    assert_eq!(
        found,
        vec![8003],
        "the new path must be reported exactly once after the due sweep"
    );

    // A long pause must not be paid back as a burst of sweeps: five turns at the same instant start one.
    t0.fetch_add(600_000, Ordering::SeqCst);
    for _ in 0..5 {
        let (b, _) = scheduled_turn(&src, &env, cursor, true).await;
        cursor = b.next;
    }
    assert_eq!(
        src.sweep_starts(),
        3,
        "a 10 minute pause caused a catch-up storm of sweeps"
    );
}

#[tokio::test]
async fn snapshot_opencode_uninspectable_subtree_never_proves_removal() {
    // A subtree the sweep cannot inspect (non-NotFound stat error) may hold documents, so it can neither
    // certify absence nor drop durable known state.
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    fs::write(base.join("message/ses1/m1.json"), user_msg(9001)).unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![9001]);
    assert!(src.discovery_complete_now(), "a clean sweep is complete");
    let mut cursor = b0.next;

    // Move the `message` subtree aside and leave a self-referencing symlink in its place: `metadata()` then
    // fails with a non-NotFound error, so the subtree is unprovable rather than empty. The documents keep
    // their inode/mtime, so restoring the directory must not re-observe them.
    #[cfg(unix)]
    {
        fs::rename(base.join("message"), base.join("message_hold")).unwrap();
        std::os::unix::fs::symlink("message", base.join("message")).unwrap();
        for _ in 0..6 {
            let b = src.poll(cursor).await.unwrap();
            cursor = b.next;
        }
        assert!(
            !src.discovery_complete_now(),
            "an uninspectable subtree certified a complete sweep"
        );
        let cp = src.checkpoint();
        assert!(
            cp.files.iter().any(|f| f.path == "message/ses1/m1.json"),
            "an unproven subtree removed durable known state: {:?}",
            cp.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>()
        );
        assert!(
            src.work_stats().sweeps_errored > 0,
            "the failed sweep was not counted honestly: {:?}",
            src.work_stats()
        );

        // Once the subtree is inspectable again the known document is still there and stays silent.
        fs::remove_file(base.join("message")).unwrap();
        fs::rename(base.join("message_hold"), base.join("message")).unwrap();
        let mut replayed = Vec::new();
        for _ in 0..6 {
            let b = src.poll(cursor).await.unwrap();
            cursor = b.next;
            replayed.extend(b.items.iter().cloned());
        }
        assert!(
            replayed.is_empty(),
            "the retained document was replayed after recovery: {replayed:?}"
        );
    }
}

// ===== v5-r3 opencode-defer: a completed witness survives a deferred payload read =====

use agentglimd::core::{BatchItem, SourceCheckpoint, TurnUsage};

/// Supported user-message document whose `time.created` identity (the emittable version marker) and one
/// blob byte sit outside every bounded sample window, so a preserved-metadata edit there is invisible to
/// the four-window sample and can only be proven by the full-content witness (the audit's fixture shape).
fn windowed_msg(created: u64, blob_len: usize, pad_len: usize, flip_at: Option<usize>) -> String {
    let mut blob = "p".repeat(blob_len);
    if let Some(at) = flip_at {
        blob.replace_range(at..at + 1, "q");
    }
    let pad = "x".repeat(pad_len);
    format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","blob":"{blob}","time":{{"created":{created}}},"pad":"{pad}"}}"#
    )
}

/// Length contributed by everything except the blob and pad.
fn windowed_overhead(created: u64) -> usize {
    windowed_msg(created, 0, 0, None).len()
}

/// The same document at an exact byte length, keeping the tail sample window inside the inert pad.
fn windowed_msg_exact(created: u64, total: usize, flip_at: Option<usize>) -> String {
    let blob_len = total / 2;
    let pad_len = total
        .checked_sub(windowed_overhead(created) + blob_len)
        .expect("fixture must be longer than its own overhead");
    assert!(
        pad_len > 512,
        "pad too short: the identity field would be sampled"
    );
    let doc = windowed_msg(created, blob_len, pad_len, flip_at);
    assert_eq!(doc.len(), total, "fixture length must be exact");
    doc
}

/// Byte offset of the `time.created` value (the version identity carried by the emitted Step).
fn version_offset(doc: &str, created: u64) -> usize {
    doc.find(&format!("\"created\":{created}"))
        .expect("version field present")
        + "\"created\":".len()
}

/// Independent restatement of the adapter's bounded sample windows, used to prove that a fixture edit is
/// genuinely invisible to the sample (so only the content witness can observe it).
fn outside_sample_windows(len: usize, at: usize) -> bool {
    if len <= opencode::SAMPLE_FULL_MAX as usize {
        return false;
    }
    let w = opencode::SAMPLE_WINDOW as usize;
    let last = len - w;
    [0usize, last / 3, (last * 2) / 3, last]
        .iter()
        .all(|&off| at < off || at >= off + w)
}

/// Whether the durable checkpoint carries a completed, payload-deferred witness candidate.
fn deferred_candidate_present(cp: &SourceCheckpoint) -> bool {
    cp.files
        .iter()
        .any(|f| f.path.ends_with("m1.json") && f.fingerprint.contains("\"c\":{"))
}

/// The accepted revision counter stored for the message document (plain integer or `{"n":..,"v":..}`).
fn accepted_revision(cp: &SourceCheckpoint) -> u64 {
    let raw = cp
        .files
        .iter()
        .find(|f| f.path.ends_with("m1.json"))
        .and_then(|f| f.revision.clone())
        .unwrap_or_default();
    raw.parse::<u64>().unwrap_or_else(|_| {
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("n").and_then(|n| n.as_u64()))
            .unwrap_or(0)
    })
}

/// Default-allowance scheduled turns (`begin_turn` → `poll` → `end_turn`) until `stop` is true or the cap
/// is reached. Every turn must stay inside the shared caps; producer keys are collected 1:1 with items.
async fn turn_until<F>(
    src: &opencode::OpenCode,
    home: &std::path::Path,
    cursor: &mut Cursor,
    max_turns: u32,
    label: &str,
    mut stop: F,
) -> (Vec<BatchItem>, Vec<String>, u32)
where
    F: FnMut(&Batch) -> bool,
{
    let env = Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    };
    let mut items: Vec<BatchItem> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    let mut turns = 0u32;
    for turn in 0..max_turns {
        let (b, usage) = scheduled_turn(src, &env, *cursor, false).await;
        assert_caps(label, turn, &usage);
        assert_eq!(
            src.identities().len(),
            b.items.len(),
            "{label}: producer identities must align 1:1 with the batch"
        );
        *cursor = b.next;
        turns += 1;
        keys.extend(src.identities().iter().map(|k| k.key()));
        let done = stop(&b);
        items.extend(b.items.iter().cloned());
        if done {
            break;
        }
    }
    (items, keys, turns)
}

fn assert_caps(label: &str, turn: u32, usage: &TurnUsage) {
    assert!(
        usage.bytes.used <= 4_194_304,
        "{label}: turn {turn} charged {} content bytes",
        usage.bytes.used
    );
    assert!(
        usage.entries.used <= 200,
        "{label}: turn {turn} spent {} directory entries",
        usage.entries.used
    );
    assert!(
        usage.visits.used <= 200,
        "{label}: turn {turn} spent {} work visits",
        usage.visits.used
    );
}

/// One scheduled turn with a small explicit byte allowance, used to stop a witness pass mid-document so
/// the payload read is genuinely deferred.
async fn small_turn(src: &opencode::OpenCode, cursor: Cursor, bytes: u64) -> (Batch, TurnUsage) {
    let budget = TurnBudget::bounded(bytes, 200, 200);
    src.begin_turn(budget.clone());
    let b = src.poll(cursor).await.unwrap();
    src.end_turn();
    (b, budget.usage())
}

/// Drive small-allowance turns until a completed candidate has been persisted for the message document.
async fn reach_deferred_candidate(
    src: &opencode::OpenCode,
    cursor: &mut Cursor,
    bytes: u64,
    label: &str,
) -> SourceCheckpoint {
    for turn in 0..200 {
        let (b, usage) = small_turn(src, *cursor, bytes).await;
        assert_caps(label, turn, &usage);
        assert!(
            b.items.is_empty(),
            "{label}: a deferred witness must not publish anything: {:?}",
            b.items
        );
        *cursor = b.next;
        let cp = src.checkpoint();
        if deferred_candidate_present(&cp) {
            return cp;
        }
    }
    panic!("{label}: no completed witness candidate was persisted within the turn cap");
}

fn oc_env(home: &std::path::Path) -> Env {
    Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    }
}

/// A `session/demo/ses1.json` + `message/ses1/m1.json` OpenCode home.
fn oc_pair_home() -> (TempDir, PathBuf, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let base = oc_root(&home);
    write_session(&base);
    fs::create_dir_all(base.join("message/ses1")).unwrap();
    let msg = base.join("message/ses1/m1.json");
    (t, home, msg)
}

#[tokio::test]
async fn snapshot_opencode_near_ceiling_deferred_payload_publishes_within_finite_bound() {
    // Audit v5-r2 §2.2, replayed on the production adapter: a supported 4,160,077-byte document edited at
    // byte 1000 with inode/length/mtime preserved used to livelock — the completed witness was discarded
    // whenever the rest of the turn's byte allowance could not hold the payload, so verification restarted
    // every turn. The completed candidate is now persisted and the *next* turn reads and publishes it once.
    const TOTAL: usize = 4_160_077;
    let (_t, home, msg) = oc_pair_home();

    let doc_a = windowed_msg_exact(501, TOTAL, Some(1000));
    let doc_b = windowed_msg_exact(502, TOTAL, Some(1000));
    assert!(doc_a.len() as u64 <= opencode::MAX_DOC_BYTES);
    assert_eq!(doc_a.len(), doc_b.len(), "the edit keeps the file length");
    assert_ne!(doc_a, doc_b);
    assert_eq!(
        version_offset(&doc_a, 501),
        version_offset(&doc_b, 502),
        "the version identity must not move"
    );
    for at in [version_offset(&doc_a, 501), 1000] {
        assert!(
            outside_sample_windows(TOTAL, at),
            "offset {at} falls inside a sample window: the fixture would not need the witness"
        );
    }

    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();
    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        steps_of(std::slice::from_ref(&b0)),
        vec![501],
        "{:?}",
        b0.items
    );
    let mut cursor = b0.next;

    // Preserved-metadata edit: same inode, same length, same mtime, one byte inside the blob.
    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);
    let m = fs::metadata(&msg).unwrap();
    assert_eq!(m.len(), TOTAL as u64);
    assert_eq!(m.modified().unwrap(), mtime, "the edit keeps the mtime");

    // Justified finite bound: one full witness pass (chunks per visit × chunk size per turn) plus the turn
    // that reads the payload and one spare turn for the deferred hand-off.
    let per_turn = opencode::VERIFY_CHUNK * u64::from(opencode::WITNESS_CHUNKS_PER_VISIT);
    let max_turns = TOTAL.div_ceil(per_turn as usize) as u32 + 2;
    let (items, keys, turns) =
        turn_until(&src, &home, &mut cursor, max_turns, "near-ceiling", |b| {
            !b.items.is_empty()
        })
        .await;

    println!(
        "DEFER_NEAR_CEILING size={TOTAL} turns={turns} bound={max_turns} items={} max_cap_bytes=4194304",
        items.len()
    );
    let steps = steps_of(std::slice::from_ref(&Batch {
        items: items.clone(),
        next: cursor,
    }));
    assert_eq!(
        steps,
        vec![502],
        "the edited revision must be accepted exactly once, got {steps:?} from {items:?}"
    );
    assert!(
        items.iter().all(|i| i.kind != ItemKind::Error),
        "a coherent near-ceiling read degraded into a diagnostic: {items:?}"
    );
    assert_eq!(keys.len(), 1, "one revised item must carry one identity");
    // Nothing above the unchanged ceiling and no replayed original.
    assert_eq!(accepted_revision(&src.checkpoint()), 2);
    assert!(
        !deferred_candidate_present(&src.checkpoint()),
        "the accepted version still carries a pending candidate"
    );

    // Accepted once is accepted: unchanged polls, a metadata-only touch and a restart stay silent.
    let (quiet, _, _) =
        turn_until(&src, &home, &mut cursor, 3, "near-ceiling-quiet", |_| false).await;
    assert!(
        quiet.is_empty(),
        "the accepted revision repeated: {quiet:?}"
    );
    let touched = fs::metadata(&msg).unwrap().modified().unwrap() + Duration::from_secs(5);
    set_modified(&msg, touched);
    let (touched_items, _, _) =
        turn_until(&src, &home, &mut cursor, 4, "near-ceiling-touch", |_| false).await;
    assert!(
        touched_items.is_empty(),
        "a metadata-only touch re-emitted the document: {touched_items:?}"
    );
    let fresh = opencode::OpenCode::new(None, &home, 30);
    fresh.restore_checkpoint(src.checkpoint());
    let (restarted, _, _) = turn_until(
        &fresh,
        &home,
        &mut cursor,
        2,
        "near-ceiling-restart",
        |_| false,
    )
    .await;
    assert!(
        restarted.is_empty(),
        "an unchanged restart re-emitted the near-ceiling document: {restarted:?}"
    );
}

#[tokio::test]
async fn snapshot_opencode_deferred_candidate_survives_restart_before_payload_read() {
    // The verified-but-payload-deferred boundary is durable: a restart at exactly that point publishes the
    // current version once, without re-verifying the whole document and without replaying the old one.
    const TOTAL: usize = 200_000;
    let (_t, home, msg) = oc_pair_home();
    let doc_a = windowed_msg_exact(511, TOTAL, Some(1000));
    let doc_b = windowed_msg_exact(512, TOTAL, Some(1000));
    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![511]);
    let mut cursor = b0.next;

    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);
    let cp = reach_deferred_candidate(&src, &mut cursor, 32 * 1024, "restart-deferral").await;
    assert_eq!(
        accepted_revision(&cp),
        1,
        "no revision before the payload read"
    );
    assert!(
        !cp.files
            .iter()
            .find(|f| f.path.ends_with("m1.json"))
            .map(|f| f.fingerprint.contains("\"v\":{"))
            .unwrap_or(false),
        "a completed candidate must replace in-progress witness progress: {cp:?}"
    );

    // Restart from that exact durable checkpoint.
    let fresh = opencode::OpenCode::new(None, &home, 30);
    fresh.restore_checkpoint(cp);
    let before = fresh.work_stats();
    let (items, keys, turns) = turn_until(&fresh, &home, &mut cursor, 3, "restart-publish", |b| {
        !b.items.is_empty()
    })
    .await;
    let work = fresh.work_stats();
    println!(
        "DEFER_RESTART turns={turns} items={} verify_bytes_this_turn={} verifications_started={}",
        items.len(),
        work.verify_bytes.saturating_sub(before.verify_bytes),
        work.verifications_started
    );
    assert_eq!(
        steps_of(std::slice::from_ref(&Batch {
            items: items.clone(),
            next: cursor,
        })),
        vec![512],
        "the restart published {items:?}"
    );
    assert_eq!(keys.len(), 1);
    assert_eq!(
        work.verifications_started, 0,
        "the restored candidate was verified again instead of being reused: {work:?}"
    );
    assert!(
        fresh.work_stats().payload_bytes >= TOTAL as u64
            && fresh.work_stats().payload_bytes <= TOTAL as u64 + 2048,
        "the restart must read the payload it publishes (plus the bounded samples): {:?}",
        fresh.work_stats()
    );

    let (quiet, _, _) = turn_until(&fresh, &home, &mut cursor, 3, "restart-quiet", |_| false).await;
    assert!(
        quiet.is_empty(),
        "the restart replayed the accepted version: {quiet:?}"
    );
}

#[tokio::test]
async fn snapshot_opencode_deferred_candidate_invalidated_by_second_mutation() {
    // A second edit while the candidate for the first edit waits for payload allowance invalidates it: the
    // stale version can never publish, verification restarts on the current bytes, and exactly one coherent
    // revision of the *current* document is accepted.
    const TOTAL: usize = 200_000;
    let (_t, home, msg) = oc_pair_home();
    let doc_a = windowed_msg_exact(521, TOTAL, Some(1000));
    let doc_b = windowed_msg_exact(522, TOTAL, Some(1000));
    let doc_c = windowed_msg_exact(523, TOTAL, Some(1200));
    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![521]);
    let mut cursor = b0.next;

    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);
    reach_deferred_candidate(&src, &mut cursor, 32 * 1024, "second-mutation-deferral").await;

    // Second mutation during the deferral, again with every stat-visible field preserved.
    fs::write(&msg, &doc_c).unwrap();
    set_modified(&msg, mtime);
    let (items, keys, turns) = turn_until(&src, &home, &mut cursor, 40, "second-mutation", |b| {
        !b.items.is_empty()
    })
    .await;
    println!("DEFER_SECOND_MUTATION turns={turns} items={}", items.len());
    let steps = steps_of(std::slice::from_ref(&Batch {
        items: items.clone(),
        next: cursor,
    }));
    assert_eq!(
        steps,
        vec![523],
        "only the current document may be accepted, got {steps:?} from {items:?}"
    );
    assert!(
        !steps.contains(&522),
        "the invalidated candidate version was published: {steps:?}"
    );
    assert_eq!(keys.len(), 1);
    assert_eq!(accepted_revision(&src.checkpoint()), 2);

    // The accepted bytes are the current file, proven with an independently computed plain digest.
    let expected = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(fs::read(&msg).unwrap());
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let cp = src.checkpoint();
    let fingerprint = cp
        .files
        .iter()
        .find(|f| f.path.ends_with("m1.json"))
        .map(|f| f.fingerprint.clone())
        .unwrap();
    let content_hash = fingerprint
        .split('|')
        .nth(1)
        .unwrap_or_default()
        .to_string();
    assert_eq!(
        content_hash, expected,
        "the accepted version is not the current file bytes"
    );
}

#[tokio::test]
async fn snapshot_opencode_deferred_candidate_exact_retry_after_failed_commit() {
    // A failed commit loses nothing but the publication: the same durable checkpoint retries to exactly one
    // revision with the same producer identity, so a store that did commit the first attempt deduplicates it
    // instead of storing the document twice.
    const TOTAL: usize = 200_000;
    let (_t, home, msg) = oc_pair_home();
    let doc_a = windowed_msg_exact(531, TOTAL, Some(1000));
    let doc_b = windowed_msg_exact(532, TOTAL, Some(1000));
    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![531]);
    let mut cursor = b0.next;

    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);
    let cp_deferred =
        reach_deferred_candidate(&src, &mut cursor, 32 * 1024, "retry-deferral").await;

    // The turn that would have been committed.
    let (attempt, usage) = scheduled_turn(&src, &oc_env(&home), cursor, false).await;
    assert_caps("retry-attempt", 0, &usage);
    let attempt_keys = src.identities();
    assert_eq!(
        steps_of(std::slice::from_ref(&attempt)),
        vec![532],
        "the deferred candidate must publish the current version: {:?}",
        attempt.items
    );
    assert_eq!(attempt_keys.len(), 1);

    // Commit failure: only the previously committed checkpoint survives, so the adapter is rebuilt from it.
    let retry_src = opencode::OpenCode::new(None, &home, 30);
    retry_src.restore_checkpoint(cp_deferred);
    let mut retry_cursor = cursor;
    let (retried, usage) = scheduled_turn(&retry_src, &oc_env(&home), retry_cursor, false).await;
    assert_caps("retry-second", 0, &usage);
    retry_cursor = retried.next;
    assert_eq!(
        steps_of(std::slice::from_ref(&retried)),
        vec![532],
        "the exact retry published something else: {:?}",
        retried.items
    );
    assert_eq!(
        retry_src.identities(),
        attempt_keys,
        "an exact retry must reuse the same producer identity so a committed first attempt deduplicates"
    );
    assert_eq!(
        retried.items.len(),
        attempt.items.len(),
        "the retry must not add or drop items"
    );

    let (quiet, _, _) = turn_until(
        &retry_src,
        &home,
        &mut retry_cursor,
        3,
        "retry-quiet",
        |_| false,
    )
    .await;
    assert!(
        quiet.is_empty(),
        "the retry replayed the accepted version: {quiet:?}"
    );
}

#[tokio::test]
async fn snapshot_opencode_deferred_candidate_final_chunk_alignment() {
    // A document whose length is an exact multiple of the witness chunk keeps the fold alignment when the
    // last chunk is full, and an edit in that final chunk (invisible to the sample windows) still defers and
    // then publishes exactly once.
    const TOTAL: usize = 40_960; // 10 × VERIFY_CHUNK
    assert_eq!(TOTAL as u64 % opencode::VERIFY_CHUNK, 0);
    let (_t, home, msg) = oc_pair_home();
    // A pad short enough to sit inside the final aligned chunk but still longer than the tail sample
    // window, so the version identity is both invisible to the sample and verified by the last chunk.
    let pad_len = 600;
    let blob_len = TOTAL - windowed_overhead(541) - pad_len;
    let doc_a = windowed_msg(541, blob_len, pad_len, Some(1000));
    let doc_b = windowed_msg(542, blob_len, pad_len, Some(1200));
    assert_eq!(doc_a.len(), TOTAL);
    assert_eq!(doc_b.len(), TOTAL);
    for at in [version_offset(&doc_a, 541), 1000] {
        assert!(outside_sample_windows(TOTAL, at), "offset {at} is sampled");
    }
    let last_chunk_start = TOTAL - opencode::VERIFY_CHUNK as usize;
    assert!(
        version_offset(&doc_a, 541) >= last_chunk_start,
        "the version identity must live in the final aligned chunk"
    );
    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![541]);
    let mut cursor = b0.next;

    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);
    reach_deferred_candidate(&src, &mut cursor, 32 * 1024, "final-chunk-deferral").await;
    let (items, keys, turns) =
        turn_until(&src, &home, &mut cursor, 3, "final-chunk-publish", |b| {
            !b.items.is_empty()
        })
        .await;
    println!(
        "DEFER_FINAL_CHUNK size={TOTAL} turns={turns} items={}",
        items.len()
    );
    assert_eq!(
        steps_of(std::slice::from_ref(&Batch {
            items: items.clone(),
            next: cursor,
        })),
        vec![542],
        "the final-chunk edit must publish the current version: {items:?}"
    );
    assert_eq!(keys.len(), 1);
    assert_eq!(accepted_revision(&src.checkpoint()), 2);
}

#[tokio::test]
async fn snapshot_opencode_ceiling_document_defers_and_stale_candidate_never_publishes() {
    // Ceiling behavior is unchanged: a document at the supported maximum still publishes its edit, and a
    // document that grows past the ceiling while a candidate waits is diagnosed once — the stale candidate
    // is dropped, nothing is read as payload and no revision is invented.
    let (_t, home, msg) = oc_pair_home();
    let ceiling = opencode::MAX_DOC_BYTES as usize;
    let doc_a = windowed_msg_exact(551, ceiling, Some(1000));
    let doc_b = windowed_msg_exact(552, ceiling, Some(1000));
    assert_eq!(doc_a.len(), ceiling);
    fs::write(&msg, &doc_a).unwrap();
    let mtime = fs::metadata(&msg).unwrap().modified().unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![551]);
    let mut cursor = b0.next;

    // A deferred near-ceiling edit publishes within the same justified bound as the audit fixture.
    fs::write(&msg, &doc_b).unwrap();
    set_modified(&msg, mtime);
    let per_turn = opencode::VERIFY_CHUNK * u64::from(opencode::WITNESS_CHUNKS_PER_VISIT);
    let max_turns = ceiling.div_ceil(per_turn as usize) as u32 + 3;
    let (items, _, turns) = turn_until(&src, &home, &mut cursor, max_turns, "ceiling", |b| {
        !b.items.is_empty()
    })
    .await;
    println!(
        "DEFER_CEILING size={ceiling} turns={turns} bound={max_turns} items={}",
        items.len()
    );
    assert_eq!(
        steps_of(std::slice::from_ref(&Batch {
            items: items.clone(),
            next: cursor,
        })),
        vec![552],
        "the ceiling-length edit must publish: {items:?}"
    );

    // Grow past the ceiling while a fresh edit waits: the stale candidate is dropped, not published.
    let doc_c = windowed_msg_exact(553, ceiling, Some(1000));
    fs::write(&msg, &doc_c).unwrap();
    set_modified(&msg, mtime);
    reach_deferred_candidate(&src, &mut cursor, 1024 * 1024, "ceiling-grow").await;
    let oversized = windowed_msg(
        554,
        200_000,
        ceiling + 1 - 200_000 - windowed_overhead(554),
        None,
    );
    assert_eq!(oversized.len() as u64, opencode::MAX_DOC_BYTES + 1);
    fs::write(&msg, &oversized).unwrap();
    let before = src.work_stats();
    let (diag, usage) = scheduled_turn(&src, &oc_env(&home), cursor, false).await;
    assert_caps("ceiling-over", 0, &usage);
    let work = src.work_stats();
    assert_eq!(
        error_files(std::slice::from_ref(&diag)),
        vec!["message/ses1/m1.json".to_string()],
        "an over-ceiling document must be diagnosed once: {:?}",
        diag.items
    );
    assert!(steps_of(std::slice::from_ref(&diag)).is_empty());
    assert!(
        work.payload_bytes.saturating_sub(before.payload_bytes) <= 8 * 1024,
        "an over-ceiling document must never be read as a payload (bounded samples only): {work:?}"
    );
    assert_eq!(
        work.verify_bytes.saturating_sub(before.verify_bytes),
        0,
        "an over-ceiling document must not be verified: {work:?}"
    );
    assert_eq!(
        accepted_revision(&src.checkpoint()),
        2,
        "the stale candidate published a revision for a document that is no longer supported"
    );
    // Unchanged polls repeat neither the diagnostic nor a revision.
    let (again, _, _) =
        turn_until(&src, &home, &mut cursor, 3, "ceiling-over-quiet", |_| false).await;
    assert!(
        again.is_empty(),
        "the over-ceiling diagnostic repeated or published: {again:?}"
    );
}

#[tokio::test]
async fn snapshot_opencode_malformed_candidate_state_is_reverified_not_trusted() {
    // Legacy, truncated and internally inconsistent durable state is verified again, never trusted: a
    // truncated witness/candidate JSON is ignored, and a well-formed candidate whose chain does not match the
    // current bytes can never publish (the payload is validated against the candidate before acceptance).
    const TOTAL: usize = 40_960;
    let (_t, home, msg) = oc_pair_home();
    let doc = windowed_msg_exact(561, TOTAL, None);
    fs::write(&msg, &doc).unwrap();

    let src = opencode::OpenCode::new(None, &home, 30);
    let b0 = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(steps_of(std::slice::from_ref(&b0)), vec![561]);
    let settled = src.checkpoint();
    let mut cursor = b0.next;

    // Fingerprint shape once the version was accepted: `sample | plain content hash | {"w":<witness>}`.
    let (sample, content_hash, settled_witness) = {
        let f = settled
            .files
            .iter()
            .find(|f| f.path.ends_with("m1.json"))
            .unwrap();
        let parts: Vec<&str> = f.fingerprint.splitn(3, '|').collect();
        assert_eq!(parts.len(), 3, "settled fingerprint shape: {f:?}");
        let witness = serde_json::from_str::<serde_json::Value>(parts[2])
            .ok()
            .and_then(|v| v.get("w").and_then(|w| w.as_str()).map(str::to_string))
            .unwrap_or_default();
        (parts[0].to_string(), parts[1].to_string(), witness)
    };
    assert_eq!(settled_witness.len(), 64, "settled witness digest missing");

    // (1) Truncated extra state: the whole `w`/`c` JSON is unparseable, so it is discarded and re-verified.
    let mut truncated = settled.clone();
    {
        let f = truncated
            .files
            .iter_mut()
            .find(|f| f.path.ends_with("m1.json"))
            .unwrap();
        f.fingerprint =
            format!("{sample}|{content_hash}|{{\"w\":\"{settled_witness}\",\"c\":{{\"ch\":\"abc");
    }
    let legacy = opencode::OpenCode::new(None, &home, 30);
    legacy.restore_checkpoint(truncated);
    let (items, _, _) =
        turn_until(&legacy, &home, &mut cursor, 3, "truncated-state", |_| false).await;
    assert!(
        items.is_empty(),
        "a truncated durable witness replayed the document: {items:?}"
    );
    assert!(
        !deferred_candidate_present(&legacy.checkpoint()),
        "a truncated candidate was revived from unparseable state"
    );

    // (2) A well-formed candidate bound to the right version but a chain that is not the document's: the
    // payload read must reject it, publish nothing and restart verification.
    let mut poisoned = settled.clone();
    {
        let f = poisoned
            .files
            .iter_mut()
            .find(|f| f.path.ends_with("m1.json"))
            .unwrap();
        let bogus = "a".repeat(64);
        let extra = serde_json::json!({
            "w": settled_witness,
            "c": {"ch": bogus, "sz": f.size, "mm": f.mtime_ms, "g": f.generation}
        });
        f.fingerprint = format!("{sample}|{content_hash}|{extra}");
    }
    assert_eq!(accepted_revision(&poisoned), 1);
    let poisoned_src = opencode::OpenCode::new(None, &home, 30);
    poisoned_src.restore_checkpoint(poisoned);
    assert!(
        deferred_candidate_present(&poisoned_src.checkpoint()),
        "the poisoned candidate was not restored, so the case tests nothing"
    );
    let (items, _, _) = turn_until(
        &poisoned_src,
        &home,
        &mut cursor,
        4,
        "poisoned-candidate",
        |_| false,
    )
    .await;
    assert!(
        items.is_empty(),
        "a candidate that does not match the payload published a revision: {items:?}"
    );
    assert_eq!(accepted_revision(&poisoned_src.checkpoint()), 1);
}

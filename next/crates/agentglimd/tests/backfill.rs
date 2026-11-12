use agentglimd::adapters::{registry_with_home, MAX_BYTES_PER_PASS};
use agentglimd::config::Config;
use agentglimd::core::Cursor;
use std::fs::{self, File};
use std::io::Write;
use std::time::Duration;
use tempfile::TempDir;

#[tokio::test]
async fn big_file_bounded_work() {
    let d = TempDir::new().unwrap();
    let home = d.path();
    let root = home.join(".claude/projects/proj1");
    fs::create_dir_all(&root).unwrap();

    let p = root.join("session.jsonl");
    let mut f = File::create(&p).unwrap();
    let line = "{\"type\":\"user\",\"timestamp\":1700000000000,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n";
    let line_len = line.len();
    let target_size = 5 * 1024 * 1024; // 5 MiB
    let num_lines = target_size / line_len;

    for _ in 0..num_lines {
        f.write_all(line.as_bytes()).unwrap();
    }
    f.sync_all().unwrap();

    let cfg = Config::default();
    let sources = registry_with_home(&cfg, home);
    let claude = sources.iter().find(|s| s.id() == "claude-code").unwrap();

    let start = std::time::Instant::now();
    let batch = claude.poll(Cursor(0)).await.unwrap();
    let elapsed = start.elapsed();

    assert!(elapsed < Duration::from_secs(2));
    assert!(!batch.items.is_empty());

    assert!(batch.next.0 <= MAX_BYTES_PER_PASS + line_len as u64);

    if let Ok(status) = fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if line.starts_with("VmRSS:") {
                eprintln!("MEASUREMENT: RSS during backfill: {}", line);
            }
        }
    }
}

#[tokio::test]
async fn oversized_unterminated_line() {
    let d = TempDir::new().unwrap();
    let home = d.path();
    let root = home.join(".claude/projects/proj1");
    fs::create_dir_all(&root).unwrap();

    let p = root.join("session.jsonl");
    let mut f = File::create(&p).unwrap();
    let big = vec![b'x'; 1024 * 1024];
    f.write_all(&big).unwrap();
    f.write_all(b"\n").unwrap();
    let line = "{\"type\":\"user\",\"timestamp\":1700000000000,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n";
    f.write_all(line.as_bytes()).unwrap();

    let cfg = Config::default();
    let sources = registry_with_home(&cfg, home);
    let claude = sources.iter().find(|s| s.id() == "claude-code").unwrap();

    let batch = claude.poll(Cursor(0)).await.unwrap();
    assert!(batch
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Error));
    assert!(batch
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Step));
}

#[tokio::test]
async fn history_window_adoption() {
    let d = TempDir::new().unwrap();
    let home = d.path();
    let root = home.join(".claude/projects/proj1");
    fs::create_dir_all(&root).unwrap();

    let p = root.join("old.jsonl");
    let mut f = File::create(&p).unwrap();
    let line = "{\"type\":\"user\",\"timestamp\":1700000000000,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n";
    f.write_all(line.as_bytes()).unwrap();
    drop(f);

    // Use shell to touch the file with an old date (40 days ago)
    let old_date = "198001010000.00"; // Very old
    let status = std::process::Command::new("touch")
        .args(["-t", old_date, p.to_str().unwrap()])
        .status()
        .unwrap();
    assert!(status.success());

    let cfg = Config {
        history_days: 30,
        ..Default::default()
    };
    let sources = registry_with_home(&cfg, home);
    let claude = sources.iter().find(|s| s.id() == "claude-code").unwrap();

    let batch = claude.poll(Cursor(0)).await.unwrap();
    assert!(batch.items.is_empty());
    assert!(batch.next.0 > 0);

    let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
    let line2 = "{\"type\":\"user\",\"timestamp\":1700000001000,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"new\"}]}}\n";
    f.write_all(line2.as_bytes()).unwrap();
    drop(f);

    let batch2 = claude.poll(batch.next).await.unwrap();
    assert!(batch2
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Session));
    assert!(batch2
        .items
        .iter()
        .any(|i| i.kind == agentglimd::core::ItemKind::Step));
}

use agentglimd::logging::{RotatingWriter, MAX_BYTES, MAX_FILES};
use std::io::Write;

#[test]
fn rotation_60mb_keeps_at_most_5_files_of_10mb() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = RotatingWriter::new(dir.path(), "agentglimd.log", MAX_BYTES, MAX_FILES).unwrap();
    let line = format!("{{\"level\":\"INFO\",\"msg\":\"{}\"}}\n", "x".repeat(1000));
    let mut written = 0u64;
    while written < 60 * 1024 * 1024 {
        w.write_all(line.as_bytes()).unwrap();
        written += line.len() as u64;
    }
    w.flush().unwrap();
    let files: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap())
        .collect();
    assert!(files.len() <= 5, "{} files", files.len());
    assert_eq!(files.len(), 5);
    for f in &files {
        assert!(
            f.metadata().unwrap().len() <= MAX_BYTES,
            "{:?} too big",
            f.path()
        );
    }
}

//! Read-only byte-offset JSONL tailer. Opens files read-only, never writes, never touches mtimes.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Limits for bounded reading.
pub const MAX_BYTES_PER_CALL: usize = 1024 * 1024; // 1 MiB
pub const MAX_PARTIAL_LINE_BYTES: usize = 256 * 1024; // 256 KiB

/// Result of a bounded read.
#[derive(Debug, PartialEq)]
pub enum ReadResult {
    /// Found lines, next offset, and whether the file is exhausted.
    Data {
        lines: Vec<String>,
        next_offset: u64,
        exhausted: bool,
        line_offsets: Vec<u64>,
        line_starts: Vec<u64>,
    },
    /// An unterminated line exceeded `MAX_PARTIAL_LINE_BYTES`.
    /// The caller should skip to the next newline and report an error.
    OversizedLine { next_offset: u64 },
}

/// Complete lines appended after `offset`, and the offset just past the last complete line.
/// A partial trailing line is left for the next call. A file shorter than `offset` (rotated or
/// truncated) is read again from 0.
///
/// Bounded: reads at most `max_bytes` (capped by `MAX_BYTES_PER_CALL`).
pub fn read_new_lines(path: &Path, offset: u64) -> std::io::Result<ReadResult> {
    read_new_lines_budget(path, offset, MAX_BYTES_PER_CALL, false)
}

/// Like [`read_new_lines`] but with an explicit byte budget and discard mode.
///
/// When `discard_pending` is true the reader is already inside an oversized physical row and must
/// skip bytes until the next newline without attempting to parse any suffix.
pub fn read_new_lines_budget(
    path: &Path,
    offset: u64,
    max_bytes: usize,
    discard_pending: bool,
) -> std::io::Result<ReadResult> {
    read_new_lines_budget_io(path, offset, max_bytes, discard_pending).map(|(r, _)| r)
}

/// Like [`read_new_lines_budget`] but also reports how many bytes the syscall actually returned.
///
/// Callers that pre-charge a read allowance must release the granted-but-unread part, so the byte count has to
/// come from the same place as the read: a short read at EOF returns fewer bytes than the grant.
pub fn read_new_lines_budget_io(
    path: &Path,
    offset: u64,
    max_bytes: usize,
    discard_pending: bool,
) -> std::io::Result<(ReadResult, u64)> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = if len < offset { 0 } else { offset };
    let to_read = (len.saturating_sub(start)).min(max_bytes as u64) as usize;
    if to_read == 0 {
        return Ok((
            ReadResult::Data {
                lines: Vec::new(),
                next_offset: start,
                exhausted: start == len,
                line_offsets: Vec::new(),
                line_starts: Vec::new(),
            },
            0,
        ));
    }

    f.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; to_read];
    f.read_exact(&mut buf)?;

    let exhausted = start + to_read as u64 == len;
    Ok((
        parse_lines(start, len, exhausted, &buf, discard_pending),
        to_read as u64,
    ))
}

/// Parses one already-read chunk. Split out of the reader so the byte count and the parse come from one read.
fn parse_lines(
    start: u64,
    len: u64,
    exhausted: bool,
    buf: &[u8],
    discard_pending: bool,
) -> ReadResult {
    let to_read = buf.len();

    // Discard mode: skip to the next newline, never parse.
    if discard_pending {
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            return ReadResult::OversizedLine {
                next_offset: start + i as u64 + 1,
            };
        }
        return ReadResult::OversizedLine {
            next_offset: if exhausted {
                len
            } else {
                start + to_read as u64
            },
        };
    }

    let last_nl = buf.iter().rposition(|b| *b == b'\n');

    if last_nl.is_none() {
        // No newline in this chunk.
        if to_read >= MAX_PARTIAL_LINE_BYTES {
            // Oversized partial line; skip bounded chunk (or to EOF).
            let next = if exhausted {
                len
            } else {
                start + to_read as u64
            };
            return ReadResult::OversizedLine { next_offset: next };
        }
        return ReadResult::Data {
            lines: Vec::new(),
            next_offset: start,
            exhausted,
            line_offsets: Vec::new(),
            line_starts: Vec::new(),
        };
    }

    let last_nl = last_nl.unwrap();

    // Detect an oversized line (>= MAX_PARTIAL_LINE_BYTES) among complete lines.
    let mut line_start = 0usize;
    let mut oversized_nl: Option<usize> = None;
    for (i, &b) in buf[..=last_nl].iter().enumerate() {
        if b == b'\n' {
            if i - line_start >= MAX_PARTIAL_LINE_BYTES {
                oversized_nl = Some(i);
                break;
            }
            line_start = i + 1;
        }
    }

    if let Some(nl) = oversized_nl {
        // If there are complete, non-oversized lines before the oversized one, return them
        // and stop at the start of the oversized line.
        if nl > 0 && buf[..nl].contains(&b'\n') {
            let prev_nl = buf[..nl].iter().rposition(|b| *b == b'\n').unwrap();
            let mut lines = Vec::new();
            let mut line_offsets = Vec::new();
            let mut line_starts = Vec::new();
            let mut ls = 0usize;
            for i in 0..=prev_nl {
                if buf[i] == b'\n' {
                    let raw = &buf[ls..i];
                    let line = String::from_utf8_lossy(raw)
                        .trim_end_matches('\r')
                        .to_string();
                    if !line.trim().is_empty() {
                        lines.push(line);
                        line_offsets.push(start + i as u64 + 1);
                        line_starts.push(start + ls as u64);
                    }
                    ls = i + 1;
                }
            }
            if !lines.is_empty() {
                return ReadResult::Data {
                    lines,
                    next_offset: start + prev_nl as u64 + 1,
                    exhausted: false,
                    line_offsets,
                    line_starts,
                };
            }
        }
        // Skip the oversized line.
        return ReadResult::OversizedLine {
            next_offset: start + nl as u64 + 1,
        };
    }

    // Normal case: all complete lines up to last_nl.
    let mut lines = Vec::new();
    let mut line_offsets = Vec::new();
    let mut line_starts = Vec::new();
    let mut ls = 0usize;
    for i in 0..=last_nl {
        if buf[i] == b'\n' {
            let raw = &buf[ls..i];
            let line = String::from_utf8_lossy(raw)
                .trim_end_matches('\r')
                .to_string();
            if !line.trim().is_empty() {
                lines.push(line);
                line_offsets.push(start + i as u64 + 1);
                line_starts.push(start + ls as u64);
            }
            ls = i + 1;
        }
    }

    ReadResult::Data {
        lines,
        next_offset: start + last_nl as u64 + 1,
        exhausted: exhausted && (last_nl + 1 == to_read),
        line_offsets,
        line_starts,
    }
}

/// All files under `dir` (recursive) whose name ends with `suffix`, sorted. Missing dir -> empty.
pub fn find_files(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, suffix, &mut out);
    out.sort();
    out
}

/// Bounded variant of [`find_files`]: collects at most `limit` matching files without
/// materialising an unbounded directory listing. Used by adapter detection so a large
/// tree cannot blow the per-pass byte/entry budget.
pub fn find_files_bounded(dir: &Path, suffix: &str, limit: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            if out.len() >= limit {
                break;
            }
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(p),
                Ok(t)
                    if t.is_file()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.ends_with(suffix)) =>
                {
                    out.push(p)
                }
                _ => {}
            }
        }
    }
    out
}

fn walk(dir: &Path, suffix: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, suffix, out),
            Ok(t)
                if t.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(suffix)) =>
            {
                out.push(p)
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tails_complete_lines_only() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":2}\n{\"c\"").unwrap();
        let res = read_new_lines(&p, 0).unwrap();
        let (l, off) = match res {
            ReadResult::Data {
                lines, next_offset, ..
            } => (lines, next_offset),
            _ => panic!("Expected data"),
        };
        assert_eq!(l, vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(off, 16);

        let res2 = read_new_lines(&p, off).unwrap();
        let (l2, off2) = match res2 {
            ReadResult::Data {
                lines, next_offset, ..
            } => (lines, next_offset),
            _ => panic!("Expected data"),
        };
        assert!(l2.is_empty());
        assert_eq!(off2, off);

        std::fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .unwrap()
            .write_all(b":3}\n")
            .unwrap();
        let res3 = read_new_lines(&p, off2).unwrap();
        let (l3, off3) = match res3 {
            ReadResult::Data {
                lines, next_offset, ..
            } => (lines, next_offset),
            _ => panic!("Expected data"),
        };
        assert_eq!(l3, vec!["{\"c\":3}"]);
        assert_eq!(off3, 24);

        std::fs::write(&p, "{\"z\":0}\n").unwrap();
        let res4 = read_new_lines(&p, off3).unwrap();
        let (l4, _) = match res4 {
            ReadResult::Data {
                lines, next_offset, ..
            } => (lines, next_offset),
            _ => panic!("Expected data"),
        };
        assert_eq!(l4, vec!["{\"z\":0}"]);
    }

    #[test]
    fn bounded_read_large_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("large.jsonl");
        let line = "{\"val\":123}\n"; // 12 bytes
        let num_lines = (MAX_BYTES_PER_CALL * 3) / line.len();
        let mut f = File::create(&p).unwrap();
        for _ in 0..num_lines {
            f.write_all(line.as_bytes()).unwrap();
        }
        let total_size = (num_lines * line.len()) as u64;

        let mut offset = 0;
        let mut total_lines = 0;
        loop {
            match read_new_lines(&p, offset).unwrap() {
                ReadResult::Data {
                    lines,
                    next_offset,
                    exhausted,
                    ..
                } => {
                    total_lines += lines.len();
                    if exhausted {
                        offset = next_offset;
                        break;
                    }
                    offset = next_offset;
                }
                _ => panic!("unexpected oversized"),
            }
        }
        assert_eq!(total_lines, num_lines);
        assert_eq!(offset, total_size);
    }

    #[test]
    fn discard_pending_skips_to_newline() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.jsonl");
        std::fs::write(&p, "prefix-garbage-suffix\n{\"good\":1}\n").unwrap();
        // start inside the oversized physical row
        let res = read_new_lines_budget(&p, 7, 1024, true).unwrap();
        match res {
            ReadResult::OversizedLine { next_offset } => {
                assert!(next_offset <= 22);
            }
            _ => panic!("expected oversized"),
        }
    }
}

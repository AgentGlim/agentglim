//! Independent adapter -> poller/Bus/Store recovery oracle (v4-r1 T03, G03).
//!
//! These targets drive the real JSONL `Source` implementations (no helper-only doubles) through the same
//! `poll -> identities -> checkpoint -> Bus::commit` transaction the poller performs, and then read the
//! persisted `events` / `source_file_state` / `source_removed` / `source_generations` rows from SQLite.
//! Committed *values* are checked against hand-written expectations (models/timestamps, row counts, byte
//! positions), never against output produced by the adapter under test.
//!
//! Known v3 failure modes these targets reject (`_build/v3-final/VERIFY.md`, D03/D06):
//!  * same-inode equal-size A -> B rewrite: the new revision's producer key collided with A's key because the
//!    generation came from inode/dev, so the B row was dropped by `INSERT OR IGNORE` on `events.producer`.
//!  * a same-size suffix edit beyond byte 256 with a changed mtime was classified "unchanged" because the
//!    comparison only sampled the first 256 bytes.
//!
//! Fixtures are synthetic and generated here; the expected values in each test are written by hand from the
//! JSONL the test writes. No host transcript, cookie, token or source database is read.
//!
//! v4-r2 additions (independent-gates, r1 audit B1/B3): append -> touch / serialized unchanged restart keeps
//! exactly `[A,B]`; a 70,084-byte record with a same-size suffix edit reaches SQLite once live and after a
//! serialized restore; a legacy v6 checkpoint with no content witness is treated as *unknown*, never equality;
//! a >4 MiB source makes bounded multi-pass verification progress; and a restart in the middle of a bounded
//! discovery sweep proves nothing removed. Every expected value is still hand-derived from the synthetic bytes.

use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{
    now_ms, BatchItem, CheckpointDelta, Cursor, Env, RecordKey, RemovedPath, Source,
    SourceCheckpoint,
};
use agentglimd::store::Store;
use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

const SID: &str = "sess-recovery-oracle";
const TS: &str = "2026-11-01T00:00:00.000Z";

// ---------------------------------------------------------------------------------------------
// Synthetic JSONL builders (bytes are fully determined here, including newline placement).
// ---------------------------------------------------------------------------------------------

/// One Claude Code record that maps to exactly one `Step` (`type`/`sessionId`/`message.model`/`timestamp`).
fn claude_line(model: &str) -> String {
    format!(
        r#"{{"type":"assistant","sessionId":"{SID}","message":{{"role":"assistant","model":"{model}"}},"timestamp":"{TS}"}}"#
    ) + "\n"
}

/// Claude Code record whose distinguishing token sits beyond byte 256 (600 bytes of padding in an unused
/// field), so a 256-byte prefix sample cannot see a same-size edit.
fn claude_suffix_line(tail: &str) -> String {
    let pad = "x".repeat(600);
    format!(
        r#"{{"type":"assistant","sessionId":"{SID}","pad":"{pad}","message":{{"role":"assistant","model":"{tail}"}},"timestamp":"{TS}"}}"#
    ) + "\n"
}

fn codex_line(ts: &str) -> String {
    format!(
        r#"{{"timestamp":"{ts}","type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"done"}}]}}}}"#
    ) + "\n"
}

fn agy_line(model: &str) -> String {
    format!(r#"{{"type":"assistant","model":"{model}","timestamp":"{TS}"}}"#) + "\n"
}

fn pi_line(model: &str) -> String {
    format!(
        r#"{{"type":"message","timestamp":"{TS}","message":{{"role":"assistant","model":"{model}","content":[]}}}}"#
    ) + "\n"
}

fn claude_adapter(home: &Path) -> Box<dyn Source> {
    Box::new(agentglimd::adapters::claude_code::ClaudeCode::new(
        None, home, 30,
    ))
}

fn codex_adapter(home: &Path) -> Box<dyn Source> {
    Box::new(agentglimd::adapters::codex::Codex::new(None, home, 30))
}

fn agy_adapter(home: &Path) -> Box<dyn Source> {
    Box::new(agentglimd::adapters::agy::Agy::new(None, home, 30))
}

fn pi_adapter(home: &Path) -> Box<dyn Source> {
    Box::new(agentglimd::adapters::pi::Pi::new(None, home, 30))
}

// ---------------------------------------------------------------------------------------------
// Persistence harness: the poller algorithm, driven deterministically by the test.
// ---------------------------------------------------------------------------------------------

/// A commit failure injected through a SQLite trigger (the technique used by the existing
/// `identity_recovery` recovery suite; no product hook and no product edit).
const FAIL_TRIGGER: &str = "CREATE TRIGGER inject_fail BEFORE INSERT ON source_file_state \
     BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;";

struct Pending {
    items: Vec<BatchItem>,
    next: u64,
    checkpoint: SourceCheckpoint,
    /// Delta-capable sources: the bounded delta actually committed (the full `checkpoint` above is
    /// then the merged committed state, kept for `saved` bookkeeping).
    delta: Option<CheckpointDelta>,
    identities: Vec<RecordKey>,
    removed: Vec<RemovedPath>,
    reappeared: Vec<String>,
}

struct Oracle {
    tmp: TempDir,
    home: PathBuf,
    db: PathBuf,
    source_id: &'static str,
    bus: Bus,
    src: Box<dyn Source>,
    cursor: u64,
    saved: SourceCheckpoint,
    tombstones: Vec<RemovedPath>,
    first: bool,
    pending: Option<Pending>,
    polls: usize,
}

impl Oracle {
    /// Fresh database and a synthetic `home` under this test's own temp dir.
    fn new(make: fn(&Path) -> Box<dyn Source>, source_id: &'static str) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("home");
        Self::with_home(tmp, home, make, source_id)
    }

    fn with_home(
        tmp: TempDir,
        home: PathBuf,
        make: fn(&Path) -> Box<dyn Source>,
        source_id: &'static str,
    ) -> Self {
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&data).expect("data dir");
        let db = data.join("state.db");
        let store = Store::open(&db).expect("open store");
        let bus = Bus::new(store).expect("bus");
        let src = make(&home);
        Self {
            tmp,
            home,
            db,
            source_id,
            bus,
            src,
            cursor: 0,
            saved: SourceCheckpoint::default(),
            tombstones: Vec::new(),
            first: true,
            pending: None,
            polls: 0,
        }
    }

    fn write(&self, abs: &Path, bytes: &str) {
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).expect("parent dir");
        }
        std::fs::write(abs, bytes).expect("write synthetic fixture");
    }

    /// Rewrite in place (same inode), then move the mtime forward deterministically so the adapter can
    /// observe a metadata change; returns (inode, size) after the rewrite.
    fn rewrite_in_place(&self, abs: &Path, bytes: &str, mtime_offset_hours: u64) -> (u64, u64) {
        std::fs::write(abs, bytes).expect("rewrite synthetic fixture");
        set_mtime_hours_from_now(abs, mtime_offset_hours);
        (inode(abs), file_len(abs))
    }

    /// Simulates a restart: the complete checkpoint is serialized to JSON, the adapter is discarded and a
    /// new one restores it, plus the durable tombstones.
    fn restart(&mut self, make: fn(&Path) -> Box<dyn Source>) {
        let json = serde_json::to_string(&self.saved).expect("serialize checkpoint");
        let restored: SourceCheckpoint = serde_json::from_str(&json).expect("restore checkpoint");
        self.src = make(&self.home);
        self.src.restore_checkpoint(restored.clone());
        let tombstones = self.durable_removed();
        self.src.restore_removed(&tombstones);
        self.saved = restored;
        self.tombstones = tombstones;
        self.pending = None;
        self.first = true;
        self.cursor = self.saved.files.iter().map(|f| f.offset).max().unwrap_or(0);
    }

    /// One poll + commit turn (checkpoint-only progress commits too, as the poller does).
    async fn turn(&mut self) -> Result<Option<(usize, usize)>, String> {
        if self.pending.is_none() {
            let since = if self.first && self.saved.files.is_empty() {
                0
            } else {
                self.cursor.max(1)
            };
            self.first = false;
            let batch = self
                .src
                .poll(Cursor(since))
                .await
                .map_err(|e| format!("poll failed: {e}"))?;
            self.polls += 1;
            let identities = self.src.identities();
            if self.src.supports_checkpoint_delta() {
                let delta = self.src.checkpoint_delta();
                assert!(
                    delta.check_bounds().is_ok(),
                    "the adapter must stay within the per-commit delta ceiling: {}",
                    delta.row_count()
                );
                let reappeared: Vec<String> = delta
                    .upserts
                    .iter()
                    .filter(|f| self.tombstones.iter().any(|r| r.path == f.path))
                    .map(|f| f.path.clone())
                    .collect();
                if batch.items.is_empty() && delta.is_empty() && reappeared.is_empty() {
                    return Ok(None);
                }
                // Merge the delta into the full committed state (what the poller keeps in saved_map).
                let mut merged = self.saved.clone();
                for f in &delta.upserts {
                    if let Some(slot) = merged.files.iter_mut().find(|x| x.path == f.path) {
                        *slot = f.clone();
                    } else {
                        merged.files.push(f.clone());
                    }
                }
                for r in &delta.removed {
                    merged.files.retain(|x| x.path != r.path);
                }
                for (k, v) in &delta.revisions {
                    merged.revisions.insert(k.clone(), v.clone());
                }
                merged.files.sort_by(|a, b| a.path.cmp(&b.path));
                self.pending = Some(Pending {
                    items: batch.items,
                    next: batch.next.0,
                    checkpoint: merged,
                    delta: Some(delta),
                    identities,
                    removed: Vec::new(),
                    reappeared,
                });
                // Fall through to the commit below.
            } else {
                let mut checkpoint = self.src.checkpoint();
                let complete = self.src.discovery_complete();
                if !complete {
                    // Mirror the poller (`core/poller.rs`): an incomplete/failed sweep must never drop a known
                    // path from the durable checkpoint, or a later failed sweep would erase its parser state and
                    // the removal gate would have nothing left to protect.
                    let next_paths = checkpoint.paths();
                    for f in &self.saved.files {
                        if !next_paths.contains(&f.path) {
                            checkpoint.files.push(f.clone());
                        }
                    }
                }
                let (removed, reappeared) = path_changes(
                    &self.saved,
                    &checkpoint,
                    &self.tombstones,
                    complete,
                    now_ms(),
                );
                if batch.items.is_empty()
                    && checkpoint == self.saved
                    && removed.is_empty()
                    && reappeared.is_empty()
                {
                    return Ok(None);
                }
                self.pending = Some(Pending {
                    items: batch.items,
                    next: batch.next.0,
                    checkpoint,
                    delta: None,
                    identities,
                    removed,
                    reappeared,
                });
            }
        }
        let p = self.pending.take().expect("pending batch");
        let commit = match &p.delta {
            Some(delta) => self.bus.commit_delta(
                self.source_id,
                &p.items,
                delta,
                &p.reappeared,
                &p.identities,
            ),
            None => self.bus.commit(
                self.source_id,
                &p.items,
                &p.checkpoint,
                &p.removed,
                &p.reappeared,
                &p.identities,
            ),
        };
        match commit {
            Ok(events) => {
                self.cursor = p.next;
                self.saved = p.checkpoint;
                let removed: Vec<RemovedPath> = p
                    .delta
                    .as_ref()
                    .map(|d| d.removed.clone())
                    .unwrap_or_else(|| p.removed.clone());
                for r in &removed {
                    self.tombstones.retain(|t| t.path != r.path);
                    self.tombstones.push(r.clone());
                }
                for path in &p.reappeared {
                    self.tombstones.retain(|t| t.path != *path);
                }
                Ok(Some((p.items.len(), events.len())))
            }
            Err(e) => {
                // Keep the exact pending input for a retry, exactly like the poller.
                self.pending = Some(p);
                Err(format!("commit failed: {e}"))
            }
        }
    }

    /// Poll/commit until a turn produces no work (bounded, so a stuck adapter cannot hang the suite).
    async fn drain(&mut self) -> usize {
        let mut turns = 0;
        for _ in 0..64 {
            match self.turn().await.expect("turn") {
                Some(_) => turns += 1,
                None => break,
            }
        }
        turns
    }

    fn rows(&self) -> Vec<Row> {
        rows(&self.db, self.source_id)
    }

    fn steps(&self) -> Vec<(u64, Option<String>)> {
        steps(&self.db, self.source_id)
    }

    fn step_models(&self) -> Vec<Option<String>> {
        self.steps().into_iter().map(|(_, m)| m).collect()
    }

    fn durable_removed(&self) -> Vec<RemovedPath> {
        removed_rows(&self.db, self.source_id)
    }

    fn generations(&self) -> Vec<(String, u64)> {
        generation_rows(&self.db, self.source_id)
    }
}

/// Mirror of the poller's `path_changes`: only a completed discovery sweep may tombstone a path.
fn path_changes(
    saved: &SourceCheckpoint,
    next: &SourceCheckpoint,
    tombstones: &[RemovedPath],
    complete: bool,
    now: u64,
) -> (Vec<RemovedPath>, Vec<String>) {
    let saved_paths = saved.paths();
    let next_paths = next.paths();
    let removed = if complete {
        saved_paths
            .difference(&next_paths)
            .map(|p| RemovedPath {
                path: p.clone(),
                generation: saved
                    .files
                    .iter()
                    .find(|f| &f.path == p)
                    .map(|f| f.generation)
                    .unwrap_or(0),
                removed_ms: now,
            })
            .collect()
    } else {
        Vec::new()
    };
    let reappeared = next_paths
        .iter()
        .filter(|p| tombstones.iter().any(|t| &t.path == *p))
        .cloned()
        .collect();
    (removed, reappeared)
}

// ---------------------------------------------------------------------------------------------
// SQLite readers (read-only verification of the committed store output).
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Row {
    seq: u64,
    kind: String,
    session: Option<String>,
    data: Value,
    producer: Option<String>,
}

fn conn(db: &Path) -> Connection {
    let c = Connection::open(db).expect("open db for verification");
    c.busy_timeout(Duration::from_secs(5))
        .expect("busy timeout");
    c
}

fn rows(db: &Path, source: &str) -> Vec<Row> {
    let c = conn(db);
    let mut st = c
        .prepare("SELECT seq,kind,session,data,producer FROM events WHERE source=?1 ORDER BY seq")
        .expect("prepare");
    st.query_map([source], |r| {
        Ok(Row {
            seq: r.get::<_, i64>(0)? as u64,
            kind: r.get(1)?,
            session: r.get(2)?,
            data: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
            producer: r.get(4)?,
        })
    })
    .expect("query")
    .map(|r| r.expect("row"))
    .collect()
}

fn steps(db: &Path, source: &str) -> Vec<(u64, Option<String>)> {
    rows(db, source)
        .into_iter()
        .filter(|r| r.kind == "step")
        .map(|r| {
            (
                r.seq,
                r.data
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        })
        .collect()
}

fn removed_rows(db: &Path, source: &str) -> Vec<RemovedPath> {
    let c = conn(db);
    let mut st = c
        .prepare(
            "SELECT path,generation,removed_ms FROM source_removed WHERE source=?1 ORDER BY path",
        )
        .expect("prepare removed");
    st.query_map([source], |r| {
        Ok(RemovedPath {
            path: r.get(0)?,
            generation: r.get::<_, i64>(1)? as u64,
            removed_ms: r.get::<_, i64>(2)? as u64,
        })
    })
    .expect("query removed")
    .map(|r| r.expect("removed row"))
    .collect()
}

fn generation_rows(db: &Path, source: &str) -> Vec<(String, u64)> {
    let c = conn(db);
    let mut st = c
        .prepare("SELECT path,generation FROM source_generations WHERE source=?1 ORDER BY path")
        .expect("prepare generations");
    st.query_map([source], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
    })
    .expect("query generations")
    .map(|r| r.expect("generation row"))
    .collect()
}

fn producer_field(producer: &str, idx: usize) -> Option<&str> {
    producer.split('\u{1f}').nth(idx)
}

/// Logical generation of every committed `Step` row, in seq order, parsed from the producer identity.
fn step_generations(db: &Path, source: &str) -> Vec<u64> {
    rows(db, source)
        .into_iter()
        .filter(|r| r.kind == "step")
        .filter_map(|r| r.producer)
        .map(|p| {
            producer_field(&p, 2)
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| panic!("offset identity without a generation: {p}"))
        })
        .collect()
}

fn event_count(db: &Path, source: &str) -> usize {
    conn(db)
        .query_row(
            "SELECT COUNT(*) FROM events WHERE source=?1",
            [source],
            |r| r.get::<_, i64>(0),
        )
        .expect("count") as usize
}

fn file_state_rows(db: &Path, source: &str) -> Vec<(String, u64, u64, u64, Option<String>)> {
    let c = conn(db);
    let mut st = c
        .prepare(
            "SELECT path,offset,size,generation,revision FROM source_file_state WHERE source=?1 ORDER BY path",
        )
        .expect("prepare file state");
    st.query_map([source], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, i64>(3)? as u64,
            r.get(4)?,
        ))
    })
    .expect("query file state")
    .map(|r| r.expect("file state row"))
    .collect()
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers.
// ---------------------------------------------------------------------------------------------

fn inode(path: &Path) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).expect("metadata").ino()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        0
    }
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).expect("metadata").len()
}

fn set_mtime_hours_from_now(path: &Path, hours: u64) {
    let t = SystemTime::now() + Duration::from_secs(hours * 3600 + 1);
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("open for mtime")
        .set_modified(t)
        .expect("set mtime");
}

fn claude_home(home: &Path) -> PathBuf {
    home.join(".claude/projects/-oracle")
}

fn fixture_home() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude-code/2.0/home")
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).expect("mkdir");
    for e in std::fs::read_dir(src).expect("read fixture dir").flatten() {
        let to = dst.join(e.file_name());
        if e.file_type().expect("file type").is_dir() {
            copy_dir(&e.path(), &to);
        } else {
            std::fs::copy(e.path(), &to).expect("copy fixture");
        }
    }
}

/// `(byte offset of the line start, parsed json)` for every complete line of a fixture file.
fn jsonl_lines(path: &Path) -> Vec<(u64, Value)> {
    let bytes = std::fs::read(path).expect("read jsonl");
    let mut out = Vec::new();
    let mut start = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes[start..i]) {
                out.push((start as u64, v));
            }
            start = i + 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Tests: positive independent oracle on the recorded fixture home.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn fixture_home_positive_oracle_stores_expected_contents_and_offsets() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    copy_dir(&fixture_home(), &home);
    let demo =
        home.join(".claude/projects/-work-demo-app/7f3c2a1e-0b4d-4c8e-9a51-2d6f0e8b1c33.jsonl");
    let other =
        home.join(".claude/projects/-work-other/1b2e3d4c-5a69-4788-9900-aabbccddeeff.jsonl");

    let mut o = Oracle::with_home(tmp, home.clone(), claude_adapter, "claude-code");
    let det = o.src.detect(&Env {
        home: home.clone(),
        vars: Default::default(),
    });
    assert!(
        matches!(det, agentglimd::core::Detection::Detected { .. }),
        "recorded fixture home must be detected as a supported Claude Code layout: {det:?}"
    );
    o.drain().await;
    let events_before_restart = event_count(&o.db, "claude-code");
    o.restart(claude_adapter);
    o.drain().await;
    assert_eq!(
        event_count(&o.db, "claude-code"),
        events_before_restart,
        "a second pass over the unchanged fixture home must commit no observation"
    );

    let rows = o.rows();
    assert_eq!(rows.len(), 12, "hand-counted stored rows: {rows:#?}");
    let session_rows: Vec<&Option<String>> = rows
        .iter()
        .filter(|r| r.kind == "session")
        .map(|r| &r.session)
        .collect();
    assert_eq!(
        session_rows.len(),
        2,
        "two session headers, one per transcript file"
    );
    assert!(
        session_rows.iter().all(|s| s.is_some()),
        "session headers carry the producer session id"
    );

    // Step expectations derived by hand from the fixture JSONL: the summary line and the unterminated
    // trailing line map to nothing; every user/assistant record maps to one Step.
    let mut expected_steps = 0usize;
    for path in [&demo, &other] {
        for (_, v) in jsonl_lines(path) {
            let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
            if ty == "user" || ty == "assistant" {
                expected_steps += 1;
            }
        }
    }
    let got_steps = o.steps();
    assert_eq!(
        got_steps.len(),
        expected_steps,
        "committed Step values: {got_steps:#?}"
    );

    // Values, not just counts: the model sequence per session.
    let demo_models: Vec<Option<String>> = rows
        .iter()
        .filter(|r| r.kind == "step")
        .filter(|r| {
            r.session
                .as_deref()
                .map(|s| s == "7f3c2a1e-0b4d-4c8e-9a51-2d6f0e8b1c33")
                .unwrap_or(false)
        })
        .map(|r| {
            r.data
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        demo_models,
        vec![
            None,
            Some("claude-sonnet-4-5".to_string()),
            None,
            Some("claude-sonnet-4-5".to_string())
        ]
    );
    let other_models: Vec<Option<String>> = rows
        .iter()
        .filter(|r| r.kind == "step")
        .filter(|r| {
            r.session
                .as_deref()
                .map(|s| s == "1b2e3d4c-5a69-4788-9900-aabbccddeeff")
                .unwrap_or(false)
        })
        .map(|r| {
            r.data
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        other_models,
        vec![None, Some("claude-opus-4-1".to_string())],
        "the invalid line must be an Error, not a Step"
    );
    assert_eq!(
        rows.iter().filter(|r| r.kind == "error").count(),
        1,
        "exactly one malformed-line Error"
    );
    assert_eq!(
        rows.iter().filter(|r| r.kind == "spend").count(),
        3,
        "three usage rows (two in the demo transcript, one in -work-other)"
    );

    // Producer identities are anchored on the committed content position (byte offset of the line
    // start), independently re-derived from the fixture bytes; this is not a batch index.
    let expected_offsets: Vec<(u64, String)> = {
        let mut v = Vec::new();
        for (path, session) in [
            (&demo, "7f3c2a1e-0b4d-4c8e-9a51-2d6f0e8b1c33"),
            (&other, "1b2e3d4c-5a69-4788-9900-aabbccddeeff"),
        ] {
            for (off, line) in jsonl_lines(path) {
                let ty = line.get("type").and_then(Value::as_str).unwrap_or("");
                if ty == "user" || ty == "assistant" {
                    v.push((off, session.to_string()));
                }
            }
        }
        v
    };
    let mut step_offsets = Vec::new();
    for r in rows.iter().filter(|r| r.kind == "step") {
        let producer = r
            .producer
            .as_deref()
            .expect("every committed Step has a producer key");
        assert_eq!(
            producer_field(producer, 0),
            Some("off"),
            "offset identity kind"
        );
        let rel = producer_field(producer, 1).expect("path field");
        assert!(rel.ends_with(".jsonl"), "identity path: {rel}");
        assert_eq!(
            producer_field(producer, 2),
            Some("1"),
            "first observation generation is 1, not an inode/time value: {producer}"
        );
        let pos: u64 = producer_field(producer, 3)
            .and_then(|v| v.parse().ok())
            .expect("position field");
        step_offsets.push((pos, r.session.clone().unwrap_or_default()));
    }
    assert_eq!(
        step_offsets, expected_offsets,
        "producer positions must equal the byte offsets of the mapped JSONL lines"
    );

    // The unterminated trailing line is not consumed: the persisted cursor stops at the last newline.
    let partial_demo = std::fs::read(&demo).expect("read");
    let last_nl = partial_demo
        .iter()
        .rposition(|b| *b == b'\n')
        .expect("demo fixture has newlines") as u64
        + 1;
    let state = file_state_rows(&o.db, "claude-code");
    let demo_row = state
        .iter()
        .find(|(p, ..)| p.ends_with("7f3c2a1e-0b4d-4c8e-9a51-2d6f0e8b1c33.jsonl"))
        .expect("demo file state");
    assert_eq!(
        demo_row.1, last_nl,
        "offset stops before the partial trailing line"
    );
    assert_eq!(demo_row.3, 1, "one durable logical generation");

    // Global seq is monotonic and unique in commit order.
    let seqs: Vec<u64> = rows.iter().map(|r| r.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(seqs, sorted, "seq must be monotonic in commit order");
}

// ---------------------------------------------------------------------------------------------
// Tests: same-inode equal-size rewrites (the D03 producer-key collision).
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn same_inode_equal_size_rewrite_stores_both_revisions() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let dir = claude_home(&o.home);
    let file = dir.join("s.jsonl");
    let a = claude_line("model-a");
    let b = claude_line("model-b");
    assert_eq!(a.len(), b.len(), "A and B must be equal length");
    o.write(&file, &a);
    let (ino_a, len_a) = (inode(&file), file_len(&file));
    assert!(o.turn().await.is_ok());
    assert_eq!(o.steps().len(), 1);

    let (ino_b, len_b) = o.rewrite_in_place(&file, &b, 2);
    assert_eq!(ino_a, ino_b, "rewrite must stay on the same inode");
    assert_eq!(len_a, len_b, "rewrite must keep the same size");
    o.turn().await.expect("B commit");

    assert_eq!(
        o.step_models(),
        vec![Some("model-a".to_string()), Some("model-b".to_string())],
        "the B revision must be committed as a distinct observation"
    );
    assert_eq!(
        step_generations(&o.db, "claude-code"),
        vec![1, 2],
        "Step identities: A in generation 1, B in generation 2"
    );
    let producers: Vec<String> = o.rows().into_iter().filter_map(|r| r.producer).collect();
    let mut unique = producers.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        producers.len(),
        "producer keys must not collide: {producers:?}"
    );
    assert_eq!(
        o.generations(),
        vec![("-oracle/s.jsonl".to_string(), 2)],
        "store generation high-water follows the proven replacement"
    );
    assert_eq!(o.drain().await, 0, "a later pass over consumed B is silent");

    // The per-file checkpoint recorded the new generation and a full-content revision hash.
    let st = file_state_rows(&o.db, "claude-code");
    assert_eq!(st[0].3, 2);
    assert!(
        st[0].4.is_some(),
        "suffix verification needs a durable content hash"
    );
}

#[tokio::test]
async fn a_b_a_across_serialized_checkpoint_restart_keeps_all_three_revisions() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("s.jsonl");
    let a = claude_line("model-a");
    let b = claude_line("model-b");
    assert_eq!(a.len(), b.len());

    o.write(&file, &a);
    o.turn().await.expect("A");
    o.restart(claude_adapter);
    o.rewrite_in_place(&file, &b, 2);
    o.turn().await.expect("B");
    o.restart(claude_adapter);
    o.rewrite_in_place(&file, &a, 4);
    o.turn().await.expect("A again");
    o.restart(claude_adapter);
    assert_eq!(
        o.drain().await,
        0,
        "restored latest A checkpoint must be silent"
    );

    assert_eq!(
        o.step_models(),
        vec![
            Some("model-a".to_string()),
            Some("model-b".to_string()),
            Some("model-a".to_string())
        ],
        "A -> B -> A must keep three distinct committed revisions"
    );
    assert_eq!(
        step_generations(&o.db, "claude-code"),
        vec![1, 2, 3],
        "generations are monotonic and never reused"
    );
    let keys: Vec<String> = o.rows().into_iter().filter_map(|r| r.producer).collect();
    let mut dedup = keys.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(
        dedup.len(),
        keys.len(),
        "A and B identities must differ: {keys:?}"
    );
    assert_eq!(
        o.generations(),
        vec![("-oracle/s.jsonl".to_string(), 3)],
        "durable generation high-water survives the checkpoints"
    );
    let seqs: Vec<u64> = o.rows().iter().map(|r| r.seq).collect();
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "seq strictly increases: {seqs:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Tests: suffix edits beyond byte 256 (D06), live and restored.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn suffix_beyond_256_same_size_edit_detected_live_and_after_restore() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("suffix.jsonl");
    let a = claude_suffix_line("TAILAAAA");
    let b = claude_suffix_line("TAILBBBB");
    let c = claude_suffix_line("TAILCCCC");
    assert_eq!(a.len(), b.len());
    assert_eq!(b.len(), c.len());
    assert!(a.len() > 600, "the distinguishing token sits past byte 256");
    assert_eq!(
        &a.as_bytes()[..256],
        &b.as_bytes()[..256],
        "the sampled 256-byte prefix is identical"
    );

    o.write(&file, &a);
    o.turn().await.expect("A");
    assert_eq!(o.step_models(), vec![Some("TAILAAAA".to_string())]);

    // Live same-size suffix edit with a changed mtime.
    o.rewrite_in_place(&file, &b, 2);
    o.turn().await.expect("B");
    assert_eq!(
        o.step_models(),
        vec![Some("TAILAAAA".to_string()), Some("TAILBBBB".to_string())],
        "a changed suffix with a changed mtime must be committed, not suppressed"
    );

    // After a serialized-checkpoint restart, a second suffix edit must be detected as well.
    o.restart(claude_adapter);
    o.rewrite_in_place(&file, &c, 4);
    o.turn().await.expect("C");
    assert_eq!(
        o.step_models(),
        vec![
            Some("TAILAAAA".to_string()),
            Some("TAILBBBB".to_string()),
            Some("TAILCCCC".to_string())
        ],
        "restored checkpoints keep the durable content hash used for suffix verification"
    );
    assert_eq!(step_generations(&o.db, "claude-code"), vec![1, 2, 3]);
    assert_eq!(
        o.drain().await,
        0,
        "no re-emission after the suffix revisions are consumed"
    );
}

// ---------------------------------------------------------------------------------------------
// Tests: unchanged restart/touch stay silent; truncation, rename, partition, removal.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn unchanged_restart_and_metadata_touch_are_silent() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("s.jsonl");
    o.write(&file, &claude_line("model-a"));
    o.turn().await.expect("A");
    let before = o.steps();
    assert_eq!(before.len(), 1);
    let gen_before = file_state_rows(&o.db, "claude-code")[0].3;

    o.restart(claude_adapter);
    assert_eq!(o.drain().await, 0, "unchanged restart must commit nothing");

    set_mtime_hours_from_now(&file, 3);
    o.turn().await.expect("touch");
    assert_eq!(
        o.steps(),
        before,
        "a metadata-only touch must not replay content"
    );
    let st = file_state_rows(&o.db, "claude-code")[0].clone();
    assert_eq!(
        st.3, gen_before,
        "a metadata-only touch keeps the logical generation"
    );
    assert_eq!(
        o.generations(),
        vec![("-oracle/s.jsonl".to_string(), gen_before)],
        "a touch must not raise the generation high-water"
    );
}

#[tokio::test]
async fn truncation_and_reappend_keep_the_intended_revisions() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("s.jsonl");
    o.write(&file, &(claude_line("m-one") + &claude_line("m-two")));
    o.turn().await.expect("A");
    assert_eq!(o.steps().len(), 2);

    // Truncate to a shorter, different content.
    o.rewrite_in_place(&file, &claude_line("m-trunc"), 2);
    o.turn().await.expect("truncate");
    // Then append a new complete line to the truncated file.
    let appended = claude_line("m-trunc") + &claude_line("m-app");
    o.write(&file, &appended);
    set_mtime_hours_from_now(&file, 3);
    o.turn().await.expect("append");

    assert_eq!(
        o.step_models(),
        vec![
            Some("m-one".to_string()),
            Some("m-two".to_string()),
            Some("m-trunc".to_string()),
            Some("m-app".to_string())
        ],
        "truncate must replace; the following append keeps its own revision"
    );
    assert_eq!(
        step_generations(&o.db, "claude-code"),
        vec![1, 1, 2, 2],
        "two A steps in generation 1; truncated content and its append in generation 2"
    );
    assert_eq!(o.drain().await, 0);
}

#[tokio::test]
async fn atomic_rename_with_new_inode_stores_a_new_revision() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let dir = claude_home(&o.home);
    let file = dir.join("s.jsonl");
    o.write(&file, &claude_line("model-a"));
    let ino_a = inode(&file);
    o.turn().await.expect("A");

    let staged = dir.join("staged.tmp");
    o.write(&staged, &claude_line("model-b"));
    assert_eq!(file_len(&staged), file_len(&file));
    std::fs::rename(&staged, &file).expect("atomic replace");
    assert_ne!(ino_a, inode(&file), "rename must install a new inode");
    set_mtime_hours_from_now(&file, 2);
    o.turn().await.expect("replace");

    assert_eq!(
        o.step_models(),
        vec![Some("model-a".to_string()), Some("model-b".to_string())],
        "an atomically replaced file is a new revision"
    );
    assert_eq!(step_generations(&o.db, "claude-code"), vec![1, 2]);
}

#[tokio::test]
async fn partitioned_batches_drain_fairly_with_exact_keys() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("bulk.jsonl");
    // MAX_LINES_PER_SOURCE_PASS is 5000, so 5,100 lines force at least two bounded passes/polls.
    let models: Vec<String> = (0..5_100).map(|i| format!("m-{i:04}")).collect();
    let content: String = models.iter().map(|m| claude_line(m)).collect();
    o.write(&file, &content);
    let turns = o.drain().await;
    assert!(
        turns >= 2,
        "5,100 lines must be split across bounded passes (got {turns})"
    );

    let steps = o.steps();
    assert_eq!(steps.len(), 5_100, "every line commits exactly once");
    assert_eq!(
        steps
            .into_iter()
            .map(|(_, m)| m.expect("every Step row carries a model in this synthetic file"))
            .collect::<Vec<_>>(),
        models,
        "committed values preserve file order across partitioned batches"
    );
    let producers: Vec<String> = o.rows().into_iter().filter_map(|r| r.producer).collect();
    let mut unique = producers.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        producers.len(),
        "partitioning must not reuse identities"
    );
    assert!(
        step_generations(&o.db, "claude-code")
            .iter()
            .all(|g| *g == 1),
        "ordinary appends inside one file keep one logical generation"
    );
    assert_eq!(o.drain().await, 0);
}

#[tokio::test]
async fn removed_path_is_tombstoned_only_when_absent_and_reappears_with_a_new_generation() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("s.jsonl");
    o.write(&file, &claude_line("model-a"));
    o.turn().await.expect("A");
    assert_eq!(o.steps().len(), 1);

    // Remove the path, then restart so discovery runs immediately (the adapter's rediscovery timer
    // otherwise defers a sweep for 15 s).
    std::fs::remove_file(&file).expect("remove synthetic file");
    o.restart(claude_adapter);
    o.turn().await.expect("removal sweep");
    let removed = o.durable_removed();
    assert_eq!(
        removed.len(),
        1,
        "a complete sweep tombstones the missing path: {removed:?}"
    );
    assert_eq!(
        removed[0].generation, 1,
        "the tombstone keeps the removed logical generation"
    );
    assert!(
        o.saved.files.is_empty(),
        "the removed path must leave the live checkpoint"
    );

    // Reappearance with different content must not recycle the removed generation.
    o.write(&file, &claude_line("model-b"));
    set_mtime_hours_from_now(&file, 2);
    o.restart(claude_adapter);
    o.turn().await.expect("reappearance");
    assert!(
        o.durable_removed().is_empty(),
        "reappearance clears the tombstone"
    );
    assert_eq!(
        o.step_models(),
        vec![Some("model-a".to_string()), Some("model-b".to_string())],
        "the reappeared path must be observed again"
    );
    assert_eq!(
        step_generations(&o.db, "claude-code"),
        vec![1, 2],
        "a reappearing path gets a generation above the stored high-water"
    );
}

#[tokio::test]
async fn incomplete_discovery_never_prematurely_removes_a_path() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let dir = claude_home(&o.home);
    // 450 files: discovery is bounded to 200 entries per pass, so a full sweep takes several passes.
    for i in 0..450 {
        let p = dir.join(format!("f{i:03}.jsonl"));
        o.write(&p, &claude_line(&format!("m-{i:03}")));
    }
    // Drive the bounded sweep to completion: resumable discovery progress is adapter-private until the
    // reconciling pass, so tick the poller-style turns until the checkpoint reports the whole tree.
    let mut initial_passes = 0;
    for _ in 0..12 {
        o.turn().await.expect("sweep pass");
        initial_passes += 1;
        if o.saved.paths().len() == 450 {
            break;
        }
    }
    assert_eq!(
        o.saved.paths().len(),
        450,
        "initial bounded sweep reports every path"
    );
    assert!(
        initial_passes >= 2,
        "a 450-entry tree cannot be discovered in one bounded pass (took {initial_passes})"
    );
    assert!(o.durable_removed().is_empty());

    // A path that the previous complete sweep reported is deleted, and a new bounded sweep starts after a
    // restart (the adapter defers rediscovery by 15 s otherwise, and a restart resets that timer).
    let victim = dir.join("f000.jsonl");
    std::fs::remove_file(&victim).expect("remove reported path");
    o.restart(claude_adapter);
    o.turn().await.expect("first pass of the new sweep");
    let complete_after_partial_sweep = o.src.discovery_complete();
    assert!(
        o.durable_removed().is_empty(),
        "an unfinished sweep must not tombstone a path whose absence was not proven: {:?}",
        o.durable_removed()
    );
    assert_eq!(
        o.saved.paths().len(),
        450,
        "an unfinished sweep must keep the prior parser state for every reported path"
    );

    // Finish the sweep; only a completed sweep may reconcile the proven-absent path.
    let mut further_passes = 0;
    for _ in 0..12 {
        o.turn().await.expect("sweep continuation");
        further_passes += 1;
        if o.saved.paths().len() == 449 {
            break;
        }
        assert!(
            o.durable_removed().is_empty(),
            "no tombstone until the sweep completes: {:?}",
            o.durable_removed()
        );
        assert_eq!(o.saved.paths().len(), 450, "prior paths retained mid-sweep");
    }
    assert!(
        further_passes >= 2,
        "the deleted path can only be reconciled after the remaining bounded passes"
    );
    let removed = o.durable_removed();
    assert_eq!(
        removed.len(),
        1,
        "only the proven-absent path is removed: {removed:?}"
    );
    assert!(removed[0].path.ends_with("f000.jsonl"));
    assert_eq!(
        o.saved.paths().len(),
        449,
        "all other paths stay in the checkpoint"
    );
    // Contract check (T01 NOTES: core gates tombstones on this signal). The behavioural part above already
    // holds because the adapter only reconciles a completed sweep, but the poller still needs the honest
    // signal: see the T03 request in _build/NOTES.md.
    assert!(
        !complete_after_partial_sweep,
        "Source::discovery_complete() must be false while a bounded discovery sweep is unfinished; \
         the trait default (true) makes the poller's removal gate blind (requested in _build/NOTES.md)"
    );
}

// ---------------------------------------------------------------------------------------------
// Tests: failure/retry of the exact pending input.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn failed_commit_keeps_pending_input_and_commits_once_on_retry() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("s.jsonl");
    o.write(&file, &claude_line("model-a"));

    conn(&o.db)
        .execute_batch(FAIL_TRIGGER)
        .expect("install fail trigger");
    let err = o
        .turn()
        .await
        .expect_err("the injected file-state failure must abort the commit");
    assert!(err.contains("commit failed"), "unexpected error: {err}");
    assert_eq!(o.polls, 1);
    assert_eq!(
        event_count(&o.db, "claude-code"),
        0,
        "a failed commit stores no event"
    );
    assert_eq!(o.bus.last_seq(), 0, "a failed commit consumes no seq");
    assert!(
        file_state_rows(&o.db, "claude-code").is_empty(),
        "a failed commit stores no parser state"
    );
    assert!(
        generation_rows(&o.db, "claude-code").is_empty(),
        "a failed commit stores no generation high-water"
    );

    conn(&o.db)
        .execute_batch("DROP TRIGGER inject_fail;")
        .expect("drop fail trigger");
    o.turn().await.expect("retry the identical pending input");
    assert_eq!(
        o.polls, 1,
        "the retry must commit the kept pending batch, not re-poll"
    );
    assert_eq!(o.steps().len(), 1, "the retried input commits exactly once");
    assert_eq!(o.rows()[0].seq, 1, "first committed seq is 1");
    assert_eq!(
        o.drain().await,
        0,
        "nothing is duplicated after the successful retry"
    );
}

// ---------------------------------------------------------------------------------------------
// Tests: the other three JSONL source formats share the same generation contract.
// ---------------------------------------------------------------------------------------------

async fn family_rewrite_case(
    make: fn(&Path) -> Box<dyn Source>,
    id: &'static str,
    rel: &str,
    a: String,
    b: String,
    marker: fn(&Value) -> Option<String>,
) {
    let mut o = Oracle::new(make, id);
    let file = o.home.join(rel);
    assert_eq!(a.len(), b.len(), "{id}: A and B must be equal length");
    o.write(&file, &a);
    let ino_a = inode(&file);
    o.turn().await.expect("A");
    assert_eq!(o.steps().len(), 1, "{id}: first revision committed");

    let (ino_b, _) = o.rewrite_in_place(&file, &b, 2);
    assert_eq!(ino_a, ino_b, "{id}: rewrite stays on the same inode");
    o.turn().await.expect("B");

    let markers: Vec<Option<String>> = o
        .rows()
        .into_iter()
        .filter(|r| r.kind == "step")
        .map(|r| marker(&r.data))
        .collect();
    assert_eq!(
        markers.len(),
        2,
        "{id}: the equal-size rewrite must commit a second revision: {markers:?}"
    );
    assert_ne!(markers[0], markers[1], "{id}: committed values must differ");
    assert_eq!(
        step_generations(&o.db, id),
        vec![1, 2],
        "{id}: second logical generation for the rewrite"
    );
}

#[tokio::test]
async fn jsonl_family_equal_size_rewrite_keeps_both_revisions() {
    // Codex: the marker is the record timestamp (the adapter's Step data carries no text field).
    family_rewrite_case(
        codex_adapter,
        "codex",
        ".codex/sessions/2026/10/30/rollout-2026-10-30T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl",
        codex_line("2026-10-30T10:00:01.000Z"),
        codex_line("2026-10-30T10:00:02.000Z"),
        |d| d.get("ts").and_then(Value::as_str).map(str::to_string),
    )
    .await;
    // Agy: the marker is the model id.
    family_rewrite_case(
        agy_adapter,
        "agy",
        ".gemini/antigravity-cli/brain/conv-1/.system_generated/logs/transcript.jsonl",
        agy_line("model-a"),
        agy_line("model-b"),
        |d| d.get("model").and_then(Value::as_str).map(str::to_string),
    )
    .await;
    // Pi: the marker is the model id.
    family_rewrite_case(
        pi_adapter,
        "pi",
        ".pi/agent/sessions/--work-demo-app--/2026-10-31T09-00-00-000Z_5e2f7a90-1c3d-4b6e-8f01-a2b3c4d5e6f7.jsonl",
        pi_line("model-a"),
        pi_line("model-b"),
        |d| d.get("model").and_then(Value::as_str).map(str::to_string),
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// Tests: the real poller loop (owned in-process, no server, no fixed port).
// ---------------------------------------------------------------------------------------------

fn spawn_source_poller(
    db: &Path,
    home: &Path,
) -> (
    tokio::sync::watch::Sender<bool>,
    tokio::sync::watch::Sender<u64>,
    tokio::task::JoinHandle<()>,
) {
    let store = Store::open(db).expect("reopen store");
    let bus = Arc::new(Bus::new(store.clone()).expect("bus"));
    let sources: Arc<Vec<Arc<dyn Source>>> =
        Arc::new(vec![
            Arc::new(agentglimd::adapters::claude_code::ClaudeCode::new(
                None, home, 30,
            )) as Arc<dyn Source>,
        ]);
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let (refresh_tx, refresh_rx) = tokio::sync::watch::channel(0u64);
    let handle = spawn_poller(
        PollerDeps {
            store,
            bus,
            sources,
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: Env {
                home: home.to_path_buf(),
                vars: Default::default(),
            },
            intervals: Intervals {
                poll: Duration::from_millis(50),
                discover: Duration::from_millis(100),
            },
            refresh: refresh_rx,
        },
        stop_rx,
    );
    (stop_tx, refresh_tx, handle)
}

async fn wait_for_model(db: &Path, model: &str, within: Duration) -> bool {
    let deadline = std::time::Instant::now() + within;
    while std::time::Instant::now() < deadline {
        let found = steps(db, "claude-code")
            .iter()
            .any(|(_, m)| m.as_deref() == Some(model));
        if found {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

#[tokio::test]
async fn real_poller_loop_restart_detects_same_size_rewrite() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).expect("data");
    let db = data.join("state.db");
    let file = claude_home(&home).join("s.jsonl");
    std::fs::create_dir_all(file.parent().unwrap()).expect("dirs");
    let a = claude_line("model-a");
    let b = claude_line("model-b");
    assert_eq!(a.len(), b.len());
    std::fs::write(&file, &a).expect("write A");

    let (stop, _refresh, handle) = spawn_source_poller(&db, &home);
    let saw_a = tokio::time::timeout(
        Duration::from_secs(15),
        wait_for_model(&db, "model-a", Duration::from_secs(14)),
    )
    .await
    .expect("poller did not store A within the deadline");
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    assert!(saw_a, "the real poller must commit the first revision");

    // Same-inode equal-size rewrite while the poller is down.
    let ino_a = inode(&file);
    std::fs::write(&file, &b).expect("write B");
    set_mtime_hours_from_now(&file, 2);
    assert_eq!(ino_a, inode(&file));
    assert_eq!(file_len(&file), a.len() as u64);

    let (stop2, _refresh2, handle2) = spawn_source_poller(&db, &home);
    let saw_b = tokio::time::timeout(
        Duration::from_secs(15),
        wait_for_model(&db, "model-b", Duration::from_secs(14)),
    )
    .await
    .expect("poller did not store B within the deadline");
    let _ = stop2.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle2).await;
    assert!(
        saw_b,
        "restart must not lose the equal-size rewrite (v3 dropped it)"
    );

    assert_eq!(
        steps(&db, "claude-code")
            .into_iter()
            .map(|(_, m)| m)
            .collect::<Vec<_>>(),
        vec![Some("model-a".to_string()), Some("model-b".to_string())],
        "both revisions survive a real poller restart"
    );
    let seqs: Vec<u64> = rows(&db, "claude-code").iter().map(|r| r.seq).collect();
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "seq stays monotonic across the restart: {seqs:?}"
    );
    assert_eq!(step_generations(&db, "claude-code"), vec![1, 2]);
}

// ---------------------------------------------------------------------------------------------
// v4-r2: B1 — an append followed by a metadata-only touch or an unchanged serialized restart.
//
// The r1 audit (B1) reproduced a stale full-content witness here: after an append the adapter kept the
// pre-append hash, so the next touch/restart compared the *whole current file* against that stale hash,
// declared a replacement and replayed every old record. The Store must stay exactly `[A,B]`, with no new
// sequence, producer key or logical generation, on the final no-op turn.
// ---------------------------------------------------------------------------------------------

/// Append to a file the way a live transcript grows (no size-preserving rewrite).
fn append_to(path: &Path, bytes: &str) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open for append");
    f.write_all(bytes.as_bytes()).expect("append bytes");
    f.sync_all().expect("sync appended bytes");
}

/// A supported Claude Code record padded to exactly `total` bytes; the model token sits after byte 256, so a
/// 256-byte prefix sample can never see a same-size edit.
fn claude_padded_line(total: usize, model: &str) -> String {
    let empty = format!(
        r#"{{"type":"assistant","sessionId":"{SID}","pad":"","message":{{"role":"assistant","model":"{model}"}},"timestamp":"{TS}"}}"#
    ) + "\n";
    assert!(
        total > empty.len() + 300,
        "total {total} must exceed the {}-byte base plus padding",
        empty.len()
    );
    let pad = "x".repeat(total - empty.len());
    let line = format!(
        r#"{{"type":"assistant","sessionId":"{SID}","pad":"{pad}","message":{{"role":"assistant","model":"{model}"}},"timestamp":"{TS}"}}"#
    ) + "\n";
    assert_eq!(line.len(), total, "padded record length");
    assert!(
        line.find(model).expect("model token") > 256,
        "the model token must sit beyond the 256-byte prefix sample"
    );
    line
}

/// Committed-state snapshot used to prove a no-op turn changed nothing (B1).
struct Snapshot {
    events: usize,
    seqs: Vec<u64>,
    generations: Vec<(String, u64)>,
    producers: Vec<String>,
}

fn snapshot_of(o: &Oracle) -> Snapshot {
    Snapshot {
        events: event_count(&o.db, o.source_id),
        seqs: o.rows().iter().map(|r| r.seq).collect(),
        generations: o.generations(),
        producers: o.rows().into_iter().filter_map(|r| r.producer).collect(),
    }
}

#[tokio::test]
async fn append_then_metadata_touch_keeps_exactly_a_b() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("append-touch.jsonl");
    let a = claude_line("append-a");
    let b = claude_line("append-b");

    o.write(&file, &a);
    o.turn().await.expect("commit A").expect("A work");
    assert_eq!(o.step_models(), vec![Some("append-a".to_string())]);

    append_to(&file, &b);
    o.turn().await.expect("commit B").expect("B work");
    assert_eq!(
        o.step_models(),
        vec![Some("append-a".to_string()), Some("append-b".to_string())],
        "an ordinary append commits exactly one new record"
    );
    let before = snapshot_of(&o);
    assert_eq!(
        before.events,
        3,
        "session A + step A + step B: {:#?}",
        o.rows()
    );

    // The audit's B1 sequence: metadata-only touch after the append.
    set_mtime_hours_from_now(&file, 3);
    assert_eq!(
        o.turn().await.expect("touch turn"),
        None,
        "a metadata-only touch must produce no batch and no commit"
    );
    let after = snapshot_of(&o);
    assert_eq!(
        o.step_models(),
        vec![Some("append-a".to_string()), Some("append-b".to_string())],
        "a touch after an append must not replay the pre-append records (r1 B1)"
    );
    assert_eq!(
        after.events, before.events,
        "touch must not commit a new event"
    );
    assert_eq!(
        after.seqs, before.seqs,
        "touch must not advance the event sequence"
    );
    assert_eq!(
        after.generations, before.generations,
        "touch must not raise the logical generation high-water"
    );
    assert_eq!(
        after.producers, before.producers,
        "touch must not add producer keys"
    );
    let st = file_state_rows(&o.db, "claude-code");
    assert_eq!(st.len(), 1);
    assert_eq!(st[0].3, 1, "an append + touch keeps generation 1");
}

#[tokio::test]
async fn append_then_serialized_restart_keeps_exactly_a_b() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("append-restart.jsonl");
    let a = claude_line("restart-a");
    let b = claude_line("restart-b");

    o.write(&file, &a);
    o.turn().await.expect("commit A").expect("A work");
    append_to(&file, &b);
    o.turn().await.expect("commit B").expect("B work");
    assert_eq!(
        o.step_models(),
        vec![Some("restart-a".to_string()), Some("restart-b".to_string())]
    );
    let before = snapshot_of(&o);

    // Complete checkpoint serialization, adapter discarded, unchanged file tree.
    o.restart(claude_adapter);
    assert_eq!(
        o.drain().await,
        0,
        "an unchanged serialized restart after an append must be silent (r1 B1)"
    );
    let after = snapshot_of(&o);
    assert_eq!(
        o.step_models(),
        vec![Some("restart-a".to_string()), Some("restart-b".to_string())],
        "the restored checkpoint must not replay the pre-append records"
    );
    assert_eq!(
        after.events, before.events,
        "restart must not commit extra events"
    );
    assert_eq!(
        after.seqs, before.seqs,
        "restart must not advance the sequence"
    );
    assert_eq!(
        after.generations, before.generations,
        "restart must not raise the generation high-water"
    );
    assert_eq!(
        after.producers, before.producers,
        "restart must not add producer keys"
    );
}

/// The same append -> touch -> restart sequence for Codex, Agy and Pi (Claude is covered above).
async fn family_append_touch_restart_case(
    make: fn(&Path) -> Box<dyn Source>,
    id: &'static str,
    rel: &str,
    a: String,
    b: String,
    marker: fn(&Value) -> Option<String>,
) {
    let mut o = Oracle::new(make, id);
    let file = o.home.join(rel);
    o.write(&file, &a);
    o.turn().await.expect("A").expect("A work");
    assert_eq!(o.steps().len(), 1, "{id}: first record committed");

    append_to(&file, &b);
    o.turn().await.expect("B").expect("B work");
    let markers: Vec<Option<String>> = o
        .rows()
        .into_iter()
        .filter(|r| r.kind == "step")
        .map(|r| marker(&r.data))
        .collect();
    assert_eq!(
        markers.len(),
        2,
        "{id}: append commits one record: {markers:?}"
    );
    assert_ne!(markers[0], markers[1], "{id}: appended value differs");

    let count = event_count(&o.db, id);
    let seqs: Vec<u64> = o.rows().iter().map(|r| r.seq).collect();
    let gens = o.generations();
    set_mtime_hours_from_now(&file, 3);
    assert_eq!(
        o.turn().await.expect("touch"),
        None,
        "{id}: touch after append is a no-op"
    );
    o.restart(make);
    assert_eq!(o.drain().await, 0, "{id}: unchanged restart is silent");
    assert_eq!(event_count(&o.db, id), count, "{id}: no extra events");
    assert_eq!(
        o.rows().iter().map(|r| r.seq).collect::<Vec<_>>(),
        seqs,
        "{id}: no sequence advance"
    );
    assert_eq!(o.generations(), gens, "{id}: no generation advance");
    let markers_after: Vec<Option<String>> = o
        .rows()
        .into_iter()
        .filter(|r| r.kind == "step")
        .map(|r| marker(&r.data))
        .collect();
    assert_eq!(
        markers_after, markers,
        "{id}: exactly the two appended records"
    );
}

#[tokio::test]
async fn jsonl_family_append_touch_and_restart_keep_exactly_two_revisions() {
    family_append_touch_restart_case(
        codex_adapter,
        "codex",
        ".codex/sessions/2026/10/31/rollout-2026-10-31T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl",
        codex_line("2026-10-31T10:00:01.000Z"),
        codex_line("2026-10-31T10:00:02.000Z"),
        |d| d.get("ts").and_then(Value::as_str).map(str::to_string),
    )
    .await;
    family_append_touch_restart_case(
        agy_adapter,
        "agy",
        ".gemini/antigravity-cli/brain/conv-2/.system_generated/logs/transcript.jsonl",
        agy_line("model-a"),
        agy_line("model-b"),
        |d| d.get("model").and_then(Value::as_str).map(str::to_string),
    )
    .await;
    family_append_touch_restart_case(
        pi_adapter,
        "pi",
        ".pi/agent/sessions/--work-demo-app--/2026-10-31T09-00-00-000Z_5e2f7a90-1c3d-4b6e-8f01-a2b3c4d5e6f8.jsonl",
        pi_line("model-a"),
        pi_line("model-b"),
        |d| d.get("model").and_then(Value::as_str).map(str::to_string),
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// v4-r2: B3 — a large same-size suffix edit needs a real content witness.
//
// The audit's reproduction: a 70,084-byte supported record (newline-terminated, 70,000 x's before
// `message.model`). A 256-byte prefix sample is identical after the edit, the stored 65,536-byte hash does
// not exist, and the old code therefore declared the file unchanged (mtime advanced, no new row). The same
// must hold when the committed state is serialized and restored, and for the legacy v6 checkpoint that has
// no revision/hash at all (missing evidence is *unknown*, never equality).
// ---------------------------------------------------------------------------------------------

const LARGE_RECORD_BYTES: usize = 70_084;

#[tokio::test]
async fn large_70084_byte_suffix_edit_reaches_store_once_live_and_restored() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("large-suffix.jsonl");
    let a = claude_padded_line(LARGE_RECORD_BYTES, "large-a");
    let b = claude_padded_line(LARGE_RECORD_BYTES, "large-b");
    let c = claude_padded_line(LARGE_RECORD_BYTES, "large-c");
    assert_eq!(a.len(), b.len());
    assert_eq!(&a.as_bytes()[..256], &b.as_bytes()[..256]);

    o.write(&file, &a);
    o.turn().await.expect("A").expect("A work");
    assert_eq!(o.step_models(), vec![Some("large-a".to_string())]);
    assert_eq!(step_generations(&o.db, "claude-code"), vec![1]);

    // Live edit: same size, identical 256-byte prefix, changed mtime. Poll four times, as the audit did.
    o.rewrite_in_place(&file, &b, 2);
    for _ in 0..4 {
        o.turn().await.expect("live large poll");
    }
    assert_eq!(
        o.step_models(),
        vec![Some("large-a".to_string()), Some("large-b".to_string())],
        "a 70,084-byte same-size suffix edit must reach the Store exactly once (r1 B3)"
    );
    assert_eq!(
        step_generations(&o.db, "claude-code"),
        vec![1, 2],
        "the proven replacement advances the logical generation"
    );

    // Restored edit: serialize the committed checkpoint, then edit the same-size suffix again.
    o.restart(claude_adapter);
    o.rewrite_in_place(&file, &c, 4);
    for _ in 0..4 {
        o.turn().await.expect("restored large poll");
    }
    assert_eq!(
        o.step_models(),
        vec![
            Some("large-a".to_string()),
            Some("large-b".to_string()),
            Some("large-c".to_string())
        ],
        "a restored checkpoint must still detect the large suffix edit"
    );
    assert_eq!(step_generations(&o.db, "claude-code"), vec![1, 2, 3]);
    assert_eq!(
        o.drain().await,
        0,
        "fully consumed large revisions stay silent"
    );
    let producers: Vec<String> = o.rows().into_iter().filter_map(|r| r.producer).collect();
    let mut unique = producers.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), producers.len(), "producer keys stay unique");
}

/// Restore a checkpoint the way a v6 database does on upgrade: parser state/offsets survive, the content
/// witness does not. `with_fingerprint` selects between a partially populated v6 checkpoint (prefix sample
/// kept, no hash) and a fully legacy one (no prefix sample either).
async fn legacy_no_hash_suffix_edit_case(with_fingerprint: bool) {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("legacy.jsonl");
    let a = claude_padded_line(684, "legacy-a");
    let b = claude_padded_line(684, "legacy-b");
    o.write(&file, &a);
    o.turn().await.expect("A").expect("A work");
    assert_eq!(o.step_models(), vec![Some("legacy-a".to_string())]);

    // Drop the persisted hash exactly as migration 0007 leaves a v6 row: generations/offsets are seeded,
    // content evidence is absent.
    conn(&o.db)
        .execute("UPDATE source_file_state SET revision=NULL", [])
        .expect("clear persisted revision");
    let mut legacy = o.saved.clone();
    for f in &mut legacy.files {
        f.revision = None;
        if !with_fingerprint {
            f.fingerprint = String::new();
        }
    }
    o.src = claude_adapter(&o.home);
    o.src.restore_checkpoint(legacy.clone());
    o.saved = legacy;
    o.cursor = o.saved.files.iter().map(|f| f.offset).max().unwrap_or(0);
    o.first = true;
    o.pending = None;

    o.rewrite_in_place(&file, &b, 2);
    for _ in 0..4 {
        o.turn().await.expect("legacy poll");
    }
    assert_eq!(
        o.step_models(),
        vec![Some("legacy-a".to_string()), Some("legacy-b".to_string())],
        "a legacy checkpoint without content evidence must deliver the supported edit once; missing \
         evidence is unknown, not equality (fingerprint_kept={with_fingerprint})"
    );
    assert_eq!(
        step_generations(&o.db, "claude-code"),
        vec![1, 2],
        "the legacy edit advances the logical generation"
    );
    assert_eq!(o.drain().await, 0, "the legacy revision is consumed once");
}

#[tokio::test]
async fn legacy_v6_checkpoint_without_hash_delivers_supported_suffix_edit() {
    legacy_no_hash_suffix_edit_case(false).await;
    legacy_no_hash_suffix_edit_case(true).await;
}

#[tokio::test]
async fn above_pass_size_source_makes_bounded_verification_progress() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("five-mib.jsonl");
    // 80 records of exactly 65,536 bytes => 5 MiB, more than one 4 MiB pass and far above the 65,536-byte
    // full-hash limit. The distinguishing model token is beyond byte 256 of every record.
    let per_line = 65_536usize;
    let lines: Vec<String> = (0..80)
        .map(|i| claude_padded_line(per_line, &format!("big-{i:03}")))
        .collect();
    let content = lines.concat();
    assert_eq!(content.len(), 5 * 1024 * 1024);
    o.write(&file, &content);

    let mut turns = 0usize;
    while turns < 24 {
        turns += 1;
        match o.turn().await.expect("drain pass") {
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        turns >= 2,
        "a 5 MiB source needs more than one bounded pass (took {turns})"
    );
    let expected: Vec<Option<String>> = (0..80).map(|i| Some(format!("big-{i:03}"))).collect();
    assert_eq!(
        o.step_models(),
        expected,
        "every record of the >4 MiB source commits exactly once in file order"
    );
    assert!(
        step_generations(&o.db, "claude-code")
            .iter()
            .all(|g| *g == 1),
        "one full consumption keeps one logical generation"
    );

    // Same-size suffix edit to one record, changed mtime, above one-pass verification size.
    // Same-size edit: the model token changes value but keeps its byte length.
    let edited = content.replace("\"big-040\"", "\"big-04B\"");
    assert_eq!(edited.len(), content.len());
    o.rewrite_in_place(&file, &edited, 2);
    let mut detected = false;
    for _ in 0..16 {
        o.turn().await.expect("verification pass");
        if o.step_models()
            .iter()
            .any(|m| m.as_deref() == Some("big-04B"))
        {
            detected = true;
            break;
        }
    }
    assert!(
        detected,
        "a >4 MiB source must make resumable verification progress and deliver the edited record \
         (r1 B3: no checkpoint may be advanced as verified-unchanged when it was not); rows: {:#?}",
        o.step_models()
    );
    // Finish any re-read, then require the edited value exactly once and unique producer keys.
    o.drain().await;
    let edited_count = o
        .step_models()
        .into_iter()
        .filter(|m| m.as_deref() == Some("big-04B"))
        .count();
    assert_eq!(edited_count, 1, "the edited record is stored exactly once");
    let producers: Vec<String> = o.rows().into_iter().filter_map(|r| r.producer).collect();
    let mut unique = producers.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), producers.len(), "no producer key is reused");
    let gens = step_generations(&o.db, "claude-code");
    assert_eq!(
        gens.iter().filter(|g| **g == 1).count(),
        80,
        "the original 80 records keep generation 1"
    );
    assert!(
        gens.iter().any(|g| *g > 1),
        "the proven edit allocates a later generation: {gens:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// v4-r2: restart in the middle of a bounded discovery sweep.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn restart_mid_sweep_never_tombstones_unseen_paths() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let dir = claude_home(&o.home);
    // Establish a complete 450-path baseline first, so a mid-sweep restart has real state to lose.
    for i in 0..450 {
        o.write(
            &dir.join(format!("f{i:03}.jsonl")),
            &claude_line(&format!("base-{i:03}")),
        );
    }
    // Bounded discovery: reaching 450 known paths is not the same event as *completing* the sweep, so wait
    // for the source to report a completed, error-free sweep as well.
    let mut turns = 0usize;
    while turns < 16 && (o.saved.paths().len() < 450 || !o.src.discovery_complete()) {
        o.turn().await.expect("baseline sweep");
        turns += 1;
    }
    assert_eq!(o.saved.paths().len(), 450, "baseline discovery complete");
    assert!(o.durable_removed().is_empty());
    let baseline_gens = o.generations();

    // Delete one known path and add 300 new paths: the next sweep needs several bounded passes.
    std::fs::remove_file(dir.join("f000.jsonl")).expect("remove known path");
    for i in 450..750 {
        o.write(
            &dir.join(format!("g{i:03}.jsonl")),
            &claude_line(&format!("new-{i:03}")),
        );
    }
    o.restart(claude_adapter);
    o.turn().await.expect("partial sweep before restart");
    assert!(
        o.durable_removed().is_empty(),
        "an unfinished sweep must not tombstone a path: {:?}",
        o.durable_removed()
    );

    // Restart in the middle of the sweep: parser state and generation high-water must survive, and no
    // tombstone may appear until a sweep actually completes.
    o.restart(claude_adapter);
    o.turn().await.expect("poll after mid-sweep restart");
    assert!(
        o.durable_removed().is_empty(),
        "a restart mid-sweep must not certify absence: {:?}",
        o.durable_removed()
    );
    assert_eq!(
        o.generations(),
        baseline_gens,
        "a mid-sweep restart must not reset or raise the generation high-water"
    );
    assert!(
        o.saved.paths().len() >= 450,
        "known paths must survive the mid-sweep restart, got {}",
        o.saved.paths().len()
    );

    // Continue until the sweep is *complete*: with bounded traversal the known-path count can reach 749 while a
    // carried-over path is still unresolved, and only completion proves the absence of the deleted one.
    let mut turns = 0usize;
    while turns < 40 && (o.saved.paths().len() < 749 || !o.src.discovery_complete()) {
        o.turn().await.expect("sweep continuation");
        turns += 1;
    }
    assert_eq!(
        o.saved.paths().len(),
        749,
        "the completed sweep reports 450 - 1 + 300 = 749 paths"
    );
    let removed = o.durable_removed();
    assert_eq!(removed.len(), 1, "only the proven-absent path is removed");
    assert!(removed[0].path.ends_with("f000.jsonl"));
    // Every surviving baseline path keeps its generation; the removed path's tombstone keeps its own.
    let now = o.generations();
    let now_map: std::collections::BTreeMap<_, _> = now.into_iter().collect();
    for (path, gen) in &baseline_gens {
        if path.ends_with("f000.jsonl") {
            continue;
        }
        assert_eq!(
            now_map.get(path),
            Some(gen),
            "unchanged path {path} must keep generation {gen}"
        );
    }
    assert_eq!(
        removed[0].generation, 1,
        "the tombstone keeps the removed path's generation"
    );
}

// ---------------------------------------------------------------------------------------------
// v4-r2: a file growing while polls run keeps one identity per record.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn concurrent_growth_commits_every_record_exactly_once() {
    use std::io::Write;
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("growing.jsonl");
    o.write(&file, &claude_line("grow-000"));
    o.turn().await.expect("first").expect("first record");

    let path = file.clone();
    let writer = std::thread::spawn(move || {
        for i in 1..=120 {
            let line = claude_line(&format!("grow-{i:03}"));
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("append open");
            f.write_all(line.as_bytes()).expect("append line");
            f.flush().expect("flush line");
            std::thread::sleep(Duration::from_millis(1));
        }
    });

    let mut polls = 0usize;
    while !writer.is_finished() && polls < 400 {
        o.turn().await.expect("growth poll");
        polls += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    writer.join().expect("writer thread");
    o.drain().await;

    let expected: Vec<Option<String>> = (0..=120).map(|i| Some(format!("grow-{i:03}"))).collect();
    assert_eq!(
        o.step_models(),
        expected,
        "every appended record commits exactly once, in file order, even while the file grows"
    );
    let producers: Vec<String> = o.rows().into_iter().filter_map(|r| r.producer).collect();
    let mut unique = producers.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        producers.len(),
        "growing appends never reuse a key"
    );
    assert!(
        step_generations(&o.db, "claude-code")
            .iter()
            .all(|g| *g == 1),
        "appends keep one logical generation"
    );
}

// ---------------------------------------------------------------------------------------------
// Harness sanity: every emitted item is committed and the harness only touched its own temp tree.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn harness_smoke_counts_every_committed_item() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("s.jsonl");
    o.write(&file, &claude_line("model-a"));
    let (items, events) = o.turn().await.expect("turn").expect("work");
    assert_eq!(items, events, "every emitted item is newly committed here");
    let kinds: Vec<String> = o.rows().into_iter().map(|r| r.kind).collect();
    assert_eq!(kinds, vec!["session".to_string(), "step".to_string()]);
    assert!(o.tmp.path().exists());
}

// ---------------------------------------------------------------------------------------------
// v4-r3: discovery lifecycle witnesses through the real adapters (r2 audit B3).
//
// The r2 audit proved three independent state-machine defects: a fresh tail claimed a *completed* sweep
// before scanning anything (`!active && !error` on default false fields); a sweep that ended with a
// read-dir error returned while leaving the sweep active, so it never retried and a later-available path
// was unreachable; and a `stat` failure was discarded, which let an uninspectable entry certify absence
// and remove a known path. Each witness below uses the real adapter and the same poll/checkpoint/commit
// path the poller runs, and asserts the honest signal *and* the durable rows.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn fresh_adapter_has_not_completed_a_discovery_sweep_before_its_first_pass() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    assert!(
        !o.src.discovery_complete(),
        "a brand-new adapter has not completed any discovery sweep; core gates tombstones on this signal \
         and the r2 default reported a completed sweep before the first scan"
    );
    assert!(o.durable_removed().is_empty());

    o.write(
        &claude_home(&o.home).join("first.jsonl"),
        &claude_line("first-a"),
    );
    o.turn().await.expect("first pass").expect("first record");
    assert!(
        o.src.discovery_complete(),
        "a complete successful first sweep must report completion"
    );
    assert_eq!(o.step_models(), vec![Some("first-a".to_string())]);
    assert_eq!(o.saved.paths().len(), 1, "the path is in the checkpoint");
    assert!(
        o.durable_removed().is_empty(),
        "a first sweep never tombstones anything"
    );
    assert_eq!(step_generations(&o.db, "claude-code"), vec![1]);
}

#[tokio::test]
async fn failed_discovery_retries_after_the_missing_root_recovers() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let dir = claude_home(&o.home); // deliberately absent for the first scheduled turn

    assert_eq!(
        o.turn().await.expect("missing-root poll"),
        None,
        "a missing root produces no batch"
    );
    assert!(
        !o.src.discovery_complete(),
        "a sweep over a missing root has not completed successfully"
    );
    assert!(o.durable_removed().is_empty());

    // The root and one supported record appear. A failed sweep must be retried on a later turn rather than
    // staying active forever (r2 B3: `complete && discover_error` returned and left the sweep wedged).
    o.write(&dir.join("recovered.jsonl"), &claude_line("recovered-a"));
    let mut discovered = false;
    for _ in 0..4 {
        o.turn().await.expect("recovery poll");
        if !o.step_models().is_empty() {
            discovered = true;
            break;
        }
    }
    assert!(
        discovered,
        "a root that appears after a failed sweep must be rescanned and ingested without a restart: {:?}",
        o.step_models()
    );
    assert_eq!(o.step_models(), vec![Some("recovered-a".to_string())]);
    assert!(
        o.durable_removed().is_empty(),
        "recovery never tombstones: {:?}",
        o.durable_removed()
    );
    assert_eq!(o.saved.paths().len(), 1);
    assert!(o.src.discovery_complete(), "the recovered sweep completes");
}

#[cfg(unix)]
#[tokio::test]
async fn metadata_failure_does_not_certify_a_removed_path() {
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let file = claude_home(&o.home).join("stat-error.jsonl");
    o.write(&file, &claude_line("stat-a"));
    o.turn().await.expect("A").expect("A work");
    assert_eq!(o.step_models(), vec![Some("stat-a".to_string())]);
    let baseline_gens = o.generations();
    let baseline_seq: Vec<u64> = o.rows().iter().map(|r| r.seq).collect();
    let baseline_events = event_count(&o.db, "claude-code");

    // Replace the directory entry with a dangling symlink: `read_dir` returns the entry but `stat` fails.
    // An uninspectable entry is not proof of absence (r2 B3 at `adapters/mod.rs:321`).
    std::fs::remove_file(&file).expect("remove synthetic file");
    std::os::unix::fs::symlink("/nonexistent/v4-r3-stat-target", &file).expect("dangling symlink");

    o.restart(claude_adapter);
    o.turn().await.expect("stat-failure sweep");
    assert!(
        !o.src.discovery_complete(),
        "a stat failure must never certify a completed sweep"
    );
    assert!(
        o.durable_removed().is_empty(),
        "an uninspectable entry must not tombstone the known path: {:?}",
        o.durable_removed()
    );
    assert_eq!(
        o.saved.paths().len(),
        1,
        "the known path and its parser state must be retained after the failed sweep"
    );
    assert_eq!(
        o.generations(),
        baseline_gens,
        "a failed sweep must not reset or raise the generation high-water"
    );
    let baseline_max_seq = baseline_seq.iter().copied().max().unwrap_or(0);
    let published: Vec<String> = o
        .rows()
        .into_iter()
        .filter(|r| r.seq > baseline_max_seq)
        .map(|r| format!("{}:{:?}", r.kind, r.data))
        .collect();
    assert!(
        published.iter().all(|r| r.starts_with("error:")),
        "a failed sweep may publish only honest error observations of the uninspectable entry, never a \
         replayed record, session or spend: {published:?}"
    );
    assert!(
        published.len() <= 2,
        "a failed sweep must not amplify one uninspectable entry into many observations: {published:?}"
    );
    assert_eq!(
        o.step_models(),
        vec![Some("stat-a".to_string())],
        "no committed record is replayed by a failed sweep"
    );
    assert!(
        event_count(&o.db, "claude-code") >= baseline_events,
        "the failed sweep cannot drop committed history"
    );

    // A second turn while the entry is still uninspectable must stay honest rather than "recovering" into
    // a completed sweep that removes the path.
    o.turn().await.expect("second stat-failure sweep");
    assert!(!o.src.discovery_complete());
    assert!(
        o.durable_removed().is_empty(),
        "repeated stat failures never become absence proof: {:?}",
        o.durable_removed()
    );
    assert_eq!(o.saved.paths().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_directory_does_not_certify_removed_paths() {
    use std::os::unix::fs::PermissionsExt;
    let mut o = Oracle::new(claude_adapter, "claude-code");
    let sub = claude_home(&o.home).join("locked");
    let file = sub.join("inside.jsonl");
    o.write(&file, &claude_line("locked-a"));
    o.turn().await.expect("A").expect("A work");
    assert_eq!(o.step_models(), vec![Some("locked-a".to_string())]);
    let baseline_gens = o.generations();
    let baseline_events = event_count(&o.db, "claude-code");

    // The root stays readable but a directory that holds a known path cannot be read. A directory the sweep
    // could not inspect is not evidence that its contents disappeared (r2 B3 read-dir error path).
    std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o000))
        .expect("chmod 000 subdir");
    o.restart(claude_adapter);
    o.turn().await.expect("read-dir failure sweep");
    let complete = o.src.discovery_complete();
    let removed = o.durable_removed();
    // Restore permissions before any later assertion can abort the test, so the temp tree stays removable.
    std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).expect("chmod back");

    assert!(
        !complete,
        "an unreadable directory must not certify a completed discovery sweep"
    );
    assert!(
        removed.is_empty(),
        "a read-dir failure must not tombstone a known path: {removed:?}"
    );
    assert!(
        o.saved.paths().iter().any(|p| p.ends_with("inside.jsonl")),
        "the known path and its parser state must be retained: {:?}",
        o.saved.paths()
    );
    assert_eq!(
        o.generations(),
        baseline_gens,
        "a failed sweep must not reset or raise the generation high-water"
    );
    assert_eq!(
        o.step_models(),
        vec![Some("locked-a".to_string())],
        "a failed sweep must not replay a committed record"
    );
    assert_eq!(event_count(&o.db, "claude-code"), baseline_events);
}

/// Real adapter -> poller/Bus/Store discovery for one JSONL family: no completed sweep before the first
/// pass, first-pass discovery of a brand-new path, proven-absence tombstone after a complete sweep, and a
/// distinct generation when the path reappears.
async fn family_discovery_and_removal_case(
    make: fn(&Path) -> Box<dyn Source>,
    id: &'static str,
    rel: &str,
    a: String,
    b: String,
) {
    let mut o = Oracle::new(make, id);
    assert!(
        !o.src.discovery_complete(),
        "{id}: a fresh adapter has not completed a sweep"
    );
    let file = o.home.join(rel);
    o.write(&file, &a);
    o.turn().await.expect("first pass").expect("first record");
    assert!(
        o.src.discovery_complete(),
        "{id}: a complete first sweep reports completion"
    );
    assert_eq!(o.steps().len(), 1, "{id}: exactly one committed step");
    assert_eq!(
        o.saved.paths().len(),
        1,
        "{id}: exactly one discovered path, got {:?}",
        o.saved.paths()
    );
    assert_eq!(
        step_generations(&o.db, id),
        vec![1],
        "{id}: first discovered path starts at generation 1"
    );
    assert!(o.durable_removed().is_empty());

    std::fs::remove_file(&file).expect("remove discovered file");
    o.restart(make);
    let mut turns = 0usize;
    while turns < 4 && o.durable_removed().is_empty() {
        turns += 1;
        o.turn().await.expect("removal sweep");
    }
    let removed = o.durable_removed();
    assert_eq!(
        removed.len(),
        1,
        "{id}: a complete sweep tombstones exactly the proven-absent path: {removed:?}"
    );
    assert!(
        rel.ends_with(&removed[0].path),
        "{id}: the tombstone names the removed file: {} vs {rel}",
        removed[0].path
    );
    assert_eq!(
        removed[0].generation, 1,
        "{id}: the tombstone keeps the removed path's generation"
    );
    assert!(
        o.saved.files.is_empty(),
        "{id}: the path left the live checkpoint"
    );

    // Reappearance must not recycle the removed generation.
    o.write(&file, &b);
    set_mtime_hours_from_now(&file, 2);
    o.restart(make);
    o.turn().await.expect("reappearance sweep");
    assert!(
        o.durable_removed().is_empty(),
        "{id}: reappearance clears the tombstone"
    );
    let gens = step_generations(&o.db, id);
    assert_eq!(gens.len(), 2, "{id}: both records committed: {gens:?}");
    assert!(
        gens[1] > gens[0],
        "{id}: a reappearing path gets a generation above the high-water: {gens:?}"
    );
}

#[tokio::test]
async fn codex_new_path_discovery_and_proven_removal() {
    family_discovery_and_removal_case(
        codex_adapter,
        "codex",
        ".codex/sessions/2026/10/31/rollout-2026-10-31T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b6c.jsonl",
        codex_line("2026-10-31T11:00:01.000Z"),
        codex_line("2026-10-31T11:00:02.000Z"),
    )
    .await;
}

#[tokio::test]
async fn agy_new_path_discovery_and_proven_removal() {
    family_discovery_and_removal_case(
        agy_adapter,
        "agy",
        ".gemini/antigravity-cli/brain/conv-3/.system_generated/logs/transcript.jsonl",
        agy_line("model-a"),
        agy_line("model-b"),
    )
    .await;
}

#[tokio::test]
async fn pi_new_path_discovery_and_proven_removal() {
    family_discovery_and_removal_case(
        pi_adapter,
        "pi",
        ".pi/agent/sessions/--work-discovery--/2026-10-31T12-00-00-000Z_6e3a8b01-2d4c-5f7e-9a0b-1c2d3e4f5a6b.jsonl",
        pi_line("model-a"),
        pi_line("model-b"),
    )
    .await;
}

// ---------------------------------------------------------------------------------------------
// v4-r3: the append -> touch -> restart sequence must report per family.
//
// The r2 case ran Codex first, and its panic concealed the Agy and Pi outcomes. The same helper is now
// driven by three separate cases in addition to the preserved combined case, so one red family cannot
// hide the others.
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn codex_append_touch_and_restart_keep_exactly_two_revisions() {
    family_append_touch_restart_case(
        codex_adapter,
        "codex",
        ".codex/sessions/2026/10/31/rollout-2026-10-31T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl",
        codex_line("2026-10-31T10:00:01.000Z"),
        codex_line("2026-10-31T10:00:02.000Z"),
        |d| d.get("ts").and_then(Value::as_str).map(str::to_string),
    )
    .await;
}

#[tokio::test]
async fn agy_append_touch_and_restart_keep_exactly_two_revisions() {
    family_append_touch_restart_case(
        agy_adapter,
        "agy",
        ".gemini/antigravity-cli/brain/conv-2/.system_generated/logs/transcript.jsonl",
        agy_line("model-a"),
        agy_line("model-b"),
        |d| d.get("model").and_then(Value::as_str).map(str::to_string),
    )
    .await;
}

#[tokio::test]
async fn pi_append_touch_and_restart_keep_exactly_two_revisions() {
    family_append_touch_restart_case(
        pi_adapter,
        "pi",
        ".pi/agent/sessions/--work-demo-app--/2026-10-31T09-00-00-000Z_5e2f7a90-1c3d-4b6e-8f01-a2b3c4d5e6f8.jsonl",
        pi_line("model-a"),
        pi_line("model-b"),
        |d| d.get("model").and_then(Value::as_str).map(str::to_string),
    )
    .await;
}

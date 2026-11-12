//! SQLite store (WAL) for events, tasks, audit rows and config.

pub mod migrations;

use crate::core::tasks::TaskRow;
use crate::core::{
    now_ms, BatchItem, Event, FileOffset, GenerationCandidate, GenerationClaim, RecordKey,
    RemovedPath,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The durable high-water moved between deriving a candidate and committing its claim: nothing was written.
    #[error("generation conflict on {path}: claim base {base}, stored high-water {actual}")]
    GenerationConflict {
        path: String,
        base: u64,
        actual: u64,
    },
    /// A claim that would not advance the high-water is a programming error and is refused.
    #[error("invalid generation claim on {path}: {generation} is not above base {base}")]
    InvalidGenerationClaim {
        path: String,
        base: u64,
        generation: u64,
    },
    /// A claimed batch must cover every generation it advances; an unclaimed advance is refused.
    #[error("unclaimed generation {generation} for {path}")]
    UnclaimedGeneration { path: String, generation: u64 },
    /// A checkpoint delta over the per-commit row ceiling is refused before any write.
    #[error("checkpoint delta too large: {rows} rows")]
    DeltaTooLarge { rows: usize },
}

/// One watched file's persisted parser/tail state (see migration 0004/0005). Adapters override
/// `Source::checkpoint`/`restore_checkpoint` to read and write it; the poller persists the whole
/// [`crate::core::SourceCheckpoint`] (files, source revisions, tombstones) in the batch transaction.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileStateRow {
    pub source: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub fingerprint: String,
    pub session: Option<String>,
    pub model: Option<String>,
    pub generation: u64,
    pub offset: u64,
    pub discarded_bytes: u64,
    pub incomplete: bool,
    pub announced: bool,
    pub revision: Option<String>,
}

/// Everything one source batch commits, in one SQLite transaction: events, offsets, per-file parser state,
/// source-level revisions and path tombstones. Built by the poller, applied by [`Store::commit_batch`].
pub struct BatchCommit<'a> {
    pub source: &'a str,
    pub items: &'a [BatchItem],
    pub offsets: &'a [FileOffset],
    pub file_states: &'a [FileStateRow],
    /// `SourceCheckpoint::revisions`: durable source-level counters (snapshot rounds, semantic revisions).
    pub revisions: &'a BTreeMap<String, String>,
    /// Paths that disappeared from the checkpoint: persisted as tombstones.
    pub removed: &'a [RemovedPath],
    /// Tombstoned paths that are back in the checkpoint: their tombstones are deleted.
    pub reappeared: &'a [String],
    /// Producer identity per item, aligned with `items` (shorter/empty list = legacy identity policy).
    pub identities: &'a [RecordKey],
    /// Optimistic logical-generation claims, compare-and-advanced inside this transaction (see
    /// [`GenerationClaim`]). Empty = legacy batch (the high-water is raised by `max()` from committed file
    /// state/removals, never lowered). A batch that supplies claims must cover every advance it makes.
    pub claims: &'a [GenerationClaim],
    pub first_seq: u64,
}

/// One bounded checkpoint delta committed incrementally: only the changed rows are written.
/// Unlike [`BatchCommit`], nothing is deleted that the delta does not name (except the file-state /
/// offset rows of its own `removed` paths, which lose their parser state in the same transaction
/// that records their tombstone). The caller must have validated `upserts.len() + revisions.len() +
/// removed.len() <= MAX_CHECKPOINT_DELTA_ROWS` before calling; the store re-checks before writing.
pub struct DeltaCommit<'a> {
    pub source: &'a str,
    pub items: &'a [BatchItem],
    /// Changed file states (already converted from `FileCheckpoint` by the caller).
    pub file_states: &'a [FileStateRow],
    /// Changed source-level revisions only.
    pub revisions: &'a BTreeMap<String, String>,
    /// Removal candidates proved by a complete sweep.
    pub removed: &'a [RemovedPath],
    /// Tombstoned paths that are back in the delta's upserts.
    pub reappeared: &'a [String],
    pub identities: &'a [RecordKey],
    pub claims: &'a [GenerationClaim],
    pub first_seq: u64,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

/// Epoch milliseconds from a JSON value: a number (epoch seconds when it looks like 10 digits, otherwise epoch
/// milliseconds) or an ISO-8601 string (`YYYY-MM-DDTHH:MM:SS[.fff][Z|+HH:MM]`). `None` when it is not a time.
pub fn time_value_ms(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => {
            let n = n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))?;
            number_ms(n)
        }
        Value::String(s) => iso8601_ms(s),
        _ => None,
    }
}

fn number_ms(n: i64) -> Option<u64> {
    if n <= 0 {
        return None;
    }
    // 1e11 ms is 1973-03-03 and 1e11 s is year 5138: the split is unambiguous for real timestamps.
    const MS_SPLIT: i64 = 100_000_000_000;
    if n >= MS_SPLIT {
        Some(n as u64)
    } else if n >= 100_000_000 {
        Some(n as u64 * 1000) // epoch seconds
    } else {
        None
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

fn digits(s: &str, at: usize, n: usize) -> Option<i64> {
    let part = s.get(at..at + n)?;
    if !part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

/// Epoch milliseconds from an ISO-8601 timestamp. A missing zone designator is read as UTC, which is what the
/// agent transcripts use (`2026-10-31T14:30:00.000Z`).
pub fn iso8601_ms(s: &str) -> Option<u64> {
    if s.len() < 19 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (digits(s, 0, 4)?, digits(s, 5, 2)?, digits(s, 8, 2)?);
    let (h, mi, se) = (digits(s, 11, 2)?, digits(s, 14, 2)?, digits(s, 17, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut frac_ms = 0i64;
    if b.get(i) == Some(&b'.') || b.get(i) == Some(&b',') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if start == i {
            return None;
        }
        let mut v = 0i64;
        for (k, c) in s[start..i].bytes().enumerate().take(3) {
            v += (c - b'0') as i64 * [100, 10, 1][k];
        }
        frac_ms = v;
    }
    let mut off_s = 0i64;
    match b.get(i) {
        None | Some(b'Z') | Some(b'z') => {}
        Some(&sign) if sign == b'+' || sign == b'-' => {
            let oh = digits(s, i + 1, 2)?;
            let after = i + 3;
            let om = if b.get(after) == Some(&b':') {
                digits(s, after + 1, 2)?
            } else {
                digits(s, after, 2).unwrap_or(0)
            };
            let secs = oh * 3600 + om * 60;
            off_s = if sign == b'+' { secs } else { -secs };
        }
        // An unrecognised trailing suffix makes the value untrustworthy rather than silently UTC.
        Some(_) => return None,
    }
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - off_s;
    if secs < 0 {
        return None;
    }
    Some(secs as u64 * 1000 + frac_ms as u64)
}

/// Source occurrence time of one batch item in epoch ms, or 0 when it carries none.
///
/// Key order (first key present *and* parseable wins), matching what the adapters already put in `data`:
/// 1. `occurred_ms` — explicit epoch-ms number;
/// 2. `ts`          — every JSONL adapter sets it: ISO-8601 from Claude/Codex/Pi/Agy, epoch ms from OpenCode;
/// 3. `at`          — generic alias;
/// 4. `started`     — session/run announcements carry the first record's time here (`claude-code`, `opencode`);
/// 5. `time.created`, `time.completed`, `time.start`, `time.end` — OpenCode's numeric time object.
///
/// A source that reports no time (plans-harness rounds and workers, fake heartbeats) keeps 0 = unknown; the
/// ingestion time stays in `events.ts` either way.
pub fn occurred_ms(data: &Value) -> u64 {
    const KEYS: [&str; 3] = ["occurred_ms", "ts", "at"];
    for k in KEYS {
        if let Some(ms) = data.get(k).and_then(time_value_ms) {
            return ms;
        }
    }
    if let Some(ms) = data.get("started").and_then(time_value_ms) {
        return ms;
    }
    for k in ["created", "completed", "start", "end"] {
        if let Some(ms) = data
            .get("time")
            .and_then(|t| t.get(k))
            .and_then(time_value_ms)
        {
            return ms;
        }
    }
    0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Durable logical-generation high-water for one (source, path), read inside or outside a transaction.
/// `source_generations` is authoritative; the file-state/tombstone fallback keeps pre-migration rows readable.
fn high_water_in(conn: &Connection, source: &str, path: &str) -> rusqlite::Result<u64> {
    let stored: Option<i64> = conn
        .query_row(
            "SELECT generation FROM source_generations WHERE source=?1 AND path=?2",
            params![source, path],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(v) = stored {
        return Ok(v as u64);
    }
    let fs: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(generation),0) FROM source_file_state WHERE source=?1 AND path=?2",
            params![source, path],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let rm: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(generation),0) FROM source_removed WHERE source=?1 AND path=?2",
            params![source, path],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(fs.max(rm) as u64)
}

/// Stable identity of one observation of a source *without* file offsets:
/// `source | session | kind | sha256(data) | occurred_ms | repeat-index-within-batch`, hashed so the column
/// stays short. `repeat` counts earlier items of the same batch with the same first five components, so a
/// genuine repeat inside one batch (two identical usage records of one message) is kept, and the same batch
/// read again produces the same identities and inserts nothing.
fn occurrence_key(
    source: &str,
    session: &str,
    kind: &str,
    data: &str,
    occurred: u64,
    repeat: u32,
) -> String {
    let mut h = Sha256::new();
    h.update(source.as_bytes());
    h.update([0x1f]);
    h.update(session.as_bytes());
    h.update([0x1f]);
    h.update(kind.as_bytes());
    h.update([0x1f]);
    h.update(Sha256::digest(data.as_bytes()));
    h.update([0x1f]);
    h.update(occurred.to_string().as_bytes());
    h.update([0x1f]);
    h.update(repeat.to_string().as_bytes());
    format!("occ:{}", hex(&h.finalize()))
}

/// Logical-generation claims: compare-and-advance INSIDE the caller's transaction. A claim only
/// survives if the durable high-water is still exactly the value the candidate was derived from.
/// Otherwise the caller returns the error and the transaction rolls back: no event, no checkpoint,
/// no revision, no seq, no tombstone.
fn apply_claims(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    claims: &[GenerationClaim],
    file_states: &[FileStateRow],
    removed: &[RemovedPath],
) -> Result<(), StoreError> {
    if claims.is_empty() {
        return Ok(());
    }
    let mut claimed: BTreeMap<String, u64> = BTreeMap::new();
    for claim in claims {
        if claim.generation <= claim.base {
            return Err(StoreError::InvalidGenerationClaim {
                path: claim.path.clone(),
                base: claim.base,
                generation: claim.generation,
            });
        }
        let stored = high_water_in(tx, source, &claim.path)?;
        if stored != claim.base {
            return Err(StoreError::GenerationConflict {
                path: claim.path.clone(),
                base: claim.base,
                actual: stored,
            });
        }
        tx.execute(
            "INSERT INTO source_generations(source,path,generation,updated) VALUES (?1,?2,?3,?4)
             ON CONFLICT(source,path) DO UPDATE SET
               generation = excluded.generation, updated = excluded.updated",
            params![source, claim.path, claim.generation as i64, now_ms() as i64],
        )?;
        claimed.insert(claim.path.clone(), claim.generation);
    }
    // A claimed batch may not advance the high-water behind a claim's back.
    for st in file_states {
        let stored = high_water_in(tx, source, &st.path)?;
        if st.generation > stored && claimed.get(&st.path) != Some(&st.generation) {
            return Err(StoreError::UnclaimedGeneration {
                path: st.path.clone(),
                generation: st.generation,
            });
        }
    }
    for r in removed {
        let stored = high_water_in(tx, source, &r.path)?;
        if r.generation > stored && claimed.get(&r.path) != Some(&r.generation) {
            return Err(StoreError::UnclaimedGeneration {
                path: r.path.clone(),
                generation: r.generation,
            });
        }
    }
    Ok(())
}

/// Inserts a batch's events (redacted before the row is written) and returns the inserted ones.
/// `offsets_empty` selects the legacy offset-less occurrence identity; producer identities always
/// win when supplied.
fn insert_events(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    items: &[BatchItem],
    identities: &[RecordKey],
    offsets_empty: bool,
    first_seq: u64,
    home: Option<&'static str>,
) -> Result<Vec<Event>, StoreError> {
    let mut out = Vec::new();
    let mut ins = tx.prepare(
        "INSERT OR IGNORE INTO events(seq,kind,source,ts,data,session,dedup,occurred_ms,occurrence,producer) \
         VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8,?9)",
    )?;
    // Repeat counter for the legacy offset-less identity: same session/kind/data/occurred in this batch.
    let mut repeats: BTreeMap<String, u32> = BTreeMap::new();
    for (i, it) in items.iter().enumerate() {
        let kind = serde_json::to_value(it.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".into());
        let data_value = crate::logging::redact_value(&it.data, home);
        let data = data_value.to_string();
        let session = crate::logging::redact(&it.session, home);
        let occurred = occurred_ms(&data_value);
        let producer = identities.get(i).map(RecordKey::key);
        let occurrence = if producer.is_some() {
            None
        } else if offsets_empty {
            let base = format!("{}\u{1f}{}\u{1f}{}\u{1f}{occurred}", session, kind, data);
            let repeat = repeats.entry(base).or_insert(0);
            let key = occurrence_key(source, &session, &kind, &data, occurred, *repeat);
            *repeat += 1;
            Some(key)
        } else {
            None
        };
        let seq = first_seq + out.len() as u64;
        let ts = now_ms();
        let n = ins.execute(rusqlite::params![
            seq as i64,
            kind,
            source,
            ts as i64,
            data,
            session,
            occurred as i64,
            occurrence,
            producer
        ])?;
        if n == 1 {
            out.push(Event {
                seq,
                kind,
                source: source.to_string(),
                ts,
                data: data_value,
            });
        }
    }
    Ok(out)
}

/// Upserts per-file parser state rows (one per named path; paths not named are untouched).
fn upsert_file_states(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    file_states: &[FileStateRow],
) -> Result<(), StoreError> {
    let mut stins = tx.prepare(
        "INSERT INTO source_file_state(source,path,size,mtime_ms,fingerprint,session,model,updated,generation,offset,discarded_bytes,incomplete,announced,revision)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
         ON CONFLICT(source,path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms,
           fingerprint=excluded.fingerprint, session=excluded.session, model=excluded.model,
           updated=excluded.updated, generation=excluded.generation, offset=excluded.offset,
           discarded_bytes=excluded.discarded_bytes, incomplete=excluded.incomplete,
           announced=excluded.announced, revision=excluded.revision",
    )?;
    for st in file_states {
        stins.execute(rusqlite::params![
            source,
            st.path,
            st.size as i64,
            st.mtime_ms as i64,
            st.fingerprint,
            st.session,
            st.model,
            now_ms() as i64,
            st.generation as i64,
            st.offset as i64,
            st.discarded_bytes as i64,
            st.incomplete as i64,
            st.announced as i64,
            st.revision
        ])?;
    }
    Ok(())
}

/// Tombstones for removed paths; clears tombstones for reappeared paths.
fn apply_tombstones(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    removed: &[RemovedPath],
    reappeared: &[String],
) -> Result<(), StoreError> {
    let mut rm = tx.prepare(
        "INSERT INTO source_removed(source,path,generation,removed_ms) VALUES (?1,?2,?3,?4)
         ON CONFLICT(source,path) DO UPDATE SET generation=excluded.generation, removed_ms=excluded.removed_ms",
    )?;
    for r in removed {
        rm.execute(rusqlite::params![
            source,
            r.path,
            r.generation as i64,
            r.removed_ms as i64
        ])?;
    }
    let mut cl = tx.prepare("DELETE FROM source_removed WHERE source=?1 AND path=?2")?;
    for p in reappeared {
        cl.execute(rusqlite::params![source, p])?;
    }
    Ok(())
}

/// Logical generation high-water: monotonic per (source, path), advanced by any committed file
/// state or removal. A lower generation in a later commit never decreases the stored high-water.
fn apply_generations(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    file_states: &[FileStateRow],
    removed: &[RemovedPath],
) -> Result<(), StoreError> {
    let mut gen = tx.prepare(
        "INSERT INTO source_generations(source,path,generation,updated) VALUES (?1,?2,?3,?4)
         ON CONFLICT(source,path) DO UPDATE SET
           generation = CASE WHEN excluded.generation > source_generations.generation
                             THEN excluded.generation ELSE source_generations.generation END,
           updated = CASE WHEN excluded.generation > source_generations.generation
                          THEN excluded.updated ELSE source_generations.updated END",
    )?;
    for st in file_states {
        gen.execute(rusqlite::params![
            source,
            st.path,
            st.generation as i64,
            now_ms() as i64
        ])?;
    }
    for r in removed {
        gen.execute(rusqlite::params![
            source,
            r.path,
            r.generation as i64,
            r.removed_ms as i64
        ])?;
    }
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, StoreError> {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        migrations::run(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn with<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, StoreError> {
        let conn = self.conn.lock().expect("store lock");
        Ok(f(&conn)?)
    }

    pub fn max_seq(&self) -> Result<u64, StoreError> {
        self.with(|c| {
            c.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .map(|v| v as u64)
    }

    /// Retention: delete events older than `days` days. The newest event is always kept so `seq` stays monotonic
    /// across restarts. Returns the number of rows deleted.
    pub fn prune_events(&self, days: u32) -> Result<usize, StoreError> {
        let cutoff = crate::core::now_ms().saturating_sub(u64::from(days) * 86_400_000) as i64;
        self.with(|c| {
            c.execute(
                "DELETE FROM events WHERE ts < ?1 AND seq < (SELECT MAX(seq) FROM events)",
                params![cutoff],
            )
        })
    }

    pub fn event_count(&self) -> Result<i64, StoreError> {
        self.with(|c| c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)))
    }

    pub fn insert_event(&self, ev: &Event) -> Result<(), StoreError> {
        // Defence in depth: an event stored through this method is redacted even if the caller forgot.
        let data = crate::logging::redact_json(&ev.data);
        self.with(|c| {
            c.execute(
                "INSERT INTO events(seq,kind,source,ts,data) VALUES (?1,?2,?3,?4,?5)",
                params![
                    ev.seq as i64,
                    ev.kind,
                    ev.source,
                    ev.ts as i64,
                    data.to_string()
                ],
            )
            .map(|_| ())
        })
    }

    /// Inserts a task; false if the id already exists (the duplicate-task lock).
    pub fn insert_task(
        &self,
        id: &str,
        kind: &str,
        state: &str,
        now: u64,
    ) -> Result<bool, StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO tasks(id,kind,state,created,updated) VALUES (?1,?2,?3,?4,?4)",
                params![id, kind, state, now as i64],
            )
            .map(|n| n == 1)
        })
    }

    pub fn set_task_state_if(&self, id: &str, from: &str, to: &str) -> Result<bool, StoreError> {
        self.with(|c| {
            c.execute(
                "UPDATE tasks SET state=?3, updated=?4 WHERE id=?1 AND state=?2",
                params![id, from, to, now_ms() as i64],
            )
            .map(|n| n == 1)
        })
    }

    pub fn mark_tasks(&self, from: &[&str], to: &str) -> Result<usize, StoreError> {
        self.with(|c| {
            let mut n = 0;
            for f in from {
                n += c.execute(
                    "UPDATE tasks SET state=?2, updated=?3 WHERE state=?1",
                    params![f, to, now_ms() as i64],
                )?;
            }
            Ok(n)
        })
    }

    fn task_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRow> {
        Ok(TaskRow {
            id: r.get(0)?,
            kind: r.get(1)?,
            state: r.get(2)?,
            created: r.get::<_, i64>(3)? as u64,
            updated: r.get::<_, i64>(4)? as u64,
            detail: r.get(5)?,
        })
    }

    pub fn get_task(&self, id: &str) -> Result<Option<TaskRow>, StoreError> {
        self.with(|c| {
            c.query_row(
                "SELECT id,kind,state,created,updated,detail FROM tasks WHERE id=?1",
                [id],
                Self::task_from_row,
            )
            .optional()
        })
    }

    pub fn list_tasks(&self) -> Result<Vec<TaskRow>, StoreError> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id,kind,state,created,updated,detail FROM tasks ORDER BY created DESC LIMIT 500")?;
            let rows = st.query_map([], Self::task_from_row)?;
            rows.collect()
        })
    }

    /// Writes one audit row. The actor, the action and the detail are redacted **before** the insert, so a token,
    /// header or path that reaches an audit call never becomes durable (see `crate::logging::redact`).
    pub fn audit(&self, actor: &str, action: &str, detail: &str) -> Result<(), StoreError> {
        let home = crate::logging::redaction_home();
        let actor = crate::logging::redact(actor, home);
        let action = crate::logging::redact(action, home);
        let detail = crate::logging::redact(detail, home);
        self.with(|c| {
            c.execute(
                "INSERT INTO audit(ts,actor,action,detail) VALUES (?1,?2,?3,?4)",
                params![now_ms() as i64, actor, action, detail],
            )
            .map(|_| ())
        })
    }

    pub fn audit_count(&self, action: &str) -> Result<i64, StoreError> {
        self.with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM audit WHERE action=?1",
                [action],
                |r| r.get(0),
            )
        })
    }

    /// Offsets saved for `source`.
    pub fn load_offsets(&self, source: &str) -> Result<Vec<FileOffset>, StoreError> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT path,offset,size FROM source_offsets WHERE source=?1 ORDER BY path",
            )?;
            let rows = st.query_map([source], |r| {
                Ok(FileOffset {
                    path: r.get(0)?,
                    offset: r.get::<_, i64>(1)? as u64,
                    size: r.get::<_, i64>(2)? as u64,
                })
            })?;
            rows.collect()
        })
    }

    /// Writes events and offsets in ONE transaction. Seqs are consecutive from `first_seq` for the rows actually
    /// inserted. `events.ts` is always the observation time (`now_ms()`); the source's own time goes to
    /// `events.occurred_ms` (see [`occurred_ms`]) and never replaces it.
    ///
    /// Identity policy, in order:
    /// 1. a producer [`RecordKey`] for the item (from `Source::identities`) -> `events.producer`, deduplicated by
    ///    the unique `events_producer` index. Stable across batching, repartition and restart;
    /// 2. no producer identity and no file offsets -> legacy stable [`occurrence_key`] (content + occurrence time +
    ///    repeat index within the batch), deduplicated by `events_occurrence`;
    /// 3. no producer identity but the source has file offsets -> no identity: the committed offset plus the
    ///    transactional cursor is the dedup mechanism (unchanged v2-r1 behaviour).
    pub fn append_batch_at(
        &self,
        source: &str,
        items: &[BatchItem],
        offsets: &[FileOffset],
        first_seq: u64,
    ) -> Result<Vec<Event>, StoreError> {
        self.commit_batch(BatchCommit {
            source,
            items,
            offsets,
            file_states: &[],
            revisions: &BTreeMap::new(),
            removed: &[],
            reappeared: &[],
            identities: &[],
            claims: &[],
            first_seq,
        })
    }

    /// Like [`append_batch_at`] but also persists per-file parser state (`file_states`) in the same
    /// transaction. Absent offsets/file states are removed, so a vanished file cannot regain a stale
    /// cursor after restart.
    pub fn append_batch_at_with_state(
        &self,
        source: &str,
        items: &[BatchItem],
        offsets: &[FileOffset],
        file_states: &[FileStateRow],
        first_seq: u64,
    ) -> Result<Vec<Event>, StoreError> {
        self.commit_batch(BatchCommit {
            source,
            items,
            offsets,
            file_states,
            revisions: &BTreeMap::new(),
            removed: &[],
            reappeared: &[],
            identities: &[],
            claims: &[],
            first_seq,
        })
    }

    /// One batch = events + offsets + file parser state + source revisions + tombstones, atomically.
    /// Nothing is committed when anything fails, so the caller can retry the exact same input.
    ///
    /// Every item's `data` and `session` is redacted **before** the row is written and the same redacted payload is
    /// what the returned [`Event`]s carry, so the in-process broadcast and the durable row can never disagree. The
    /// redaction is deterministic and does not remove items: the identity key is computed from the redacted payload,
    /// so a replayed batch still deduplicates and a rollback/retry still inserts the same values.
    pub fn commit_batch(&self, c: BatchCommit<'_>) -> Result<Vec<Event>, StoreError> {
        let source = c.source;
        let home = crate::logging::redaction_home();
        let mut guard = self.conn.lock().expect("store lock");
        let tx = guard.transaction()?;
        apply_claims(&tx, source, c.claims, c.file_states, c.removed)?;
        let out = insert_events(
            &tx,
            source,
            c.items,
            c.identities,
            c.offsets.is_empty(),
            c.first_seq,
            home,
        )?;
        // Replace consumed offsets for this source.
        tx.execute(
            "DELETE FROM source_offsets WHERE source=?1",
            rusqlite::params![source],
        )?;
        let mut up =
            tx.prepare("INSERT INTO source_offsets(source,path,offset,size) VALUES (?1,?2,?3,?4)")?;
        for o in c.offsets {
            up.execute(rusqlite::params![
                source,
                o.path,
                o.offset as i64,
                o.size as i64
            ])?;
        }
        // Replace persisted parser/tail state for this source.
        tx.execute(
            "DELETE FROM source_file_state WHERE source=?1",
            rusqlite::params![source],
        )?;
        upsert_file_states(&tx, source, c.file_states)?;
        // Replace source-level revisions: a checkpoint-only advance is as durable as an event.
        tx.execute(
            "DELETE FROM source_revisions WHERE source=?1",
            rusqlite::params![source],
        )?;
        let mut rv = tx.prepare(
            "INSERT INTO source_revisions(source,name,value,updated) VALUES (?1,?2,?3,?4)",
        )?;
        for (name, value) in c.revisions {
            rv.execute(rusqlite::params![source, name, value, now_ms() as i64])?;
        }
        apply_tombstones(&tx, source, c.removed, c.reappeared)?;
        apply_generations(&tx, source, c.file_states, c.removed)?;
        drop(up);
        drop(rv);
        tx.commit()?;
        Ok(out)
    }

    /// One bounded checkpoint delta = events + changed file states + changed revisions + tombstones,
    /// atomically. Only rows the delta names are written: upserts are `INSERT ... ON CONFLICT DO
    /// UPDATE`, removed paths delete their own file-state/offset rows and gain a tombstone in the
    /// same transaction, reappeared paths lose their tombstone. A failure anywhere rolls the whole
    /// transaction back, so the prior committed checkpoint stays pending (in the caller's pending
    /// batch) until the tombstone and the checkpoint advancement commit together; retrying the
    /// exact same delta then commits once.
    pub fn commit_delta(&self, c: DeltaCommit<'_>) -> Result<Vec<Event>, StoreError> {
        let rows = c.file_states.len() + c.revisions.len() + c.removed.len();
        if rows > crate::core::MAX_CHECKPOINT_DELTA_ROWS {
            return Err(StoreError::DeltaTooLarge { rows });
        }
        let source = c.source;
        let home = crate::logging::redaction_home();
        let mut guard = self.conn.lock().expect("store lock");
        let tx = guard.transaction()?;
        apply_claims(&tx, source, c.claims, c.file_states, c.removed)?;
        let out = insert_events(
            &tx,
            source,
            c.items,
            c.identities,
            c.file_states.is_empty(),
            c.first_seq,
            home,
        )?;
        // Incremental offsets: upsert only the changed paths (columns are file-state-derived).
        {
            let mut up = tx.prepare(
                "INSERT INTO source_offsets(source,path,offset,size) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(source,path) DO UPDATE SET offset=excluded.offset, size=excluded.size",
            )?;
            for st in c.file_states {
                up.execute(rusqlite::params![
                    source,
                    st.path,
                    st.offset as i64,
                    st.size as i64
                ])?;
            }
        }
        upsert_file_states(&tx, source, c.file_states)?;
        // Changed revisions only; untouched revision keys are left alone.
        {
            let mut rv = tx.prepare(
                "INSERT INTO source_revisions(source,name,value,updated) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(source,name) DO UPDATE SET value=excluded.value, updated=excluded.updated",
            )?;
            for (name, value) in c.revisions {
                rv.execute(rusqlite::params![source, name, value, now_ms() as i64])?;
            }
        }
        // Removed paths: drop exactly their parser state, then tombstone (same transaction).
        for r in c.removed {
            tx.execute(
                "DELETE FROM source_file_state WHERE source=?1 AND path=?2",
                params![source, r.path],
            )?;
            tx.execute(
                "DELETE FROM source_offsets WHERE source=?1 AND path=?2",
                params![source, r.path],
            )?;
        }
        apply_tombstones(&tx, source, c.removed, c.reappeared)?;
        apply_generations(&tx, source, c.file_states, c.removed)?;
        tx.commit()?;
        Ok(out)
    }

    /// Durable source-level revisions for `source` (`SourceCheckpoint::revisions`).
    pub fn load_revisions(&self, source: &str) -> Result<BTreeMap<String, String>, StoreError> {
        self.with(|c| {
            let mut st =
                c.prepare("SELECT name,value FROM source_revisions WHERE source=?1 ORDER BY name")?;
            let rows = st.query_map([source], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect()
        })
    }

    /// Durable tombstones: paths this source stopped reporting and that have not reappeared.
    pub fn load_removed(&self, source: &str) -> Result<Vec<RemovedPath>, StoreError> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT path,generation,removed_ms FROM source_removed WHERE source=?1 ORDER BY path",
            )?;
            let rows = st.query_map([source], |r| {
                Ok(RemovedPath {
                    path: r.get(0)?,
                    generation: r.get::<_, i64>(1)? as u64,
                    removed_ms: r.get::<_, i64>(2)? as u64,
                })
            })?;
            rows.collect()
        })
    }

    /// Persistent logical-generation high-water for one (source, path). Seeded from v6 file state/removals on
    /// upgrade; monotonic thereafter. Returns 0 when no generation has been recorded yet. Pure read.
    pub fn load_generation(&self, source: &str, path: &str) -> Result<u64, StoreError> {
        self.with(|c| high_water_in(c, source, path))
    }

    /// All persistent logical-generation high-waters for one source, keyed by relative path.
    pub fn load_generations(&self, source: &str) -> Result<BTreeMap<String, u64>, StoreError> {
        self.with(|c| {
            let mut out = BTreeMap::new();
            let mut st = c.prepare(
                "SELECT path, generation FROM source_generations WHERE source=?1 ORDER BY path",
            )?;
            let rows = st.query_map([source], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })?;
            for r in rows {
                let (p, g) = r?;
                out.insert(p, g);
            }
            Ok(out)
        })
    }

    /// Side-effect-free candidate for the next logical generation of `(source, path)`: the durable high-water
    /// plus one. Reading a candidate persists nothing, so no caller can move the high-water before its batch is
    /// accepted; commit the paired [`GenerationClaim`] with that batch (see [`Store::commit_batch`]).
    pub fn candidate_generation(
        &self,
        source: &str,
        path: &str,
    ) -> Result<GenerationCandidate, StoreError> {
        let observed = self.load_generation(source, path)?;
        Ok(GenerationCandidate {
            path: path.to_string(),
            observed,
            generation: observed.saturating_add(1).max(1),
        })
    }

    /// Alias returning the current high-water (does not allocate).
    pub fn generation_high_water(&self, source: &str, path: &str) -> Result<u64, StoreError> {
        self.load_generation(source, path)
    }

    /// Producer identity keys stored for `source`, ordered by seq (test/diagnostic helper).
    pub fn producers(&self, source: &str) -> Result<Vec<String>, StoreError> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT producer FROM events WHERE source=?1 AND producer IS NOT NULL ORDER BY seq",
            )?;
            let rows = st.query_map([source], |r| r.get::<_, String>(0))?;
            rows.collect()
        })
    }

    /// Stores (upserts) one file's parser/tail state. Unused by adapters this round; see [`FileStateRow`].
    pub fn save_file_state(&self, st: &FileStateRow) -> Result<(), StoreError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO source_file_state(source,path,size,mtime_ms,fingerprint,session,model,updated,generation,offset,discarded_bytes,incomplete,announced,revision)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
                 ON CONFLICT(source,path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms,
                   fingerprint=excluded.fingerprint, session=excluded.session, model=excluded.model,
                   updated=excluded.updated, generation=excluded.generation, offset=excluded.offset,
                   discarded_bytes=excluded.discarded_bytes, incomplete=excluded.incomplete,
                   announced=excluded.announced, revision=excluded.revision",
                params![
                    st.source,
                    st.path,
                    st.size as i64,
                    st.mtime_ms as i64,
                    st.fingerprint,
                    st.session,
                    st.model,
                    now_ms() as i64,
                    st.generation as i64,
                    st.offset as i64,
                    st.discarded_bytes as i64,
                    st.incomplete as i64,
                    st.announced as i64,
                    st.revision
                ],
            )
            .map(|_| ())
        })
    }

    /// Stored file states for `source`, ordered by path.
    pub fn load_file_state(&self, source: &str) -> Result<Vec<FileStateRow>, StoreError> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT source,path,size,mtime_ms,fingerprint,session,model,generation,offset,discarded_bytes,incomplete,announced,revision FROM source_file_state
                 WHERE source=?1 ORDER BY path",
            )?;
            let rows = st.query_map([source], |r| {
                Ok(FileStateRow {
                    source: r.get(0)?,
                    path: r.get(1)?,
                    size: r.get::<_, i64>(2)? as u64,
                    mtime_ms: r.get::<_, i64>(3)? as u64,
                    fingerprint: r.get(4)?,
                    session: r.get(5)?,
                    model: r.get(6)?,
                    generation: r.get::<_, i64>(7)? as u64,
                    offset: r.get::<_, i64>(8)? as u64,
                    discarded_bytes: r.get::<_, i64>(9)? as u64,
                    incomplete: r.get::<_, i64>(10)? != 0,
                    announced: r.get::<_, i64>(11)? != 0,
                    revision: r.get(12)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Distinct session ids stored for `source`.
    pub fn session_count(&self, source: &str) -> Result<u64, StoreError> {
        self.with(|c| {
            c.query_row(
                "SELECT COUNT(DISTINCT session) FROM events WHERE source=?1 AND session IS NOT NULL",
                [source],
                |r| r.get::<_, i64>(0),
            )
        })
        .map(|v| v as u64)
    }
}

//! The one shared adapter I/O boundary: allowance-charged reads and a resumable directory enumerator.
//!
//! Every adapter (JSONL tail, harness snapshot, OpenCode snapshot, fake) goes through this module so the
//! deterministic trace and the application counters come from the same production code path. Three dimensions
//! are charged against one [`TurnBudget`]:
//!
//! * **bytes** — [`Allowance::grant`] happens *before* the read, the read is clamped to the grant, and only the
//!   bytes a short read did not return are released. An open/read error keeps its charge, so a path that always
//!   fails cannot be retried for free inside one turn.
//! * **entries** — one charge before each directory iterator advance, whether the entry matches, is a directory,
//!   is a symlink or comes back as an iterator error.
//! * **visits** — one charge before each per-item work unit (opening a directory, classifying one entry,
//!   visiting one known file, adopting a discovered/restored file, reconciling one absent candidate, comparing
//!   one saved checkpoint path).
//!
//! Returned-byte accounting also lives here, so the trace and the application counters come from one place:
//! [`read_lines`] records the content bytes it returned into `WorkStats.payload_bytes`,
//! [`read_lines_verify`] into `WorkStats.verify_bytes`, and every successful read records its returned byte
//! count on the turn's [`TurnBudget`] (`note_read` → `read_calls`/`returned_bytes`). [`read_bytes`] stays
//! unclassified because its callers use it for samples, document payloads and verification chunks and classify
//! the bytes themselves; the boundary never counts one read twice.
//!
//! This is application accounting. It is not kernel-level evidence and does not measure OS read-ahead.

use super::tail;
use super::{WorkStats, MAX_BYTES_PER_PASS, RAW_PROBE_HEADROOM};
use crate::core::{TurnBudget, TurnUsage};
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// One adapter call's view of a [`TurnBudget`].
///
/// The budget is shared by every phase of one scheduled turn; a standalone `detect`/`poll` (no `begin_turn`)
/// creates its own via [`Allowance::standalone`], so a direct call is bounded too.
pub struct Allowance {
    budget: Arc<TurnBudget>,
}

impl Allowance {
    pub fn new(budget: Arc<TurnBudget>) -> Self {
        Self { budget }
    }

    /// Standalone `detect`/`poll` (no scheduled turn): one independent allowance for this call.
    pub fn standalone() -> Self {
        Self::new(TurnBudget::default_allowance())
    }

    pub fn budget(&self) -> Arc<TurnBudget> {
        self.budget.clone()
    }

    /// Remaining **bytes**, minus the raw-probe headroom and never above one pass cap.
    pub fn remaining(&self) -> u64 {
        self.budget
            .remaining()
            .saturating_sub(RAW_PROBE_HEADROOM)
            .min(MAX_BYTES_PER_PASS)
    }

    pub fn bytes_exhausted(&self) -> bool {
        self.remaining() == 0
    }

    /// Bytes, entries or visits are spent: traversal must stop before advancing again.
    pub fn exhausted(&self) -> bool {
        self.bytes_exhausted() || self.budget.work_exhausted()
    }

    /// Charges bytes *before* the read and returns the grant; the caller must clamp its read to it.
    pub fn grant(&self, want: u64) -> u64 {
        if want == 0 {
            return 0;
        }
        self.budget.charge(want.min(self.remaining()))
    }

    pub fn release(&self, unused: u64) {
        if unused > 0 {
            self.budget.release(unused.min(self.budget.used()));
        }
    }

    /// Charges one returned directory entry, before the enumerator advances again.
    pub fn entry(&self) -> bool {
        self.budget.try_entry()
    }

    /// Charges one work visit, before the work happens.
    pub fn visit(&self) -> bool {
        self.budget.try_visit()
    }

    pub fn remaining_entries(&self) -> u64 {
        self.budget.remaining_entries()
    }

    pub fn remaining_visits(&self) -> u64 {
        self.budget.remaining_visits()
    }

    /// Cumulative usage of the turn this allowance belongs to (all phases).
    pub fn usage(&self) -> TurnUsage {
        self.budget.usage()
    }

    /// Records one successful read of `returned` bytes on the turn (bytes actually handed back, never the
    /// requested/granted count).
    fn note_read(&self, returned: usize) {
        self.budget.note_read(returned as u64);
    }
}

/// Result of a charged read: data, or "the allowance had nothing left, nothing was attempted".
#[derive(Debug)]
pub enum ReadOutcome<T> {
    Data(T),
    NoBudget,
}

/// Reads up to `want` bytes at `offset`. The request is charged against the allowance *before* the I/O; bytes
/// the file did not return (EOF) are released again. An error keeps the charge (a failed attempt is work).
pub fn read_bytes(
    path: &Path,
    offset: u64,
    want: usize,
    al: &Allowance,
    work: &mut WorkStats,
) -> std::io::Result<ReadOutcome<Vec<u8>>> {
    if want == 0 {
        return Ok(ReadOutcome::Data(Vec::new()));
    }
    let grant = al.grant(want as u64) as usize;
    if grant == 0 {
        return Ok(ReadOutcome::NoBudget);
    }
    let mut buf = vec![0u8; grant];
    let res = (|buf: &mut [u8]| -> std::io::Result<usize> {
        use std::io::{Seek, SeekFrom};
        work.opens += 1;
        let mut f = std::fs::File::open(path)?;
        f.seek(SeekFrom::Start(offset))?;
        let mut n = 0usize;
        while n < buf.len() {
            match f.read(&mut buf[n..]) {
                Ok(0) => break,
                Ok(k) => n += k,
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(n)
    })(&mut buf);
    match res {
        Ok(n) => {
            al.release((grant - n) as u64);
            // Returned-byte accounting stays caller-classified for this generic path (sample/document/verify).
            al.note_read(n);
            buf.truncate(n);
            Ok(ReadOutcome::Data(buf))
        }
        Err(e) => Err(e),
    }
}

/// Bounded **payload** line read: the request is charged before the I/O, only the bytes actually returned stay
/// charged, and those returned bytes are recorded in `WorkStats.payload_bytes` here — a caller must not add the
/// returned count again.
pub fn read_lines(
    path: &Path,
    offset: u64,
    want: usize,
    discard_pending: bool,
    al: &Allowance,
    work: &mut WorkStats,
) -> std::io::Result<ReadOutcome<(tail::ReadResult, u64)>> {
    read_lines_classified(
        path,
        offset,
        want,
        discard_pending,
        al,
        work,
        ReadClass::Payload,
    )
}

/// Bounded **verification** line read: identical charging to [`read_lines`], but the returned bytes are recorded
/// in `WorkStats.verify_bytes`.
pub fn read_lines_verify(
    path: &Path,
    offset: u64,
    want: usize,
    discard_pending: bool,
    al: &Allowance,
    work: &mut WorkStats,
) -> std::io::Result<ReadOutcome<(tail::ReadResult, u64)>> {
    read_lines_classified(
        path,
        offset,
        want,
        discard_pending,
        al,
        work,
        ReadClass::Verify,
    )
}

/// What a returned byte counts as in the application counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadClass {
    Payload,
    Verify,
}

fn read_lines_classified(
    path: &Path,
    offset: u64,
    want: usize,
    discard_pending: bool,
    al: &Allowance,
    work: &mut WorkStats,
    class: ReadClass,
) -> std::io::Result<ReadOutcome<(tail::ReadResult, u64)>> {
    if want == 0 {
        return Ok(ReadOutcome::NoBudget);
    }
    let grant = al.grant(want as u64) as usize;
    if grant == 0 {
        return Ok(ReadOutcome::NoBudget);
    }
    work.opens += 1;
    match tail::read_new_lines_budget_io(path, offset, grant, discard_pending) {
        Ok((res, used)) => {
            al.release(grant.saturating_sub(used as usize) as u64);
            al.note_read(used as usize);
            match class {
                ReadClass::Payload => work.payload_bytes += used,
                ReadClass::Verify => work.verify_bytes += used,
            }
            Ok(ReadOutcome::Data((res, used)))
        }
        // The attempt happened and is charged: a failing open cannot be retried for free this turn.
        Err(e) => Err(e),
    }
}

/// One step of a bounded directory enumeration.
#[derive(Debug)]
pub enum Step {
    /// A regular (or symlinked) file, already classified with one charged `stat`.
    File {
        path: PathBuf,
        meta: std::fs::Metadata,
    },
    /// A directory, already pushed on the walk's pending stack.
    Dir(PathBuf),
    /// The entry's metadata could not be read: an unproven path, never an absent one.
    MetaError(PathBuf),
    /// A directory could not be opened: everything inside it is unproven.
    Unreadable(PathBuf),
    /// The iterator itself returned an error: the sweep is incomplete.
    EntryError,
    /// No entry/visit allowance left. The walk stops **before** advancing again and continues from here.
    Budget,
    /// The tree was walked completely.
    End,
}

/// A bounded, resumable directory enumerator: one open `ReadDir` plus a pending-directory stack.
///
/// Nothing is materialised or sorted, no pass restarts at entry zero, and the walk keeps its place between
/// calls (and between turns) so a supported file behind more entries than one turn allows is still found.
/// A `std::fs::ReadDir` cannot be serialised: after a process restart the walk restarts from the root, which
/// is restart-safe because only a *completed error-free* sweep may prove anything absent.
#[derive(Debug, Default)]
pub struct DirWalk {
    dirs: VecDeque<PathBuf>,
    cur: Option<std::fs::ReadDir>,
    /// Entry taken from the iterator whose classification visit was not granted yet.
    pending: Option<PathBuf>,
}

impl DirWalk {
    pub fn start(root: &Path) -> Self {
        let mut dirs = VecDeque::new();
        dirs.push_back(root.to_path_buf());
        Self {
            dirs,
            cur: None,
            pending: None,
        }
    }

    /// Nothing left to walk and no iterator open.
    pub fn is_done(&self) -> bool {
        self.cur.is_none() && self.dirs.is_empty()
    }

    /// One bounded step. Charges an entry before advancing the iterator and a visit before any per-entry work.
    pub fn step(&mut self, al: &Allowance, work: &mut WorkStats) -> Step {
        loop {
            if let Some(path) = self.pending.take() {
                if !al.visit() {
                    self.pending = Some(path);
                    return Step::Budget;
                }
                work.stats += 1;
                return match std::fs::metadata(&path) {
                    Ok(m) if m.is_dir() => {
                        self.dirs.push_back(path.clone());
                        Step::Dir(path)
                    }
                    Ok(m) => Step::File { path, meta: m },
                    Err(_) => Step::MetaError(path),
                };
            }
            if self.cur.is_none() {
                let Some(dir) = self.dirs.pop_front() else {
                    return Step::End;
                };
                if !al.visit() {
                    self.dirs.push_front(dir);
                    return Step::Budget;
                }
                work.dirs += 1;
                match std::fs::read_dir(&dir) {
                    Ok(rd) => self.cur = Some(rd),
                    Err(_) => return Step::Unreadable(dir),
                }
                continue;
            }
            if !al.entry() {
                return Step::Budget;
            }
            work.entries += 1;
            match self.cur.as_mut().and_then(|rd| rd.next()) {
                None => self.cur = None,
                Some(Err(_)) => return Step::EntryError,
                Some(Ok(entry)) => self.pending = Some(entry.path()),
            }
        }
    }
}

//! Event bus: assigns a global monotonic `seq`, persists, then fans out.

use super::{
    now_ms, CheckpointDelta, Event, GenerationClaim, RecordKey, RemovedPath, SourceCheckpoint,
};
use crate::store::{BatchCommit, DeltaCommit, FileStateRow, Store, StoreError};
use std::sync::Mutex;
use tokio::sync::broadcast;

pub struct Bus {
    store: Store,
    next: Mutex<u64>,
    tx: broadcast::Sender<Event>,
}

impl Bus {
    /// Starts after the highest stored seq so numbers never repeat across restarts.
    pub fn new(store: Store) -> Result<Self, StoreError> {
        let last = store.max_seq()?;
        let (tx, _) = broadcast::channel(1024);
        Ok(Self {
            store,
            next: Mutex::new(last + 1),
            tx,
        })
    }

    /// Publishes one daemon event: the payload is redacted before the row is written, so the stored event, the
    /// returned value and the broadcast copy are the same redacted payload.
    pub fn publish(
        &self,
        kind: &str,
        source: &str,
        data: serde_json::Value,
    ) -> Result<Event, StoreError> {
        let mut next = self.next.lock().expect("bus lock");
        let ev = Event {
            seq: *next,
            kind: kind.to_string(),
            source: source.to_string(),
            ts: now_ms(),
            data: crate::logging::redact_json(&data),
        };
        self.store.insert_event(&ev)?;
        *next += 1;
        let _ = self.tx.send(ev.clone());
        Ok(ev)
    }

    /// One durable source write: events, offsets, the whole checkpoint (files + revisions), path tombstones and the
    /// producer identity of each item. Everything lands in ONE SQLite transaction, so a failure leaves the pending
    /// batch untouched and retryable, and a success is either fully there or not at all. The returned events are the
    /// redacted payloads `Store::commit_batch` stored, and they are what is broadcast.
    pub fn commit(
        &self,
        source: &str,
        items: &[super::BatchItem],
        checkpoint: &SourceCheckpoint,
        removed: &[RemovedPath],
        reappeared: &[String],
        identities: &[RecordKey],
    ) -> Result<Vec<Event>, StoreError> {
        self.commit_claimed(
            source,
            items,
            checkpoint,
            removed,
            reappeared,
            identities,
            &[],
        )
    }

    /// One durable source write from a bounded [`CheckpointDelta`]: the batch's events, only the
    /// delta's changed file states/revisions, and its removal candidates (tombstone + file-state
    /// deletion together) land in ONE SQLite transaction via [`Store::commit_delta`]. The delta row
    /// ceiling is validated **before** any conversion or write; an oversized delta is refused
    /// wholesale, never partially applied. A failure leaves the caller's pending delta untouched
    /// for exact retry and publishes nothing.
    pub fn commit_delta(
        &self,
        source: &str,
        items: &[super::BatchItem],
        delta: &CheckpointDelta,
        reappeared: &[String],
        identities: &[RecordKey],
    ) -> Result<Vec<Event>, StoreError> {
        self.commit_delta_claimed(source, items, delta, reappeared, identities, &[])
    }

    /// [`Bus::commit_delta`] plus optimistic logical-generation claims (same transaction).
    #[allow(clippy::too_many_arguments)]
    pub fn commit_delta_claimed(
        &self,
        source: &str,
        items: &[super::BatchItem],
        delta: &CheckpointDelta,
        reappeared: &[String],
        identities: &[RecordKey],
        claims: &[GenerationClaim],
    ) -> Result<Vec<Event>, StoreError> {
        // Validate before allocating the conversion vectors or touching the store.
        if delta.check_bounds().is_err() {
            return Err(StoreError::DeltaTooLarge {
                rows: delta.row_count(),
            });
        }
        let file_states: Vec<FileStateRow> = delta
            .upserts
            .iter()
            .map(|f| FileStateRow {
                source: source.to_string(),
                path: f.path.clone(),
                size: f.size,
                mtime_ms: f.mtime_ms,
                fingerprint: f.fingerprint.clone(),
                session: f.session.clone(),
                model: f.model.clone(),
                generation: f.generation,
                offset: f.offset,
                discarded_bytes: f.discarded_bytes,
                incomplete: f.incomplete,
                announced: f.announced,
                revision: f.revision.clone(),
            })
            .collect();
        let mut next = self.next.lock().expect("bus lock");
        let evs = self.store.commit_delta(DeltaCommit {
            source,
            items,
            file_states: &file_states,
            revisions: &delta.revisions,
            removed: &delta.removed,
            reappeared,
            identities,
            claims,
            first_seq: *next,
        })?;
        *next += evs.len() as u64;
        for e in &evs {
            let _ = self.tx.send(e.clone());
        }
        Ok(evs)
    }

    /// [`Bus::commit`] plus optimistic logical-generation claims: the claims compare-and-advance the durable
    /// high-water inside the same transaction as the events/checkpoint/tombstones. A stale claim
    /// (`StoreError::GenerationConflict`) writes nothing and publishes nothing. Adapters never precommit a
    /// generation; this is the only place a new high-water can become durable.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_claimed(
        &self,
        source: &str,
        items: &[super::BatchItem],
        checkpoint: &SourceCheckpoint,
        removed: &[RemovedPath],
        reappeared: &[String],
        identities: &[RecordKey],
        claims: &[GenerationClaim],
    ) -> Result<Vec<Event>, StoreError> {
        let offsets: Vec<super::FileOffset> = checkpoint
            .files
            .iter()
            .map(|f| super::FileOffset {
                path: f.path.clone(),
                offset: f.offset,
                size: f.size,
            })
            .collect();
        let file_states: Vec<FileStateRow> = checkpoint
            .files
            .iter()
            .map(|f| FileStateRow {
                source: source.to_string(),
                path: f.path.clone(),
                size: f.size,
                mtime_ms: f.mtime_ms,
                fingerprint: f.fingerprint.clone(),
                session: f.session.clone(),
                model: f.model.clone(),
                generation: f.generation,
                offset: f.offset,
                discarded_bytes: f.discarded_bytes,
                incomplete: f.incomplete,
                announced: f.announced,
                revision: f.revision.clone(),
            })
            .collect();
        let mut next = self.next.lock().expect("bus lock");
        let evs = self.store.commit_batch(BatchCommit {
            source,
            items,
            offsets: &offsets,
            file_states: &file_states,
            revisions: &checkpoint.revisions,
            removed,
            reappeared,
            identities,
            claims,
            first_seq: *next,
        })?;
        *next += evs.len() as u64;
        for e in &evs {
            let _ = self.tx.send(e.clone());
        }
        Ok(evs)
    }

    /// Stores a source batch plus its offsets in one transaction, then fans the stored events out.
    /// Duplicates (dedup key) are skipped and consume no seq.
    pub fn append_batch(
        &self,
        source: &str,
        items: &[super::BatchItem],
        offsets: &[super::FileOffset],
    ) -> Result<Vec<Event>, StoreError> {
        let mut next = self.next.lock().expect("bus lock");
        let evs = self.store.append_batch_at(source, items, offsets, *next)?;
        *next += evs.len() as u64;
        for e in &evs {
            let _ = self.tx.send(e.clone());
        }
        Ok(evs)
    }

    /// Stores a source batch plus its offsets and per-file parser state in one transaction.
    pub fn append_batch_with_state(
        &self,
        source: &str,
        items: &[super::BatchItem],
        offsets: &[super::FileOffset],
        file_states: &[FileStateRow],
    ) -> Result<Vec<Event>, StoreError> {
        let mut next = self.next.lock().expect("bus lock");
        let evs =
            self.store
                .append_batch_at_with_state(source, items, offsets, file_states, *next)?;
        *next += evs.len() as u64;
        for e in &evs {
            let _ = self.tx.send(e.clone());
        }
        Ok(evs)
    }

    /// Alias for [`append_batch_with_state`].
    pub fn append_batch_with_files(
        &self,
        source: &str,
        items: &[super::BatchItem],
        offsets: &[super::FileOffset],
        file_states: &[FileStateRow],
    ) -> Result<Vec<Event>, StoreError> {
        self.append_batch_with_state(source, items, offsets, file_states)
    }

    /// Stores a source batch plus a durable checkpoint in one transaction (legacy signature: no tombstones and
    /// no producer identities).
    pub fn append_batch_with_checkpoint(
        &self,
        source: &str,
        items: &[super::BatchItem],
        _offsets: &[super::FileOffset],
        checkpoint: &SourceCheckpoint,
    ) -> Result<Vec<Event>, StoreError> {
        self.commit(source, items, checkpoint, &[], &[], &[])
    }

    pub fn last_seq(&self) -> u64 {
        *self.next.lock().expect("bus lock") - 1
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_is_monotonic_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.db");
        {
            let bus = Bus::new(Store::open(&path).unwrap()).unwrap();
            let mut rx = bus.subscribe();
            assert_eq!(bus.publish("a", "t", serde_json::json!({})).unwrap().seq, 1);
            assert_eq!(bus.publish("b", "t", serde_json::json!({})).unwrap().seq, 2);
            assert_eq!(rx.try_recv().unwrap().seq, 1);
        }
        let bus = Bus::new(Store::open(&path).unwrap()).unwrap();
        assert_eq!(bus.last_seq(), 2);
        assert_eq!(bus.publish("c", "t", serde_json::json!({})).unwrap().seq, 3);
    }
}

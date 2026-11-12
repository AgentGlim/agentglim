-- 0006: stable producer identity, source-level revisions and durable path tombstones.
--
-- `producer` holds the opaque `RecordKey::key()` of the observation the producer emitted (offset-based record:
-- path + logical generation + record position + emitted-item index; snapshot: namespace + durable semantic
-- revision + emitted-item index). It is not a content hash and not a per-batch index, so it survives bounded
-- batching, repartitioning and a restart while still keeping a genuine A -> B -> A as three rows.
-- NULL = this row carries no producer identity: legacy rows, or a source whose adapter does not supply one yet
-- (then `occurrence` from 0004 remains the identity policy).
ALTER TABLE events ADD COLUMN producer TEXT;
CREATE UNIQUE INDEX events_producer ON events(producer) WHERE producer IS NOT NULL;

-- Source-level durable revisions (snapshot rounds, semantic counters). Committed in the same transaction as the
-- events/offsets/file state and restored before the first poll, so a checkpoint-only change is durable too.
CREATE TABLE source_revisions (
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (source, name)
);

-- Paths a source used to report and no longer does. Written only after a completed discovery sweep proved the
-- absence, deleted when the path reappears; the matching `source_file_state` and `source_offsets` rows are
-- removed in the same transaction so a removed path cannot inherit a stale cursor.
CREATE TABLE source_removed (
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  removed_ms INTEGER NOT NULL,
  PRIMARY KEY (source, path)
);

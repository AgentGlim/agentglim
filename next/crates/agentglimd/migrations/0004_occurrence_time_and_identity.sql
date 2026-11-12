-- 0004: occurrence (source) time, stable observation identity and persisted per-file parser state.
--
-- `occurred_ms` is when the source says an observation happened (0 = the source carries no time).
-- `ts` keeps its old meaning: the observation time (when this daemon read the record).
-- `occurrence` identifies one observation of a source that has NO file offsets (plans-harness, fake).
-- It is NULL for offset-bearing sources: their file offset already identifies the record.
-- The partial unique index therefore only deduplicates the sources that need it.
-- The older `dedup` column (0003) is frozen: new rows leave it NULL, `occurrence` carries identity instead.
ALTER TABLE events ADD COLUMN occurred_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN occurrence TEXT;
CREATE UNIQUE INDEX events_occurrence ON events(occurrence) WHERE occurrence IS NOT NULL;
CREATE INDEX events_occurred_ms ON events(occurred_ms);

-- Parser/tail state per watched file, so a restart can resume without re-reading or skipping input.
-- Adapters keep this state in memory this round (v2-r2 wires the persistence); the table and the
-- store round-trip exist so that wiring needs no further migration.
CREATE TABLE source_file_state (
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  session TEXT,
  model TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (source, path)
);

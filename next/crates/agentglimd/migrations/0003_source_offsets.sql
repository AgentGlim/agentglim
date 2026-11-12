CREATE TABLE source_offsets (
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (source, path)
);
ALTER TABLE events ADD COLUMN session TEXT;
ALTER TABLE events ADD COLUMN dedup TEXT;
CREATE UNIQUE INDEX events_dedup ON events(dedup) WHERE dedup IS NOT NULL;
CREATE INDEX events_source_session ON events(source, session);

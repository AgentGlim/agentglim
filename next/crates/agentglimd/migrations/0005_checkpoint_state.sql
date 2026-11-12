ALTER TABLE source_file_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_file_state ADD COLUMN offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_file_state ADD COLUMN discarded_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_file_state ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_file_state ADD COLUMN announced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_file_state ADD COLUMN revision TEXT;

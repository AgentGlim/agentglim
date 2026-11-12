ALTER TABLE tasks ADD COLUMN detail TEXT NOT NULL DEFAULT '';
CREATE INDEX events_ts ON events(ts);
CREATE INDEX tasks_state ON tasks(state);

-- 0007: persistent logical generation high-water per (source, path).
--
-- Generation is no longer derived from device/inode: it is a monotonic logical counter owned by core and
-- persisted here, keyed by source + relative path. There is no autocommit allocator: a candidate
-- (`Store::candidate_generation`) is side-effect free, and its claim is compare-and-advanced in the same
-- transaction as the batch that commits the file state and producer identities
-- (`Store::commit_batch` / `Bus::commit_claimed`). Existing v6 rows seed the high-water so old history is
-- preserved and never replayed under a colliding key.
CREATE TABLE source_generations (
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, path)
);

-- Seed from persisted file parser state.
INSERT INTO source_generations(source, path, generation, updated)
SELECT source, path, MAX(generation), COALESCE(MAX(updated), 0)
FROM source_file_state
GROUP BY source, path
ON CONFLICT(source, path) DO UPDATE SET
  generation = CASE WHEN excluded.generation > source_generations.generation
                    THEN excluded.generation ELSE source_generations.generation END,
  updated = CASE WHEN excluded.generation > source_generations.generation
                 THEN excluded.updated ELSE source_generations.updated END;

-- Seed from durable removal tombstones.
INSERT INTO source_generations(source, path, generation, updated)
SELECT source, path, generation, removed_ms
FROM source_removed
GROUP BY source, path
ON CONFLICT(source, path) DO UPDATE SET
  generation = CASE WHEN excluded.generation > source_generations.generation
                    THEN excluded.generation ELSE source_generations.generation END,
  updated = CASE WHEN excluded.generation > source_generations.generation
                 THEN excluded.updated ELSE source_generations.updated END;

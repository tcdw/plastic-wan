ALTER TABLE stickers ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stickers ADD COLUMN next_retry_at TEXT;
CREATE INDEX stickers_index_queue_idx ON stickers(active, index_state, next_retry_at, id);

ALTER TABLE buckets
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'realtime'
  CHECK (kind IN ('realtime', 'startup_catch_up'));

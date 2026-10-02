-- Image generation domain tables. The Drizzle definitions live in
-- packages/image-service (exported as the image schema); this migration is the
-- authoritative DDL for the shared host database. JSON columns use json_valid
-- checks per the host migration style.
CREATE TABLE image_prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX image_prompts_deleted_idx ON image_prompts(deleted_at);

CREATE TABLE image_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('upload', 'generation')),
  generation_id TEXT,
  output_index INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX image_assets_deleted_idx ON image_assets(deleted_at);
CREATE INDEX image_assets_generation_idx ON image_assets(generation_id);

CREATE TABLE image_generations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'interrupted')),
  source TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  config_version TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
) STRICT;

CREATE INDEX image_generations_created_idx ON image_generations(created_at DESC);
CREATE INDEX image_generations_status_idx ON image_generations(status);

CREATE TABLE image_generation_attempts (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES image_generations(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  item_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  provider_request_id TEXT,
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  output_asset_id TEXT
) STRICT;

CREATE UNIQUE INDEX image_attempts_round_item_idx ON image_generation_attempts(generation_id, round, item_index);
CREATE INDEX image_attempts_generation_idx ON image_generation_attempts(generation_id);

CREATE TABLE image_idempotency_keys (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX image_idempotency_actor_operation_key_idx ON image_idempotency_keys(actor_id, operation, key);

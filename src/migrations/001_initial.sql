CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  chat_type TEXT,
  received_at TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  rejection_reason TEXT,
  raw_json TEXT,
  CHECK ((allowed = 1 AND raw_json IS NOT NULL) OR (allowed = 0 AND raw_json IS NULL))
) STRICT;

CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  telegram_chat_id INTEGER NOT NULL UNIQUE,
  canonical_chat_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE chat_migrations (
  old_chat_id INTEGER PRIMARY KEY,
  new_chat_id INTEGER NOT NULL UNIQUE,
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_thread_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, message_thread_id)
) STRICT;

CREATE TABLE senders (
  id INTEGER PRIMARY KEY,
  telegram_type TEXT NOT NULL CHECK (telegram_type IN ('user', 'sender_chat')),
  telegram_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  updated_at TEXT NOT NULL,
  UNIQUE (telegram_type, telegram_id)
) STRICT;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  telegram_message_id INTEGER NOT NULL,
  current_revision_id INTEGER,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sent_by_bot INTEGER NOT NULL DEFAULT 0 CHECK (sent_by_bot IN (0, 1)),
  telegram_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (chat_id, telegram_message_id),
  FOREIGN KEY (current_revision_id) REFERENCES message_revisions(id)
) STRICT;

CREATE TABLE message_revisions (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  sender_id INTEGER REFERENCES senders(id),
  kind TEXT NOT NULL,
  text TEXT,
  caption TEXT,
  reply_to_message_id INTEGER,
  reply_snapshot_json TEXT,
  forward_origin_json TEXT,
  media_group_id TEXT,
  service_json TEXT,
  created_at TEXT NOT NULL,
  raw_fragment_json TEXT NOT NULL,
  UNIQUE (message_id, revision_no)
) STRICT;

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES message_revisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'document', 'sticker')),
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  telegram_json TEXT NOT NULL
) STRICT;

CREATE INDEX media_revision_idx ON media(revision_id);
CREATE INDEX media_unique_idx ON media(file_unique_id);

CREATE TABLE buckets (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('collecting', 'queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')),
  first_received_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  merged_into_bucket_id INTEGER REFERENCES buckets(id),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_collecting_bucket_per_conversation
  ON buckets(conversation_id) WHERE state = 'collecting';
CREATE INDEX buckets_schedule_idx ON buckets(state, deadline_at, id);

CREATE TABLE bucket_messages (
  bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  source_bucket_id INTEGER,
  PRIMARY KEY (bucket_id, message_id),
  UNIQUE (bucket_id, sequence_no)
) WITHOUT ROWID, STRICT;

CREATE TABLE invocations (
  id INTEGER PRIMARY KEY,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')),
  config_hash TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  tool_registry_hash TEXT,
  started_at TEXT,
  finished_at TEXT,
  completion_reason TEXT,
  error_code TEXT,
  sends_used INTEGER NOT NULL DEFAULT 0,
  tool_calls_used INTEGER NOT NULL DEFAULT 0,
  turns_used INTEGER NOT NULL DEFAULT 0,
  side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effect_started IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_running_invocation_per_conversation
  ON invocations(conversation_id) WHERE state = 'running';
CREATE INDEX invocations_queue_idx ON invocations(state, id);

CREATE TABLE invocation_messages (
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  revision_id INTEGER NOT NULL REFERENCES message_revisions(id),
  section TEXT NOT NULL CHECK (section IN ('history', 'new')),
  sequence_no INTEGER NOT NULL,
  source_bucket_id INTEGER,
  omitted_before INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (invocation_id, sequence_no)
) WITHOUT ROWID, STRICT;

CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE CASCADE,
  media_analysis_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('agent', 'vision_chat', 'vision_sticker', 'doctor')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost REAL,
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('assistant', 'tool_result')),
  text TEXT NOT NULL,
  thinking_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (invocation_id, sequence_no),
  CHECK (thinking_text = '')
) STRICT;

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL UNIQUE,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  result_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')),
  side_effect INTEGER NOT NULL CHECK (side_effect IN (0, 1)),
  error_code TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE telegram_sends (
  id INTEGER PRIMARY KEY,
  tool_call_id INTEGER NOT NULL REFERENCES tool_calls(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'sticker')),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'outcome_unknown')),
  telegram_message_id INTEGER,
  response_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE media_analyses (
  id INTEGER PRIMARY KEY,
  file_unique_id TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'sticker')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error')),
  description TEXT,
  metadata_json TEXT,
  expires_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (file_unique_id, analysis_version)
) STRICT;

CREATE TABLE sticker_sets (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  telegram_name TEXT NOT NULL UNIQUE,
  title TEXT,
  configured INTEGER NOT NULL DEFAULT 1 CHECK (configured IN (0, 1)),
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'running', 'success', 'error')),
  last_synced_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE stickers (
  id INTEGER PRIMARY KEY,
  sticker_set_id INTEGER NOT NULL REFERENCES sticker_sets(id) ON DELETE CASCADE,
  file_unique_id TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL,
  emoji TEXT,
  format TEXT NOT NULL CHECK (format IN ('static', 'animated', 'video')),
  thumbnail_json TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  current_analysis_id INTEGER REFERENCES media_analyses(id),
  index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending', 'running', 'success', 'error')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE sticker_search USING fts5(
  sticker_id UNINDEXED,
  description,
  tokenize = 'trigram'
);

CREATE TABLE daily_usage (
  utc_date TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  amount INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (utc_date, scope, resource, metric)
) WITHOUT ROWID, STRICT;

CREATE TABLE mcp_server_state (
  alias TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'degraded', 'stopped')),
  registry_hash TEXT,
  reconnect_attempt INTEGER NOT NULL DEFAULT 0,
  next_reconnect_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;

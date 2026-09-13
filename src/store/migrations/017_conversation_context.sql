-- Conversation Context: one persistent canonical history per Conversation
-- (chat + Forum Topic). It is the source of truth the agent transcript is
-- seeded from and written back to, and it survives process restarts.
--
-- `context_messages` stores complete AgentMessage JSON so the transcript can be
-- replayed exactly; `agent_messages` stays the flattened, human-readable audit
-- trail. Growth is bounded by checkpoint + discard-only GC: `head_seq` is the
-- first retained row and every retained segment starts at a checkpoint.
CREATE TABLE conversation_contexts (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  head_seq INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  send_count_total INTEGER NOT NULL DEFAULT 0,
  system_prompt_hash TEXT NOT NULL,
  active_invocation_id INTEGER REFERENCES invocations(id),
  last_active_at TEXT NOT NULL,
  last_gc_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_messages (
  context_id INTEGER NOT NULL REFERENCES conversation_contexts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
  payload_json TEXT NOT NULL,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL,
  is_checkpoint INTEGER NOT NULL DEFAULT 0,
  send_seq INTEGER,
  est_tokens INTEGER NOT NULL,
  evicted_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_id, seq)
) STRICT;

CREATE INDEX context_messages_checkpoint_idx ON context_messages(context_id, is_checkpoint, seq);
CREATE INDEX context_messages_evicted_idx ON context_messages(evicted_at);

-- Capability references (media, sticker, reply target) live for the whole
-- Conversation Context instead of one invocation, with a TTL. `source_seq` is
-- the context message that carried the reference: a reference whose source has
-- been evicted is no longer authorized.
CREATE TABLE context_refs (
  context_id INTEGER NOT NULL REFERENCES conversation_contexts(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('media', 'sticker', 'reply')),
  source_seq INTEGER NOT NULL,
  media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
  sticker_file_id TEXT,
  target_conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  target_thread_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_id, ref)
) STRICT;

CREATE INDEX context_refs_expiry_idx ON context_refs(expires_at);

-- Bucket-to-invocation join table: one invocation may consume many buckets.
-- `invocations.bucket_id` stays as the opening bucket for existing queries.
-- `injected_at` is NULL until the batch actually reached the agent transcript,
-- so a bucket attached to an invocation that ended first can be re-queued
-- instead of being silently dropped.
CREATE TABLE invocation_buckets (
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL,
  injected_at TEXT,
  PRIMARY KEY (invocation_id, bucket_id)
) STRICT;

CREATE INDEX invocation_buckets_bucket_idx ON invocation_buckets(bucket_id);

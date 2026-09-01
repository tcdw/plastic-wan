ALTER TABLE alarms ADD COLUMN created_by_user_id INTEGER;

CREATE INDEX alarms_created_by_user_pending_idx
  ON alarms(conversation_id, created_by_user_id, scheduled_at, id)
  WHERE state = 'pending' AND created_by_user_id IS NOT NULL;

CREATE TABLE internal_contexts (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  source_agent_message_id INTEGER REFERENCES agent_messages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX internal_contexts_conversation_idx
  ON internal_contexts(conversation_id, observed_at DESC, id DESC);
CREATE INDEX internal_contexts_invocation_idx ON internal_contexts(invocation_id);

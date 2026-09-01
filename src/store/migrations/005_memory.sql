CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 150),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX memories_conversation_created_idx ON memories(conversation_id, created_at);
CREATE INDEX memories_expiry_idx ON memories(expires_at);

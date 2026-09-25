-- `/cut_topic` cuts one Conversation (chat + Forum Topic). The cutoff used to be
-- stored per chat, so cutting topic A also hid older history from topic B's
-- future batches while B's retained Context kept those same messages.
CREATE TABLE conversation_context_cutoffs (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  telegram_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- The command message is never stored, so an existing chat-wide cutoff cannot be
-- traced back to its topic. Every conversation of that chat keeps it, which is
-- exactly the effect it had before this migration.
INSERT INTO conversation_context_cutoffs (conversation_id, telegram_message_id, created_at, updated_at)
SELECT v.id, c.telegram_message_id, c.created_at, c.updated_at
FROM chat_context_cutoffs c
JOIN conversations v ON v.chat_id = c.chat_id;

DROP TABLE chat_context_cutoffs;

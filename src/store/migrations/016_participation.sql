-- Post-trigger attention window: while `expires_at` is in the future, a
-- conversation whose chat is outside its scheduled active periods still starts
-- an invocation for any eligible message. Rows are keyed by conversation so a
-- Forum Topic keeps its own window; expired rows are meaningless and only the
-- retention cleanup removes them.
CREATE TABLE conversation_attention (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('mention', 'reply_to_bot', 'keyword')),
  trigger_telegram_message_id INTEGER,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX conversation_attention_expiry_idx ON conversation_attention(expires_at);

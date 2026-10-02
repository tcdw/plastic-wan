-- Generated-picture delivery: telegram_sends gains the 'image' kind.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt in place;
-- nothing references telegram_sends, and rows are moved 1:1.

CREATE TABLE telegram_sends_new (
  id INTEGER PRIMARY KEY,
  tool_call_id INTEGER NOT NULL REFERENCES tool_calls(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'sticker', 'image')),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'error', 'outcome_unknown')),
  telegram_message_id INTEGER,
  response_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

INSERT INTO telegram_sends_new
  (id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, error_code, created_at, finished_at)
SELECT
  id, tool_call_id, conversation_id, kind, request_json, state, telegram_message_id, response_json, error_code, created_at, finished_at
FROM telegram_sends;

DROP TABLE telegram_sends;
ALTER TABLE telegram_sends_new RENAME TO telegram_sends;

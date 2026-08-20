CREATE TABLE bot_admins (
  telegram_user_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

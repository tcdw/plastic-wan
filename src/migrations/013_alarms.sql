CREATE TABLE alarms (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_user_id INTEGER NOT NULL CHECK (target_user_id > 0),
  target_display_name TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  scheduled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'firing', 'fired', 'cancelled')),
  fired_at TEXT,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL,
  invocation_outcome TEXT,
  completion_reason TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  admin_cancelled INTEGER NOT NULL DEFAULT 0 CHECK (admin_cancelled IN (0, 1)),
  cancel_reason TEXT,
  updated_at TEXT NOT NULL,
  CHECK (scheduled_at > created_at)
) STRICT;

CREATE INDEX alarms_schedule_idx ON alarms(state, scheduled_at, id);
CREATE INDEX alarms_invocation_idx ON alarms(invocation_id);
CREATE INDEX alarms_created_by_idx ON alarms(created_by_invocation_id);

CREATE TABLE long_tasks (
  id INTEGER PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by_invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL,
  created_by_user_id INTEGER,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 16384),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'completed', 'failed', 'cancelled')),
  scheduled_at TEXT,
  timer_result_json TEXT CHECK (timer_result_json IS NULL OR (json_valid(timer_result_json) AND length(CAST(timer_result_json AS BLOB)) <= 16384)),
  delivery_json TEXT NOT NULL CHECK (json_valid(delivery_json) AND length(CAST(delivery_json AS BLOB)) <= 4096),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((scheduled_at IS NULL) = (timer_result_json IS NULL))
) STRICT;

CREATE TABLE task_receipts (
  task_id INTEGER PRIMARY KEY REFERENCES long_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 16384)),
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) AND length(CAST(error_json AS BLOB)) <= 8192)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'handled', 'suppressed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  handled_at TEXT,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE SET NULL,
  invocation_outcome TEXT,
  completion_reason TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  admin_cancelled INTEGER NOT NULL DEFAULT 0 CHECK (admin_cancelled IN (0, 1)),
  cancel_reason TEXT,
  CHECK ((status = 'completed' AND error_json IS NULL)
      OR (status = 'failed' AND result_json IS NULL)
      OR (status = 'cancelled' AND result_json IS NULL AND error_json IS NULL))
) STRICT;

CREATE UNIQUE INDEX task_receipts_invocation_unique ON task_receipts(invocation_id) WHERE invocation_id IS NOT NULL;
CREATE INDEX long_tasks_schedule_idx ON long_tasks(state, scheduled_at, id) WHERE state = 'waiting' AND scheduled_at IS NOT NULL;
CREATE INDEX long_tasks_plugin_conversation_idx ON long_tasks(plugin_id, conversation_id, created_at, id);
CREATE INDEX long_tasks_created_by_inv_idx ON long_tasks(created_by_invocation_id);
CREATE INDEX task_receipts_delivery_idx ON task_receipts(state, created_at, task_id) WHERE state = 'pending';

INSERT INTO long_tasks (
  id, plugin_id, conversation_id, created_by_invocation_id, created_by_user_id,
  payload_json, state, scheduled_at, timer_result_json, delivery_json, created_at, updated_at, finished_at
)
SELECT a.id, 'alarm', a.conversation_id, a.created_by_invocation_id, a.created_by_user_id,
  json_object(
    'target_user_id', CAST(a.target_user_id AS TEXT),
    'target_display_name', a.target_display_name,
    'summary', a.summary
  ),
  CASE a.state WHEN 'pending' THEN 'waiting' WHEN 'cancelled' THEN 'cancelled' ELSE 'completed' END,
  a.scheduled_at,
  json_object(
    'target_user_id', CAST(a.target_user_id AS TEXT),
    'target_display_name', a.target_display_name,
    'summary', a.summary
  ),
  json_object(
    'bypassDailyBudget', json('true'),
    'mentionUser', json_object('userId', CAST(a.target_user_id AS TEXT), 'displayName', a.target_display_name)
  ),
  a.created_at,
  a.updated_at,
  CASE
    WHEN a.state IN ('firing', 'fired') THEN COALESCE(a.fired_at, a.updated_at)
    WHEN a.state = 'cancelled' THEN COALESCE(a.cancelled_at, a.fired_at, a.updated_at)
  END
FROM alarms a;

INSERT INTO task_receipts (
  task_id, status, result_json, state, created_at, updated_at, claimed_at, handled_at,
  invocation_id, invocation_outcome, completion_reason, cancelled_at, cancelled_by, admin_cancelled, cancel_reason
)
SELECT a.id,
  CASE WHEN a.state = 'cancelled' THEN 'cancelled' ELSE 'completed' END,
  CASE WHEN a.state IN ('firing', 'fired') THEN json_object(
    'target_user_id', CAST(a.target_user_id AS TEXT),
    'target_display_name', a.target_display_name,
    'summary', a.summary
  ) END,
  CASE a.state WHEN 'firing' THEN 'claimed' WHEN 'fired' THEN 'handled' ELSE 'suppressed' END,
  a.created_at,
  a.updated_at,
  CASE WHEN a.fired_at IS NOT NULL THEN a.fired_at END,
  CASE WHEN a.state = 'fired' THEN COALESCE(a.fired_at, a.updated_at) END,
  a.invocation_id,
  a.invocation_outcome,
  a.completion_reason,
  a.cancelled_at,
  a.cancelled_by,
  a.admin_cancelled,
  a.cancel_reason
FROM alarms a
WHERE a.state IN ('firing', 'fired', 'cancelled');

DROP TABLE alarms;

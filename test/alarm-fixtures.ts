import { loadPlugins } from '../src/plugins/plugin.ts';
import alarmPlugin from '../src/plugins/alarm/index.ts';
import type { RawConfig } from '../src/platform/config.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import type { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';

export function alarmTools(store: SqliteStore, config: RawConfig, context: InvocationContext) {
  const capabilities = loadPlugins([alarmPlugin]).capabilities(
    store,
    config,
    context,
    Date.now() + 60_000,
    new LongTaskService(store.orm),
  );
  const alarm = capabilities.find((entry) => entry.tool.name === 'alarm')?.tool;
  const listAlarm = capabilities.find((entry) => entry.tool.name === 'list_alarm')?.tool;
  const deleteAlarm = capabilities.find((entry) => entry.tool.name === 'delete_alarm')?.tool;
  if (alarm === undefined || listAlarm === undefined || deleteAlarm === undefined) {
    throw new Error('Alarm plugin tools are missing');
  }
  return { alarm, list_alarm: listAlarm, delete_alarm: deleteAlarm };
}

export interface AlarmTaskProjection {
  readonly id: bigint;
  readonly task_state: string;
  readonly receipt_state: string | null;
  readonly state: string;
  readonly invocation_id: bigint | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancel_reason: string | null;
  readonly admin_cancelled: bigint | null;
}

export function getAlarmTask(store: SqliteStore, taskId: bigint): AlarmTaskProjection | undefined {
  return store.db
    .prepare<[bigint], AlarmTaskProjection>(
      `SELECT lt.id, lt.state AS task_state, tr.state AS receipt_state,
            CASE
              WHEN lt.state = 'cancelled' OR tr.state = 'suppressed' THEN 'cancelled'
              WHEN tr.state = 'claimed' THEN 'firing'
              WHEN tr.state = 'handled' THEN 'fired'
              ELSE 'pending'
            END AS state,
            tr.invocation_id, tr.invocation_outcome, tr.completion_reason,
            tr.cancel_reason, tr.admin_cancelled
       FROM long_tasks lt
       LEFT JOIN task_receipts tr ON tr.task_id = lt.id
      WHERE lt.plugin_id = 'alarm' AND lt.id = ?`,
    )
    .get(taskId);
}

export function insertAlarmTask(
  store: SqliteStore,
  conversationId: bigint,
  targetUserId: bigint,
  summary: string,
  scheduledAt: string,
  createdByUserId: bigint | null = targetUserId,
): bigint {
  const at = '2026-08-15T00:00:00.000Z';
  const payload = JSON.stringify({
    target_user_id: targetUserId.toString(),
    target_display_name: targetUserId === 42n ? 'Alice' : 'Bob',
    summary,
  });
  const created = store.db
    .prepare(
      `INSERT INTO long_tasks(plugin_id, conversation_id, created_by_user_id, payload_json, state,
                            scheduled_at, timer_result_json, delivery_json, created_at, updated_at)
     VALUES ('alarm', ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`,
    )
    .run(
      conversationId,
      createdByUserId,
      payload,
      scheduledAt,
      payload,
      JSON.stringify({
        bypassDailyBudget: true,
        mentionUser: { userId: targetUserId.toString(), displayName: targetUserId === 42n ? 'Alice' : 'Bob' },
      }),
      at,
      at,
    );
  return BigInt(created.lastInsertRowid);
}

export function completeAlarmTask(
  store: SqliteStore,
  taskId: bigint,
  state: 'pending' | 'claimed' | 'handled' | 'suppressed' = 'handled',
  at = '2026-08-16T04:31:00.000Z',
): void {
  store.db
    .prepare("UPDATE long_tasks SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, taskId);
  store.db
    .prepare(
      `INSERT INTO task_receipts(task_id, status, result_json, state, created_at, updated_at, claimed_at, handled_at)
     SELECT id, 'completed', timer_result_json, ?, ?, ?, ?, ? FROM long_tasks WHERE id = ?`,
    )
    .run(
      state,
      at,
      at,
      state === 'claimed' || state === 'handled' ? at : null,
      state === 'handled' ? at : null,
      taskId,
    );
}

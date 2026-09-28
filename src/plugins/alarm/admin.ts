import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Orm } from '../../store/database.ts';
import type { LongTaskService } from '../../store/long-tasks.ts';
import { longTasks } from '../../store/schema.ts';
import { AdminQueryError, type ListQuery, type Page, parseId, parseLimit } from '../../ingress/admin/audit.ts';

const ALARM_STATES = new Set(['pending', 'firing', 'fired', 'cancelled']);

export interface AlarmAdminItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly state: string;
  readonly scheduled_at: string;
  readonly created_at: string;
  readonly created_by_invocation_id: string | null;
  readonly fired_at: string | null;
  readonly invocation_id: string | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly admin_cancelled: boolean;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: string;
  readonly target_display_name: string;
  readonly summary: string;
  readonly chat: {
    readonly telegram_chat_id: string;
    readonly type: string;
    readonly title: string | null;
    readonly message_thread_id: string;
  };
}

interface AlarmRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly state: string;
  readonly scheduled_at: string;
  readonly created_at: string;
  readonly created_by_invocation_id: bigint | null;
  readonly fired_at: string | null;
  readonly invocation_id: bigint | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly admin_cancelled: bigint | null;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: string;
  readonly target_display_name: string;
  readonly summary: string;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
}

interface AlarmCursor {
  readonly segment: 'p' | 't';
  readonly key: string;
  readonly id: bigint;
}

const ALARM_SELECT = `SELECT lt.id, lt.conversation_id,
  CASE
    WHEN lt.state = 'cancelled' OR tr.state = 'suppressed' THEN 'cancelled'
    WHEN tr.state = 'claimed' THEN 'firing'
    WHEN tr.state = 'handled' THEN 'fired'
    ELSE 'pending'
  END AS state,
  lt.scheduled_at, lt.created_at, lt.created_by_invocation_id, tr.claimed_at AS fired_at,
  tr.invocation_id, tr.invocation_outcome, tr.completion_reason, tr.cancelled_at, tr.cancelled_by,
  tr.admin_cancelled, tr.cancel_reason, COALESCE(tr.updated_at, lt.updated_at) AS updated_at,
  json_extract(lt.payload_json, '$.target_user_id') AS target_user_id,
  json_extract(lt.payload_json, '$.target_display_name') AS target_display_name,
  json_extract(lt.payload_json, '$.summary') AS summary,
  ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id
FROM long_tasks lt
LEFT JOIN task_receipts tr ON tr.task_id = lt.id
JOIN conversations c ON c.id = lt.conversation_id
JOIN chats ch ON ch.id = c.chat_id
WHERE lt.plugin_id = 'alarm'`;

export function listAlarms(orm: Orm, query: ListQuery): Page<AlarmAdminItem> {
  const limit = parseLimit(query.limit);
  const state = parseState(query.state);
  const chatId = query.chat ? parseId(query.chat, 'chat') : undefined;
  const targetId = query.target ? parsePositiveId(query.target, 'target') : undefined;
  const cursor = query.cursor ? parseCursor(query.cursor) : null;
  const pending = state === undefined || state === 'pending';
  const terminal = state === undefined || state !== 'pending';
  const segment = pending ? (cursor?.segment ?? 'p') : 't';
  if (segment === 'p') {
    const rows = fetchRows(orm, limit + 1, cursor?.segment === 'p' ? cursor : null, chatId, targetId, 'pending');
    if (rows.length > limit || !terminal) {
      return pageFromRows(rows, limit);
    }
    return pageFromRows([...rows, ...fetchRows(orm, limit - rows.length + 1, null, chatId, targetId, state)], limit);
  }
  return pageFromRows(
    fetchRows(orm, limit + 1, cursor?.segment === 't' ? cursor : null, chatId, targetId, state),
    limit,
  );
}

export function cancelAlarm(
  tasks: LongTaskService,
  orm: Orm,
  id: bigint,
  adminUsername: string,
  now = new Date(),
): { status: string } {
  const row = orm
    .select({ conversation_id: longTasks.conversationId })
    .from(longTasks)
    .where(and(eq(longTasks.id, id), eq(longTasks.pluginId, 'alarm')))
    .get();
  if (row === undefined) {
    throw new AdminQueryError('not_found', 'Alarm does not exist', 404);
  }
  if (
    !tasks
      .scoped('alarm', row.conversation_id)
      .cancel(id, { cancelledBy: adminUsername, adminCancelled: true, reason: 'admin_cancelled' }, now)
  ) {
    throw new AdminQueryError('alarm_not_pending', 'Only pending alarms can be cancelled', 409);
  }
  return { status: 'cancelled' };
}

export function parseAlarmId(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new AdminQueryError('invalid_id', 'id must be a positive integer');
  }
  return BigInt(value);
}

function fetchRows(
  orm: Orm,
  count: number,
  cursor: AlarmCursor | null,
  chatId: bigint | undefined,
  targetId: bigint | undefined,
  state: string | undefined,
): AlarmRow[] {
  const conditions: SQL[] = [];
  if (state === 'pending') {
    conditions.push(sql`state = 'pending'`);
  } else if (state !== undefined) {
    conditions.push(sql`state = ${state}`);
  } else {
    conditions.push(sql`state IN ('firing', 'fired', 'cancelled')`);
  }
  if (cursor) {
    conditions.push(
      cursor.segment === 'p'
        ? sql`(scheduled_at > ${cursor.key} OR (scheduled_at = ${cursor.key} AND id > ${cursor.id}))`
        : sql`(COALESCE(fired_at, cancelled_at, updated_at) < ${cursor.key} OR (COALESCE(fired_at, cancelled_at, updated_at) = ${cursor.key} AND id < ${cursor.id}))`,
    );
  }
  if (chatId !== undefined) {
    conditions.push(sql`telegram_chat_id = ${chatId}`);
  }
  if (targetId !== undefined) {
    conditions.push(sql`target_user_id = ${targetId.toString()}`);
  }
  const order =
    state === 'pending' ? sql`scheduled_at, id` : sql`COALESCE(fired_at, cancelled_at, updated_at) DESC, id DESC`;
  return orm.all<AlarmRow>(
    sql`SELECT * FROM (${sql.raw(ALARM_SELECT)}) ${conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``} ORDER BY ${order} LIMIT ${BigInt(count)}`,
  );
}

function pageFromRows(rows: AlarmRow[], limit: number): Page<AlarmAdminItem> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return { items: visible.map(toItem), next_cursor: rows.length > limit && last ? cursorForRow(last) : null };
}
function cursorForRow(row: AlarmRow): string {
  const segment = row.state === 'pending' ? 'p' : 't';
  return `${segment}|${segment === 'p' ? row.scheduled_at : (row.fired_at ?? row.cancelled_at ?? row.updated_at)}|${row.id}`;
}
function parseState(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!ALARM_STATES.has(value)) {
    throw new AdminQueryError('invalid_state', 'state must be pending, firing, fired, or cancelled');
  }
  return value;
}
function parsePositiveId(value: string, label: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must be a positive integer`);
  }
  return BigInt(value);
}
function parseCursor(value: string): AlarmCursor {
  const parts = value.split('|');
  if (parts.length !== 3) {
    throw new AdminQueryError('invalid_cursor', 'cursor is invalid');
  }
  const [segment, key, id] = parts;
  if (
    (segment !== 'p' && segment !== 't') ||
    key === undefined ||
    key.length === 0 ||
    id === undefined ||
    !/^[1-9][0-9]{0,18}$/.test(id)
  ) {
    throw new AdminQueryError('invalid_cursor', 'cursor is invalid');
  }
  const parsed = BigInt(id);
  if (parsed > 0x7fff_ffff_ffff_ffffn) {
    throw new AdminQueryError('invalid_cursor', 'cursor is invalid');
  }
  return { segment, key, id: parsed };
}
function toItem(row: AlarmRow): AlarmAdminItem {
  return {
    id: row.id.toString(),
    conversation_id: row.conversation_id.toString(),
    state: row.state,
    scheduled_at: row.scheduled_at,
    created_at: row.created_at,
    created_by_invocation_id: row.created_by_invocation_id?.toString() ?? null,
    fired_at: row.fired_at,
    invocation_id: row.invocation_id?.toString() ?? null,
    invocation_outcome: row.invocation_outcome,
    completion_reason: row.completion_reason,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    admin_cancelled: row.admin_cancelled === 1n,
    cancel_reason: row.cancel_reason,
    updated_at: row.updated_at,
    target_user_id: row.target_user_id,
    target_display_name: row.target_display_name,
    summary: row.summary,
    chat: {
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.chat_type,
      title: row.chat_title,
      message_thread_id: row.message_thread_id.toString(),
    },
  };
}

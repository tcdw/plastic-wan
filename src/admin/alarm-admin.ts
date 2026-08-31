import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Orm } from '../database.ts';
import { alarms } from '../schema.ts';
import { AdminQueryError, type ListQuery, type Page, parseId, parseLimit } from './audit.ts';

const ALARM_STATES = new Set(['pending', 'firing', 'fired', 'cancelled']);
const TERMINAL_STATES = ['firing', 'fired', 'cancelled'] as const;

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

interface AlarmListRow {
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
  readonly admin_cancelled: bigint;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: bigint;
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

const ALARM_SELECT = `SELECT a.id, a.conversation_id, a.state, a.scheduled_at, a.created_at,
       a.created_by_invocation_id, a.fired_at, a.invocation_id, a.invocation_outcome,
       a.completion_reason, a.cancelled_at, a.cancelled_by, a.admin_cancelled, a.cancel_reason,
       a.updated_at, a.target_user_id, a.target_display_name, a.summary,
       ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id
FROM alarms a
JOIN conversations c ON c.id = a.conversation_id
JOIN chats ch ON ch.id = c.chat_id`;

export function listAlarms(orm: Orm, query: ListQuery): Page<AlarmAdminItem> {
  const limit = parseLimit(query.limit);
  const state = parseState(query.state);
  const chatId =
    query.chat === undefined || query.chat === null || query.chat.length === 0
      ? undefined
      : parseId(query.chat, 'chat');
  const targetId =
    query.target === undefined || query.target === null || query.target.length === 0
      ? undefined
      : parsePositiveId(query.target, 'target');
  const cursor =
    query.cursor === undefined || query.cursor === null || query.cursor.length === 0 ? null : parseCursor(query.cursor);

  const wantsPending = state === undefined || state === 'pending';
  const wantsTerminal = state === undefined || state !== 'pending';
  const segment: 'p' | 't' = wantsPending ? (cursor?.segment ?? 'p') : 't';

  if (segment === 'p') {
    const pending = fetchPending(orm, limit + 1, cursor?.segment === 'p' ? cursor : null, chatId, targetId);
    if (pending.length > limit) {
      return pageFromRows(pending, limit);
    }
    if (!wantsTerminal) {
      return pageFromRows(pending, limit);
    }
    const remaining = limit - pending.length;
    const terminal = fetchTerminal(orm, remaining + 1, null, chatId, targetId, state);
    return pageFromRows([...pending, ...terminal], limit);
  }

  const terminal = fetchTerminal(orm, limit + 1, cursor?.segment === 't' ? cursor : null, chatId, targetId, state);
  return pageFromRows(terminal, limit);
}

function pageFromRows(rows: AlarmListRow[], limit: number): Page<AlarmAdminItem> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(toItem),
    next_cursor: rows.length > limit && last !== undefined ? cursorForRow(last) : null,
  };
}

function cursorForRow(row: AlarmListRow): string {
  return encodeCursor(row.state === 'pending' ? 'p' : 't', row);
}

export function cancelAlarm(orm: Orm, id: bigint, adminUsername: string, now = new Date()): { status: string } {
  return orm.transaction(
    () => {
      const row = orm.select({ state: alarms.state }).from(alarms).where(eq(alarms.id, id)).get();
      if (row === undefined) {
        throw new AdminQueryError('not_found', 'Alarm does not exist', 404);
      }
      if (row.state !== 'pending') {
        throw new AdminQueryError('alarm_not_pending', 'Only pending alarms can be cancelled', 409);
      }
      const timestamp = now.toISOString();
      orm
        .update(alarms)
        .set({
          state: 'cancelled',
          cancelledAt: timestamp,
          cancelledBy: adminUsername,
          adminCancelled: true,
          cancelReason: 'admin_cancelled',
          updatedAt: timestamp,
        })
        .where(and(eq(alarms.id, id), eq(alarms.state, 'pending')))
        .run();
      return { status: 'cancelled' };
    },
    { behavior: 'immediate' },
  );
}

export function parseAlarmId(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new AdminQueryError('invalid_id', 'id must be a positive integer');
  }
  return BigInt(value);
}

function fetchPending(
  orm: Orm,
  count: number,
  cursor: AlarmCursor | null,
  chatId: bigint | undefined,
  targetId: bigint | undefined,
): AlarmListRow[] {
  const conditions: SQL[] = [sql`a.state = 'pending'`];
  if (cursor !== null) {
    conditions.push(sql`(a.scheduled_at > ${cursor.key} OR (a.scheduled_at = ${cursor.key} AND a.id > ${cursor.id}))`);
  }
  appendFilters(conditions, chatId, targetId);
  return orm.all<AlarmListRow>(
    sql`${sql.raw(ALARM_SELECT)} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY a.scheduled_at, a.id LIMIT ${BigInt(count)}`,
  );
}

function fetchTerminal(
  orm: Orm,
  count: number,
  cursor: AlarmCursor | null,
  chatId: bigint | undefined,
  targetId: bigint | undefined,
  state: string | undefined,
): AlarmListRow[] {
  const conditions: SQL[] = [sql.raw(`a.state IN (${TERMINAL_STATES.map((value) => `'${value}'`).join(', ')})`)];
  if (state !== undefined) {
    conditions.push(sql`a.state = ${state}`);
  }
  if (cursor !== null) {
    conditions.push(
      sql`(COALESCE(a.fired_at, a.cancelled_at, a.updated_at) < ${cursor.key} OR (COALESCE(a.fired_at, a.cancelled_at, a.updated_at) = ${cursor.key} AND a.id < ${cursor.id}))`,
    );
  }
  appendFilters(conditions, chatId, targetId);
  return orm.all<AlarmListRow>(
    sql`${sql.raw(ALARM_SELECT)} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY COALESCE(a.fired_at, a.cancelled_at, a.updated_at) DESC, a.id DESC LIMIT ${BigInt(count)}`,
  );
}

function appendFilters(conditions: SQL[], chatId: bigint | undefined, targetId: bigint | undefined): void {
  if (chatId !== undefined) {
    conditions.push(sql`ch.telegram_chat_id = ${chatId}`);
  }
  if (targetId !== undefined) {
    conditions.push(sql`a.target_user_id = ${targetId}`);
  }
}

function parseState(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) {
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
  const [segment, key, idText] = value.split('|');
  if ((segment !== 'p' && segment !== 't') || key === undefined || idText === undefined) {
    throw new AdminQueryError('invalid_cursor', 'cursor is invalid');
  }
  if (!/^\d{1,19}$/.test(idText)) {
    throw new AdminQueryError('invalid_cursor', 'cursor is invalid');
  }
  return { segment, key, id: BigInt(idText) };
}

function encodeCursor(segment: 'p' | 't', row: AlarmListRow): string {
  const key = segment === 'p' ? row.scheduled_at : (row.fired_at ?? row.cancelled_at ?? row.updated_at);
  return `${segment}|${key}|${row.id.toString()}`;
}

function toItem(row: AlarmListRow): AlarmAdminItem {
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
    target_user_id: row.target_user_id.toString(),
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

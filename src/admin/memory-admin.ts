import type { Database } from 'bun:sqlite';
import {
  DEFAULT_MEMORY_TTL_SECONDS,
  MEMORY_ID_PATTERN,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_TTL_MAX_SECONDS,
  MEMORY_TTL_MIN_SECONDS,
  newMemoryId,
} from '../memory.ts';
import { AdminQueryError, type ListQuery, type Page, parseId, parseLimit } from './audit.ts';

type Bindings = (string | bigint)[];

export const MEMORY_STATES = ['active', 'expired', 'long_ttl'] as const;

export interface MemoryAdminItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly chat: {
    readonly telegram_chat_id: string;
    readonly type: string;
    readonly title: string | null;
    readonly message_thread_id: number;
  };
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly updated_at: string;
  readonly ttl_seconds: number;
  readonly remaining_seconds: number;
  readonly expired: boolean;
  readonly long_ttl: boolean;
}

export interface MemoryChatOption {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username: string | null;
}

export interface CreateMemoryBody {
  readonly chatId: bigint;
  readonly threadId: number;
  readonly content: string;
  readonly ttlSeconds: number;
}

export interface UpdateMemoryBody {
  content?: string;
  ttlSeconds?: number;
}

interface MemoryListRow {
  readonly id: string;
  readonly conversation_id: bigint;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly updated_at: string;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
}

const MEMORY_LIST_SELECT = `SELECT m.id, m.conversation_id, m.content, m.created_at, m.expires_at, m.updated_at,
       ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id
FROM memories m
JOIN conversations c ON c.id = m.conversation_id
JOIN chats ch ON ch.id = c.chat_id`;

export function listMemories(
  db: Database,
  query: ListQuery,
  warningDays: number,
  now = new Date(),
): Page<MemoryAdminItem> {
  const limit = parseLimit(query.limit);
  const conditions: string[] = [];
  const parameters: Bindings = [];
  const nowIso = now.toISOString();
  if (query.cursor !== undefined && query.cursor !== null && query.cursor.length > 0) {
    if (!new RegExp(MEMORY_ID_PATTERN).test(query.cursor)) {
      throw new AdminQueryError('invalid_cursor', 'cursor must be a memory id');
    }
    conditions.push('m.id < ?');
    parameters.push(query.cursor);
  }
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push('ch.telegram_chat_id = ?');
    parameters.push(parseId(query.chat, 'chat'));
  }
  const warningIso = new Date(now.getTime() + warningDays * 86_400_000).toISOString();
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    if (query.state === 'active') {
      conditions.push('m.expires_at > ?');
      parameters.push(nowIso);
    } else if (query.state === 'expired') {
      conditions.push('m.expires_at <= ?');
      parameters.push(nowIso);
    } else if (query.state === 'long_ttl') {
      conditions.push('m.expires_at > ?');
      parameters.push(warningIso);
    } else {
      throw new AdminQueryError('invalid_state', 'state must be active, expired, or long_ttl');
    }
  }
  parameters.push(BigInt(limit + 1));
  const rows = db
    .query<MemoryListRow, Bindings>(`${MEMORY_LIST_SELECT} ${where(conditions)} ORDER BY m.id DESC LIMIT ?`)
    .all(...parameters);
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => toItem(row, nowIso, warningIso)),
    next_cursor: rows.length > limit && last !== undefined ? last.id : null,
  };
}

export function listMemoryChats(db: Database): readonly MemoryChatOption[] {
  return db
    .query<{ telegram_chat_id: bigint; type: string; title: string | null; username: string | null }, []>(
      'SELECT telegram_chat_id, type, title, username FROM chats ORDER BY telegram_chat_id',
    )
    .all()
    .map((row) => ({
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.type,
      title: row.title,
      username: row.username,
    }));
}

export function createMemory(
  db: Database,
  body: CreateMemoryBody,
  warningDays: number,
  now = new Date(),
): MemoryAdminItem {
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + body.ttlSeconds * 1_000).toISOString();
  const id = newMemoryId();
  db.transaction(() => {
    const chat = db.query<{ id: bigint }, [bigint]>('SELECT id FROM chats WHERE telegram_chat_id = ?').get(body.chatId);
    if (chat === null) throw new AdminQueryError('chat_not_found', 'This chat has not been seen by the bot', 404);
    const existing = db
      .query<{ id: bigint }, [bigint, number]>(
        'SELECT id FROM conversations WHERE chat_id = ? AND message_thread_id = ?',
      )
      .get(chat.id, body.threadId);
    const conversationId =
      existing?.id ??
      BigInt(
        db
          .query('INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(chat.id, body.threadId, timestamp, timestamp).lastInsertRowid,
      );
    db.query('DELETE FROM memories WHERE expires_at <= ?').run(timestamp);
    db.query(
      'INSERT INTO memories(id, conversation_id, content, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, conversationId, body.content, timestamp, expiresAt, timestamp);
  }).immediate();
  return getItem(db, id, timestamp, warningDays, now);
}

export function updateMemory(
  db: Database,
  id: string,
  body: UpdateMemoryBody,
  warningDays: number,
  now = new Date(),
): MemoryAdminItem {
  const timestamp = now.toISOString();
  const sets: string[] = ['updated_at = ?'];
  const parameters: Bindings = [timestamp];
  if (body.content !== undefined) {
    sets.push('content = ?');
    parameters.push(body.content);
  }
  if (body.ttlSeconds !== undefined) {
    sets.push('expires_at = ?');
    parameters.push(new Date(now.getTime() + body.ttlSeconds * 1_000).toISOString());
  }
  parameters.push(id);
  const updated = db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...parameters).changes;
  if (updated === 0) throw new AdminQueryError('not_found', 'Memory does not exist', 404);
  return getItem(db, id, timestamp, warningDays, now);
}

export function deleteMemory(db: Database, id: string): void {
  const result = db.query('DELETE FROM memories WHERE id = ?').run(id);
  if (result.changes === 0) throw new AdminQueryError('not_found', 'Memory does not exist', 404);
}

export function parseMemoryId(value: string): string {
  if (!new RegExp(MEMORY_ID_PATTERN).test(value)) throw new AdminQueryError('invalid_id', 'id must be a memory id');
  return value;
}

export function parseCreateMemoryBody(value: unknown): CreateMemoryBody {
  const record = asRecord(value);
  const chatIdValue = record.chat_id;
  const content = record.content;
  if (typeof chatIdValue !== 'string' || !/^-?\d{1,19}$/.test(chatIdValue)) {
    throw new AdminQueryError('invalid_chat_id', 'chat_id must be an integer');
  }
  if (typeof content !== 'string' || content.length < 1 || content.length > MEMORY_MAX_CONTENT_LENGTH) {
    throw new AdminQueryError('invalid_content', `content must be 1-${MEMORY_MAX_CONTENT_LENGTH} characters`);
  }
  return {
    chatId: BigInt(chatIdValue),
    threadId: parseThreadId(record.message_thread_id),
    content,
    ttlSeconds: parseTtlSeconds(record.ttl_seconds) ?? DEFAULT_MEMORY_TTL_SECONDS,
  };
}

export function parseUpdateMemoryBody(value: unknown): UpdateMemoryBody {
  const record = asRecord(value);
  const body: UpdateMemoryBody = {};
  const content = record.content;
  if (content !== undefined) {
    if (typeof content !== 'string' || content.length < 1 || content.length > MEMORY_MAX_CONTENT_LENGTH) {
      throw new AdminQueryError('invalid_content', `content must be 1-${MEMORY_MAX_CONTENT_LENGTH} characters`);
    }
    body.content = content;
  }
  const ttlSeconds = parseTtlSeconds(record.ttl_seconds);
  if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;
  if (body.content === undefined && body.ttlSeconds === undefined) {
    throw new AdminQueryError('invalid_body', 'At least one of content or ttl_seconds is required');
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null)
    throw new AdminQueryError('invalid_body', 'Request body must be a JSON object');
  return value as Record<string, unknown>;
}

function parseThreadId(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new AdminQueryError('invalid_thread_id', 'message_thread_id must be an integer between 0 and 1000000');
  }
  return value;
}

function parseTtlSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MEMORY_TTL_MIN_SECONDS ||
    value > MEMORY_TTL_MAX_SECONDS
  ) {
    throw new AdminQueryError(
      'invalid_ttl_seconds',
      `ttl_seconds must be between ${MEMORY_TTL_MIN_SECONDS} and ${MEMORY_TTL_MAX_SECONDS}`,
    );
  }
  return value;
}

function getItem(db: Database, id: string, nowIso: string, warningDays: number, now: Date): MemoryAdminItem {
  const row = db.query<MemoryListRow, [string]>(`${MEMORY_LIST_SELECT} WHERE m.id = ?`).get(id);
  if (row === null) throw new Error('Memory row vanished after write');
  const warningIso = new Date(now.getTime() + warningDays * 86_400_000).toISOString();
  return toItem(row, nowIso, warningIso);
}

function toItem(row: MemoryListRow, nowIso: string, warningIso: string): MemoryAdminItem {
  const remainingSeconds = Math.round((Date.parse(row.expires_at) - Date.parse(nowIso)) / 1_000);
  return {
    id: row.id,
    conversation_id: row.conversation_id.toString(),
    chat: {
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.chat_type,
      title: row.chat_title,
      message_thread_id: Number(row.message_thread_id),
    },
    content: row.content,
    created_at: row.created_at,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    ttl_seconds: Math.max(0, Math.round((Date.parse(row.expires_at) - Date.parse(row.created_at)) / 1_000)),
    remaining_seconds: remainingSeconds,
    expired: remainingSeconds <= 0,
    long_ttl: row.expires_at > warningIso,
  };
}

function where(conditions: readonly string[]): string {
  return conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
}

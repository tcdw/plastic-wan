import { and, desc, eq, gt, lt, lte, type SQL } from 'drizzle-orm';
import { asRunResult, type Orm } from '../database.ts';
import {
  DEFAULT_MEMORY_TTL_SECONDS,
  MEMORY_ID_PATTERN,
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_TTL_MAX_SECONDS,
  MEMORY_TTL_MIN_SECONDS,
  newMemoryId,
} from '../memory.ts';
import { chats, conversations, memories } from '../schema.ts';
import { AdminQueryError, type ListQuery, type Page, page, parseId, parseLimit } from './audit.ts';

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

const MEMORY_LIST_FIELDS = {
  id: memories.id,
  conversation_id: memories.conversationId,
  content: memories.content,
  created_at: memories.createdAt,
  expires_at: memories.expiresAt,
  updated_at: memories.updatedAt,
  telegram_chat_id: chats.telegramChatId,
  chat_type: chats.type,
  chat_title: chats.title,
  message_thread_id: conversations.messageThreadId,
};

export function listMemories(orm: Orm, query: ListQuery, warningDays: number, now = new Date()): Page<MemoryAdminItem> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  const nowIso = now.toISOString();
  if (query.cursor !== undefined && query.cursor !== null && query.cursor.length > 0) {
    if (!new RegExp(MEMORY_ID_PATTERN).test(query.cursor)) {
      throw new AdminQueryError('invalid_cursor', 'cursor must be a memory id');
    }
    conditions.push(lt(memories.id, query.cursor));
  }
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(eq(chats.telegramChatId, parseId(query.chat, 'chat')));
  }
  const warningIso = new Date(now.getTime() + warningDays * 86_400_000).toISOString();
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    if (query.state === 'active') {
      conditions.push(gt(memories.expiresAt, nowIso));
    } else if (query.state === 'expired') {
      conditions.push(lte(memories.expiresAt, nowIso));
    } else if (query.state === 'long_ttl') {
      conditions.push(gt(memories.expiresAt, warningIso));
    } else {
      throw new AdminQueryError('invalid_state', 'state must be active, expired, or long_ttl');
    }
  }
  const rows = orm
    .select(MEMORY_LIST_FIELDS)
    .from(memories)
    .innerJoin(conversations, eq(conversations.id, memories.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(...conditions))
    .orderBy(desc(memories.id))
    .limit(limit + 1)
    .all();
  return page(rows, limit, (row) => toItem(row, nowIso, warningIso));
}

export function listMemoryChats(orm: Orm): readonly MemoryChatOption[] {
  return orm
    .select({
      telegram_chat_id: chats.telegramChatId,
      type: chats.type,
      title: chats.title,
      username: chats.username,
    })
    .from(chats)
    .orderBy(chats.telegramChatId)
    .all()
    .map((row) => ({
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.type,
      title: row.title,
      username: row.username,
    }));
}

export function createMemory(orm: Orm, body: CreateMemoryBody, warningDays: number, now = new Date()): MemoryAdminItem {
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + body.ttlSeconds * 1_000).toISOString();
  const id = newMemoryId();
  orm.transaction(
    () => {
      const chat = orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, body.chatId)).get();
      if (chat === undefined) {
        throw new AdminQueryError('chat_not_found', 'This chat has not been seen by the bot', 404);
      }
      const existing = orm
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.chatId, chat.id), eq(conversations.messageThreadId, BigInt(body.threadId))))
        .get();
      let conversationId: bigint;
      if (existing !== undefined) {
        conversationId = existing.id;
      } else {
        const created = orm
          .insert(conversations)
          .values({
            chatId: chat.id,
            messageThreadId: BigInt(body.threadId),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning({ id: conversations.id })
          .get();
        if (created === undefined) {
          throw new Error('conversations insert returned no row');
        }
        conversationId = created.id;
      }
      orm.delete(memories).where(lte(memories.expiresAt, timestamp)).run();
      orm
        .insert(memories)
        .values({
          id,
          conversationId,
          content: body.content,
          createdAt: timestamp,
          expiresAt,
          updatedAt: timestamp,
        })
        .run();
    },
    { behavior: 'immediate' },
  );
  return getItem(orm, id, timestamp, warningDays, now);
}

export function updateMemory(
  orm: Orm,
  id: string,
  body: UpdateMemoryBody,
  warningDays: number,
  now = new Date(),
): MemoryAdminItem {
  const timestamp = now.toISOString();
  const set = {
    updatedAt: timestamp,
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(body.ttlSeconds !== undefined
      ? { expiresAt: new Date(now.getTime() + body.ttlSeconds * 1_000).toISOString() }
      : {}),
  };
  const updated = asRunResult(orm.update(memories).set(set).where(eq(memories.id, id)).run());
  if (updated.changes === 0) {
    throw new AdminQueryError('not_found', 'Memory does not exist', 404);
  }
  return getItem(orm, id, timestamp, warningDays, now);
}

export function deleteMemory(orm: Orm, id: string): void {
  const result = asRunResult(orm.delete(memories).where(eq(memories.id, id)).run());
  if (result.changes === 0) {
    throw new AdminQueryError('not_found', 'Memory does not exist', 404);
  }
}

export function parseMemoryId(value: string): string {
  if (!new RegExp(MEMORY_ID_PATTERN).test(value)) {
    throw new AdminQueryError('invalid_id', 'id must be a memory id');
  }
  return value;
}

export function parseCreateMemoryBody(value: unknown): CreateMemoryBody {
  const record = asRecord(value);
  const chatIdValue = record.chat_id;
  const content = record.content;
  if (typeof chatIdValue !== 'string') {
    throw new AdminQueryError('invalid_chat_id', 'chat_id must be an integer');
  }
  if (typeof content !== 'string' || content.length < 1 || content.length > MEMORY_MAX_CONTENT_LENGTH) {
    throw new AdminQueryError('invalid_content', `content must be 1-${MEMORY_MAX_CONTENT_LENGTH} characters`);
  }
  return {
    chatId: parseId(chatIdValue, 'chat_id'),
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
  if (ttlSeconds !== undefined) {
    body.ttlSeconds = ttlSeconds;
  }
  if (body.content === undefined && body.ttlSeconds === undefined) {
    throw new AdminQueryError('invalid_body', 'At least one of content or ttl_seconds is required');
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new AdminQueryError('invalid_body', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function parseThreadId(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new AdminQueryError('invalid_thread_id', 'message_thread_id must be an integer between 0 and 1000000');
  }
  return value;
}

function parseTtlSeconds(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
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

function getItem(orm: Orm, id: string, nowIso: string, warningDays: number, now: Date): MemoryAdminItem {
  const row = orm
    .select(MEMORY_LIST_FIELDS)
    .from(memories)
    .innerJoin(conversations, eq(conversations.id, memories.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(eq(memories.id, id))
    .get();
  if (row === undefined) {
    throw new Error('Memory row vanished after write');
  }
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

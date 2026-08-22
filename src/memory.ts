import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type, { type Static } from 'typebox';
import type { InvocationContext } from './context-builder.ts';

export const DEFAULT_MEMORY_TTL_SECONDS = 86_400;
export const MEMORY_MAX_CONTENT_LENGTH = 150;
export const MEMORY_TTL_MIN_SECONDS = 60;
export const MEMORY_TTL_MAX_SECONDS = 157_680_000;
export const DEFAULT_MEMORY_TTL_WARNING_DAYS = 30;
export const MEMORY_ID_PATTERN = '^mem_[a-f0-9]{32}$';

export const AddMemoryInputSchema = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: MEMORY_MAX_CONTENT_LENGTH }),
    ttl_seconds: Type.Optional(Type.Integer({ minimum: MEMORY_TTL_MIN_SECONDS, maximum: MEMORY_TTL_MAX_SECONDS })),
  },
  { additionalProperties: false },
);
export type AddMemoryInput = Static<typeof AddMemoryInputSchema>;

export const DeleteMemoryInputSchema = Type.Object(
  { id: Type.String({ pattern: MEMORY_ID_PATTERN }) },
  { additionalProperties: false },
);
export type DeleteMemoryInput = Static<typeof DeleteMemoryInputSchema>;

interface MemoryRow {
  readonly id: string;
  readonly conversation_id: bigint;
  readonly content: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly updated_at: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly conversationId: bigint;
  readonly content: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface MemoryChanges {
  readonly content?: string;
  readonly expiresAt?: string;
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function newMemoryId(): string {
  return `mem_${randomUUID().replaceAll('-', '')}`;
}

/**
 * Conversation-scoped memory persistence. Rows are owned by a conversation, expire
 * by TTL, and expired rows are purged opportunistically on every write so the table
 * never accumulates rows that can no longer be injected.
 */
export class MemoryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** All non-expired memories of one conversation, strictly in creation order. */
  listActive(conversationId: bigint, now = new Date()): MemoryRecord[] {
    return this.#db
      .query<MemoryRow, [bigint, string]>(
        `SELECT id, conversation_id, content, created_at, expires_at, updated_at
         FROM memories
         WHERE conversation_id = ? AND expires_at > ?
         ORDER BY created_at, id`,
      )
      .all(conversationId, now.toISOString())
      .map(toRecord);
  }

  get(id: string): MemoryRecord | null {
    const row = this.#db
      .query<MemoryRow, [string]>(
        'SELECT id, conversation_id, content, created_at, expires_at, updated_at FROM memories WHERE id = ?',
      )
      .get(id);
    return row === null ? null : toRecord(row);
  }

  add(conversationId: bigint, content: string, ttlSeconds: number, now = new Date()): MemoryRecord {
    const timestamp = now.toISOString();
    const record: MemoryRecord = {
      id: newMemoryId(),
      conversationId,
      content,
      createdAt: timestamp,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      updatedAt: timestamp,
    };
    this.#db
      .transaction(() => {
        this.#db.query('DELETE FROM memories WHERE expires_at <= ?').run(timestamp);
        this.#db
          .query(
            'INSERT INTO memories(id, conversation_id, content, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(record.id, conversationId, content, timestamp, record.expiresAt, timestamp);
      })
      .immediate();
    return record;
  }

  /** Deletes by id within one conversation. Idempotent: false when nothing was deleted. */
  remove(id: string, conversationId: bigint, now = new Date()): boolean {
    return this.#db
      .transaction(() => {
        this.#db.query('DELETE FROM memories WHERE expires_at <= ?').run(now.toISOString());
        const result = this.#db
          .query('DELETE FROM memories WHERE id = ? AND conversation_id = ?')
          .run(id, conversationId);
        return result.changes === 1;
      })
      .immediate();
  }

  update(id: string, changes: MemoryChanges, now = new Date()): MemoryRecord | null {
    const timestamp = now.toISOString();
    const sets: string[] = ['updated_at = ?'];
    const parameters: (string | bigint)[] = [timestamp];
    if (changes.content !== undefined) {
      sets.push('content = ?');
      parameters.push(changes.content);
    }
    if (changes.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      parameters.push(changes.expiresAt);
    }
    parameters.push(id);
    const result = this.#db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...parameters);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  purgeExpired(now = new Date()): void {
    this.#db.query('DELETE FROM memories WHERE expires_at <= ?').run(now.toISOString());
  }

  recordToolCall(
    invocationId: bigint,
    toolCallId: string,
    toolName: 'add_memory' | 'delete_memory',
    argumentsJson: string,
    now: Date,
  ): bigint {
    const created = this.#db
      .query(
        "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at) VALUES (?, ?, ?, ?, 'pending', 1, ?)",
      )
      .run(invocationId, toolCallId, toolName, argumentsJson, now.toISOString());
    return BigInt(created.lastInsertRowid);
  }

  finishToolCall(
    toolId: bigint,
    state: 'success' | 'error',
    resultText: string | null,
    errorCode: string | null,
    now: Date,
  ): void {
    this.#db
      .query('UPDATE tool_calls SET state = ?, result_text = ?, error_code = ?, finished_at = ? WHERE id = ?')
      .run(state, resultText, errorCode, now.toISOString(), toolId);
  }
}

export interface MemoryToolEnvironment {
  readonly store: MemoryStore;
  readonly context: InvocationContext;
}

export function createMemoryTools(store: MemoryStore, context: InvocationContext): readonly AgentTool[] {
  return [createAddMemoryTool(store, context), createDeleteMemoryTool(store, context)];
}

function createAddMemoryTool(
  store: MemoryStore,
  context: InvocationContext,
): AgentTool<typeof AddMemoryInputSchema, { id: string; expires_at: string }> {
  return {
    name: 'add_memory',
    label: 'Add memory',
    description:
      'Save a short-term note for this conversation that persists across sessions. Keep notes under 100 characters; the hard limit is 150. The note expires after ttl_seconds (default 1 day). Use a long TTL only to nominate stable knowledge for human review.',
    parameters: AddMemoryInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, _signal) => {
      const now = new Date();
      const toolId = store.recordToolCall(context.invocationId, toolCallId, 'add_memory', JSON.stringify(input), now);
      try {
        const record = store.add(
          context.conversationId,
          input.content,
          input.ttl_seconds ?? DEFAULT_MEMORY_TTL_SECONDS,
          now,
        );
        store.finishToolCall(toolId, 'success', `memory_id=${record.id} expires_at=${record.expiresAt}`, null, now);
        return {
          content: [{ type: 'text', text: `Saved memory ${record.id}; it expires at ${record.expiresAt}` }],
          details: { id: record.id, expires_at: record.expiresAt },
        };
      } catch (error) {
        store.finishToolCall(toolId, 'error', null, 'memory_error', now);
        throw error;
      }
    },
  };
}

function createDeleteMemoryTool(
  store: MemoryStore,
  context: InvocationContext,
): AgentTool<typeof DeleteMemoryInputSchema, { id: string }> {
  return {
    name: 'delete_memory',
    label: 'Delete memory',
    description:
      "Delete one of this conversation's memories by its id from the memory list. Deleting a note that is already gone or expired is a harmless no-op.",
    parameters: DeleteMemoryInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, _signal) => {
      const now = new Date();
      const toolId = store.recordToolCall(
        context.invocationId,
        toolCallId,
        'delete_memory',
        JSON.stringify(input),
        now,
      );
      try {
        const deleted = store.remove(input.id, context.conversationId, now);
        const result = deleted ? `memory_id=${input.id} deleted` : `memory_id=${input.id} absent`;
        store.finishToolCall(toolId, 'success', result, null, now);
        return {
          content: [
            { type: 'text', text: deleted ? `Memory ${input.id} deleted` : `Memory ${input.id} was already gone` },
          ],
          details: { id: input.id },
        };
      } catch (error) {
        store.finishToolCall(toolId, 'error', null, 'memory_error', now);
        throw error;
      }
    },
  };
}

import { and, desc, eq, gt, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SqliteStore } from '../store/database.ts';
import { conversationContexts, contextMessages, contextRefs, invocations } from '../store/schema.ts';
import { decodeContextMessage, type ContextMessageRole } from './context-codec.ts';

/**
 * Canonical Conversation Context storage.
 *
 * One row in `conversation_contexts` per Conversation, and the retained
 * transcript lives in `context_messages[head_seq, next_seq)`. This class is the
 * only writer of that history: the in-memory Pi agent is a disposable cache
 * seeded from here, never the other way around.
 */

/**
 * Live handle of one Conversation Context. It is mutated by this store as the
 * history advances, so every consumer (tools, GC, attach path) observes the
 * same `head_seq` / `next_seq` without re-reading the row.
 */
export interface ContextHeader {
  readonly id: bigint;
  readonly conversationId: bigint;
  headSeq: bigint;
  nextSeq: bigint;
  sendCountTotal: bigint;
  systemPromptHash: string;
  lastGcAt: string | null;
}

export interface ContextMessageInput {
  readonly invocationId: bigint | null;
  readonly isCheckpoint: boolean;
  readonly estTokens: number;
  readonly json: string;
  readonly role: ContextMessageRole;
  /** Set when this row is the tool result of a successful `send`. */
  readonly countedSend?: boolean;
}

/** Light row projection used by GC and `/status`; never carries payloads. */
export interface ContextWindowRow {
  readonly seq: bigint;
  readonly role: string;
  readonly estTokens: bigint;
  readonly isCheckpoint: boolean;
  readonly sendSeq: bigint | null;
}

export interface RetainedContextMessage {
  readonly seq: bigint;
  readonly message: AgentMessage;
}

export interface ContextStats {
  readonly headSeq: bigint;
  readonly nextSeq: bigint;
  readonly messageCount: number;
  readonly retainedSends: number;
  readonly retainedTokens: number;
  readonly lastGcAt: string | null;
}

export class ConversationContextStore {
  readonly #store: SqliteStore;

  constructor(store: SqliteStore) {
    this.#store = store;
  }

  /**
   * Returns the Conversation Context, creating it on first use. A different
   * `systemPromptHash` means the stable system prompt changed, which the design
   * treats as "rebuild the context": continuity across two different prompts is
   * not something the model can be trusted to reconcile.
   */
  open(
    conversationId: bigint,
    systemPromptHash: string,
    now = new Date(),
  ): { header: ContextHeader; rebuilt: boolean } {
    const timestamp = now.toISOString();
    const existing = this.#selectHeader(conversationId);
    if (existing === undefined) {
      const created = this.#store.orm
        .insert(conversationContexts)
        .values({
          conversationId,
          systemPromptHash,
          lastActiveAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: conversationContexts.id })
        .get();
      if (created === undefined) {
        throw new Error('conversation_contexts insert returned no row');
      }
      return { header: this.#requireHeader(conversationId), rebuilt: false };
    }
    if (existing.systemPromptHash === systemPromptHash) {
      return { header: existing, rebuilt: false };
    }
    this.#store.transaction(() => {
      this.#store.orm.delete(contextMessages).where(eq(contextMessages.contextId, existing.id)).run();
      this.#store.orm.delete(contextRefs).where(eq(contextRefs.contextId, existing.id)).run();
      this.#store.orm
        .update(conversationContexts)
        .set({
          headSeq: 1n,
          nextSeq: 1n,
          sendCountTotal: 0n,
          systemPromptHash,
          activeInvocationId: null,
          lastGcAt: null,
          updatedAt: timestamp,
        })
        .where(eq(conversationContexts.id, existing.id))
        .run();
    });
    return { header: this.#requireHeader(conversationId), rebuilt: true };
  }

  header(conversationId: bigint): ContextHeader | undefined {
    return this.#selectHeader(conversationId);
  }

  /** Appends one persisted message and returns its sequence number. */
  append(header: ContextHeader, input: ContextMessageInput, now = new Date()): bigint {
    const seq = header.nextSeq;
    const timestamp = now.toISOString();
    const countedSend = input.countedSend === true;
    this.#store.transaction(() => {
      this.#store.orm
        .insert(contextMessages)
        .values({
          contextId: header.id,
          seq,
          role: input.role,
          payloadJson: input.json,
          invocationId: input.invocationId,
          isCheckpoint: input.isCheckpoint,
          sendSeq: countedSend ? header.sendCountTotal + 1n : null,
          estTokens: BigInt(input.estTokens),
          createdAt: timestamp,
        })
        .run();
      this.#store.orm
        .update(conversationContexts)
        .set({
          nextSeq: seq + 1n,
          ...(countedSend ? { sendCountTotal: header.sendCountTotal + 1n } : {}),
          lastActiveAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
    header.nextSeq = seq + 1n;
    if (countedSend) {
      header.sendCountTotal += 1n;
    }
    return seq;
  }

  /**
   * Retained rows in transcript order, decoded for seeding a Pi agent.
   *
   * Eviction is authoritative on its own, not only through `head_seq`: a caller
   * holding a header from before a concurrent `/cut_topic` has a stale, lower
   * `headSeq`, and a range read would resurrect exactly the history the cut
   * dropped. Filtering on `evicted_at` makes a dropped row stay dropped whatever
   * `head_seq` any live handle believes in.
   */
  retained(header: ContextHeader): RetainedContextMessage[] {
    return this.#store.orm
      .select({ seq: contextMessages.seq, payloadJson: contextMessages.payloadJson })
      .from(contextMessages)
      .where(this.#retainedRange(header))
      .orderBy(contextMessages.seq)
      .all()
      .map((row) => ({ seq: row.seq, message: decodeContextMessage(row.payloadJson) }));
  }

  window(header: ContextHeader): ContextWindowRow[] {
    return this.#store.orm
      .select({
        seq: contextMessages.seq,
        role: contextMessages.role,
        estTokens: contextMessages.estTokens,
        isCheckpoint: contextMessages.isCheckpoint,
        sendSeq: contextMessages.sendSeq,
      })
      .from(contextMessages)
      .where(this.#retainedRange(header))
      .orderBy(contextMessages.seq)
      .all();
  }

  #retainedRange(header: ContextHeader): SQL | undefined {
    return and(
      eq(contextMessages.contextId, header.id),
      gte(contextMessages.seq, header.headSeq),
      isNull(contextMessages.evictedAt),
    );
  }

  /**
   * Advances `head_seq`, soft-marking every dropped row and revoking the
   * references that were carried by them.
   */
  advanceHead(header: ContextHeader, targetSeq: bigint, now = new Date()): void {
    if (targetSeq <= header.headSeq || targetSeq >= header.nextSeq) {
      throw new Error(`Refusing to advance head_seq to ${targetSeq}`);
    }
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#store.orm
        .update(contextMessages)
        .set({ evictedAt: timestamp })
        .where(and(eq(contextMessages.contextId, header.id), lt(contextMessages.seq, targetSeq)))
        .run();
      this.#store.orm
        .delete(contextRefs)
        .where(and(eq(contextRefs.contextId, header.id), lt(contextRefs.sourceSeq, targetSeq)))
        .run();
      this.#store.orm
        .update(conversationContexts)
        .set({ headSeq: targetSeq, lastGcAt: timestamp, updatedAt: timestamp })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
    header.headSeq = targetSeq;
    header.lastGcAt = timestamp;
  }

  /** `/cut_topic`: drop the whole retained history of one Conversation. */
  clear(header: ContextHeader, now = new Date()): void {
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#store.orm
        .update(contextMessages)
        .set({ evictedAt: timestamp })
        .where(and(eq(contextMessages.contextId, header.id), gte(contextMessages.seq, header.headSeq)))
        .run();
      this.#store.orm.delete(contextRefs).where(eq(contextRefs.contextId, header.id)).run();
      this.#store.orm
        .update(conversationContexts)
        .set({ headSeq: header.nextSeq, updatedAt: timestamp })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
    header.headSeq = header.nextSeq;
  }

  /** Records that the invocation owning this context started or ended. */
  touch(header: ContextHeader, activeInvocationId: bigint | null, now = new Date()): void {
    this.#store.orm
      .update(conversationContexts)
      .set({ activeInvocationId, lastActiveAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(eq(conversationContexts.id, header.id))
      .run();
  }

  clearActiveInvocation(invocationId: bigint, now = new Date()): void {
    this.#store.orm
      .update(conversationContexts)
      .set({ activeInvocationId: null, updatedAt: now.toISOString() })
      .where(eq(conversationContexts.activeInvocationId, invocationId))
      .run();
  }

  stats(header: ContextHeader): ContextStats {
    const row = this.#store.db
      .query<{ count: bigint; sends: bigint; tokens: bigint | null }, [bigint, bigint]>(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN send_seq IS NOT NULL THEN 1 ELSE 0 END), 0) AS sends,
                SUM(est_tokens) AS tokens
         FROM context_messages WHERE context_id = ? AND seq >= ? AND evicted_at IS NULL`,
      )
      .get(header.id, header.headSeq);
    return {
      headSeq: header.headSeq,
      nextSeq: header.nextSeq,
      messageCount: Number(row?.count ?? 0n),
      retainedSends: Number(row?.sends ?? 0n),
      retainedTokens: Number(row?.tokens ?? 0n),
      lastGcAt: header.lastGcAt,
    };
  }

  /** Retention cleanup: drop soft-evicted rows and expired references. */
  purge(now = new Date(), evictedBefore?: string): void {
    const timestamp = now.toISOString();
    this.#store.orm.delete(contextRefs).where(lt(contextRefs.expiresAt, timestamp)).run();
    if (evictedBefore !== undefined) {
      this.#store.orm
        .delete(contextMessages)
        .where(and(lt(contextMessages.evictedAt, evictedBefore)))
        .run();
    }
  }

  #selectHeader(conversationId: bigint): ContextHeader | undefined {
    const row = this.#store.orm
      .select({
        id: conversationContexts.id,
        conversationId: conversationContexts.conversationId,
        headSeq: conversationContexts.headSeq,
        nextSeq: conversationContexts.nextSeq,
        sendCountTotal: conversationContexts.sendCountTotal,
        systemPromptHash: conversationContexts.systemPromptHash,
        lastGcAt: conversationContexts.lastGcAt,
      })
      .from(conversationContexts)
      .where(eq(conversationContexts.conversationId, conversationId))
      .get();
    return row;
  }

  #requireHeader(conversationId: bigint): ContextHeader {
    const header = this.#selectHeader(conversationId);
    if (header === undefined) {
      throw new Error(`Conversation ${conversationId} has no context row`);
    }
    return header;
  }
}

export interface ConversationContextSummary {
  readonly conversationId: bigint;
  readonly telegramChatId: bigint;
  readonly messageThreadId: bigint;
  readonly headSeq: bigint;
  readonly nextSeq: bigint;
  readonly sendCountTotal: bigint;
  readonly messageCount: bigint;
  readonly lastActiveAt: string;
  readonly lastGcAt: string | null;
  readonly activeInvocationId: bigint | null;
}

interface ConversationContextSummaryRow {
  readonly conversation_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly message_thread_id: bigint;
  readonly head_seq: bigint;
  readonly next_seq: bigint;
  readonly send_count_total: bigint;
  readonly message_count: bigint;
  readonly last_active_at: string;
  readonly last_gc_at: string | null;
  readonly active_invocation_id: bigint | null;
}

/** Read-only projection used by `/status` and the Admin Panel. */
export function listConversationContexts(
  store: SqliteStore,
  filter: { readonly conversationId?: bigint; readonly telegramChatId?: bigint; readonly limit?: number } = {},
): ConversationContextSummary[] {
  const conditions: SQL[] = [];
  if (filter.conversationId !== undefined) {
    conditions.push(sql`cc.conversation_id = ${filter.conversationId}`);
  }
  if (filter.telegramChatId !== undefined) {
    conditions.push(sql`c.telegram_chat_id = ${filter.telegramChatId}`);
  }
  const where = conditions.length === 0 ? sql`1 = 1` : sql.join(conditions, sql` AND `);
  return store.orm
    .all<ConversationContextSummaryRow>(
      sql`SELECT cc.conversation_id, c.telegram_chat_id, v.message_thread_id, cc.head_seq, cc.next_seq,
                 cc.send_count_total, cc.last_active_at, cc.last_gc_at, cc.active_invocation_id,
                 (SELECT COUNT(*) FROM context_messages cm
                   WHERE cm.context_id = cc.id AND cm.seq >= cc.head_seq) AS message_count
          FROM conversation_contexts cc
          JOIN conversations v ON v.id = cc.conversation_id
          JOIN chats c ON c.id = v.chat_id
          WHERE ${where}
          ORDER BY cc.last_active_at DESC, cc.id DESC
          LIMIT ${BigInt(filter.limit ?? 50)}`,
    )
    .map((row) => ({
      conversationId: row.conversation_id,
      telegramChatId: row.telegram_chat_id,
      messageThreadId: row.message_thread_id,
      headSeq: row.head_seq,
      nextSeq: row.next_seq,
      sendCountTotal: row.send_count_total,
      messageCount: row.message_count,
      lastActiveAt: row.last_active_at,
      lastGcAt: row.last_gc_at,
      activeInvocationId: row.active_invocation_id,
    }));
}

/**
 * The invocation currently ownering a Conversation Context, if any. The attach
 * path uses this to find the run a due bucket should be injected into.
 */
export function runningInvocationForConversation(store: SqliteStore, conversationId: bigint): bigint | undefined {
  const row = store.orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(and(eq(invocations.conversationId, conversationId), eq(invocations.state, 'running')))
    .orderBy(desc(invocations.id))
    .limit(1)
    .get();
  return row?.id;
}

/** Helper for callers that need the newest checkpoint above the current head. */
export function retainedCheckpoints(store: SqliteStore, contextId: bigint, headSeq: bigint): bigint[] {
  return store.orm
    .select({ seq: contextMessages.seq })
    .from(contextMessages)
    .where(
      and(
        eq(contextMessages.contextId, contextId),
        eq(contextMessages.isCheckpoint, true),
        gt(contextMessages.seq, headSeq),
      ),
    )
    .orderBy(contextMessages.seq)
    .all()
    .map((row) => row.seq);
}

import { and, eq, gt, sql } from 'drizzle-orm';
import type { SqliteStore } from '../store/database.ts';
import { contextRefs } from '../store/schema.ts';
import type { CapabilityRefResolver } from '../platform/invocation-context.ts';
import type { ContextHeader } from './context-store.ts';

/**
 * Capability references for one Conversation Context.
 *
 * References used to be minted per invocation, which made every quoted `img_`
 * / `stk_` ref in retained history dead on the next run. They now live for the
 * context (bounded by a TTL), are reused while they last, and stop being
 * authorized as soon as the message that carried them is evicted.
 *
 * The hard boundary is unchanged in spirit and stronger in practice: a
 * reference is only ever resolved inside its own Conversation Context, so a
 * ref quoted from another chat/topic never resolves.
 */

export type ContextRefKind = 'media' | 'sticker' | 'reply';

export interface ResolvedContextRef {
  readonly ref: string;
  readonly kind: ContextRefKind;
  readonly mediaId: bigint | null;
  readonly stickerFileId: string | null;
  readonly targetConversationId: bigint | null;
  readonly targetThreadId: bigint | null;
}

export interface ContextRefOptions {
  readonly ttlHours: number;
}

export class ContextRefStore {
  readonly #store: SqliteStore;
  readonly #ttlHours: number;

  constructor(store: SqliteStore, options: ContextRefOptions) {
    this.#store = store;
    this.#ttlHours = options.ttlHours;
  }

  /**
   * Media reference for one media row, reused while an unexpired one exists so
   * retained history keeps the same token instead of churning the prefix cache.
   */
  mediaRef(header: ContextHeader, mediaId: bigint, sourceSeq: bigint, now = new Date()): string {
    const existing = this.#store.orm
      .select({ ref: contextRefs.ref })
      .from(contextRefs)
      .where(
        and(
          eq(contextRefs.contextId, header.id),
          eq(contextRefs.kind, 'media'),
          eq(contextRefs.mediaId, mediaId),
          gt(contextRefs.expiresAt, now.toISOString()),
        ),
      )
      .orderBy(contextRefs.ref)
      .limit(1)
      .get();
    if (existing !== undefined) {
      return existing.ref;
    }
    const ref = `img_${crypto.randomUUID().replaceAll('-', '')}`;
    this.#insert(
      header,
      {
        ref,
        kind: 'media',
        sourceSeq,
        mediaId,
        stickerFileId: null,
        targetConversationId: null,
        targetThreadId: null,
      },
      now,
    );
    return ref;
  }

  /** Sticker reference produced by `search_stickers`, authorized for the TTL. */
  stickerRef(header: ContextHeader, stickerFileId: string, sourceSeq: bigint, now = new Date()): string {
    const ref = `stk_${crypto.randomUUID().replaceAll('-', '')}`;
    this.#insert(
      header,
      {
        ref,
        kind: 'sticker',
        sourceSeq,
        mediaId: null,
        stickerFileId,
        targetConversationId: null,
        targetThreadId: null,
      },
      now,
    );
    return ref;
  }

  /**
   * Reply target for one visible Telegram message. The ref token is derived from
   * the Telegram message ID, so `send` can validate a `reply_to_message_id`
   * without a client-side lookup table.
   */
  replyRef(
    header: ContextHeader,
    telegramMessageId: bigint,
    target: { readonly conversationId: bigint; readonly threadId: bigint },
    sourceSeq: bigint,
    now = new Date(),
  ): string {
    const ref = replyRefFor(telegramMessageId);
    this.#store.orm
      .insert(contextRefs)
      .values({
        contextId: header.id,
        ref,
        kind: 'reply',
        sourceSeq,
        targetConversationId: target.conversationId,
        targetThreadId: target.threadId,
        expiresAt: this.#expiry(now),
        createdAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: [contextRefs.contextId, contextRefs.ref],
        set: {
          sourceSeq,
          targetConversationId: target.conversationId,
          targetThreadId: target.threadId,
          expiresAt: this.#expiry(now),
        },
      })
      .run();
    return ref;
  }

  /**
   * Resolves a reference inside its own context. A reference whose source
   * message has been evicted, whose row is gone, or whose TTL passed does not
   * resolve — that is the whole authorization rule.
   */
  resolve(header: ContextHeader, ref: string, kind: ContextRefKind, now = new Date()): ResolvedContextRef | undefined {
    const row = this.#store.orm
      .select({
        ref: contextRefs.ref,
        kind: contextRefs.kind,
        sourceSeq: contextRefs.sourceSeq,
        mediaId: contextRefs.mediaId,
        stickerFileId: contextRefs.stickerFileId,
        targetConversationId: contextRefs.targetConversationId,
        targetThreadId: contextRefs.targetThreadId,
        expiresAt: contextRefs.expiresAt,
      })
      .from(contextRefs)
      .where(and(eq(contextRefs.contextId, header.id), eq(contextRefs.ref, ref), eq(contextRefs.kind, kind)))
      .get();
    if (row === undefined || row.sourceSeq < header.headSeq || Date.parse(row.expiresAt) <= now.getTime()) {
      return undefined;
    }
    return {
      ref: row.ref,
      kind: row.kind as ContextRefKind,
      mediaId: row.mediaId,
      stickerFileId: row.stickerFileId,
      targetConversationId: row.targetConversationId,
      targetThreadId: row.targetThreadId,
    };
  }

  count(header: ContextHeader): number {
    const row = this.#store.orm.all<{ count: bigint }>(
      sql`SELECT COUNT(*) AS count FROM context_refs WHERE context_id = ${header.id}`,
    )[0];
    return Number(row?.count ?? 0n);
  }

  #insert(
    header: ContextHeader,
    values: {
      readonly ref: string;
      readonly kind: ContextRefKind;
      readonly sourceSeq: bigint;
      readonly mediaId: bigint | null;
      readonly stickerFileId: string | null;
      readonly targetConversationId: bigint | null;
      readonly targetThreadId: bigint | null;
    },
    now: Date,
  ): void {
    this.#store.orm
      .insert(contextRefs)
      .values({
        contextId: header.id,
        ref: values.ref,
        kind: values.kind,
        sourceSeq: values.sourceSeq,
        mediaId: values.mediaId,
        stickerFileId: values.stickerFileId,
        targetConversationId: values.targetConversationId,
        targetThreadId: values.targetThreadId,
        expiresAt: this.#expiry(now),
        createdAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: [contextRefs.contextId, contextRefs.ref],
        set: { sourceSeq: values.sourceSeq, expiresAt: this.#expiry(now) },
      })
      .run();
  }

  #expiry(now: Date): string {
    return new Date(now.getTime() + this.#ttlHours * 3_600_000).toISOString();
  }
}

export function replyRefFor(telegramMessageId: bigint): string {
  return `reply:${telegramMessageId.toString()}`;
}

/**
 * Binds a reference resolver to one Conversation Context. Every tool boundary
 * resolves references through this, so there is exactly one place that decides
 * whether a `img_` / `stk_` / reply ref is still authorized.
 */
export function createCapabilityResolver(
  refs: ContextRefStore,
  header: ContextHeader,
  now: () => Date = () => new Date(),
): CapabilityRefResolver {
  return {
    resolveMedia: (ref) => refs.resolve(header, ref, 'media', now())?.mediaId ?? undefined,
    resolveStickerRef: (ref) => refs.resolve(header, ref, 'sticker', now())?.stickerFileId ?? undefined,
    resolveReplyTarget: (messageId) => {
      const resolved = refs.resolve(header, replyRefFor(BigInt(messageId)), 'reply', now());
      const conversationId = resolved?.targetConversationId;
      const threadId = resolved?.targetThreadId;
      if (conversationId === undefined || conversationId === null || threadId === undefined || threadId === null) {
        return undefined;
      }
      return { conversationId, threadId };
    },
    registerStickerRef: (fileId) =>
      refs.stickerRef(header, fileId, header.nextSeq > header.headSeq ? header.nextSeq - 1n : header.headSeq, now()),
  };
}

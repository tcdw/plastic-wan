/**
 * Shared invocation-context value types. This is a leaf module: it must not
 * import any other src module, because context-builder, memory, and every tool
 * boundary depend on these types.
 */

// ── JSON value types (leaf, shared by store and plugins) ───────────

/** Serializable JSON values that survive TypeBox + JSON.stringify round-trips. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

/** Delivery policy frozen at task creation, consumed when the receipt is injected. */
export interface DeliveryPolicy {
  readonly bypassDailyBudget: boolean;
  readonly mentionUser?:
    | {
        readonly userId: bigint;
        readonly displayName: string;
      }
    | undefined;
}

/** Completion receipt currently being handled by the agent (one receipt per round). */
export interface CompletionContext {
  readonly taskId: bigint;
  readonly pluginId: string;
  readonly payload: JsonValue;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly resultJson?: JsonValue;
  readonly errorJson?: JsonValue;
  readonly delivery: DeliveryPolicy;
}

// ── Invocation context ────────────────────────────────────────────

export interface ReplyTarget {
  readonly conversationId: bigint;
  readonly threadId: bigint;
}
export interface DirectImage {
  readonly mediaId: bigint;
  readonly imageRef: string;
}
export interface VisibleSender {
  readonly userId: bigint;
  readonly displayName: string;
  readonly username: string | null;
}

/**
 * Resolves capability references (`img_`, `stk_`, `reply:<message id>`) for the
 * Conversation Context currently running. References live in the context with a
 * TTL, so a ref quoted in retained history keeps working across invocations and
 * stops working once its message is evicted. A ref never resolves outside the
 * context that minted it.
 */
export interface CapabilityRefResolver {
  resolveMedia(ref: string): bigint | undefined;
  resolveStickerRef(ref: string): string | undefined;
  resolveReplyTarget(messageId: string): ReplyTarget | undefined;
  /** Authorizes one sticker file for the rest of the context's reference TTL. */
  registerStickerRef(stickerFileId: string): string;
}

/** Resolver for contexts that authorize nothing (registry validation, previews). */
export function unavailableCapabilities(): CapabilityRefResolver {
  return {
    resolveMedia: () => undefined,
    resolveStickerRef: () => undefined,
    resolveReplyTarget: () => undefined,
    registerStickerRef: () => {
      throw new Error('Sticker authorization is unavailable outside a running conversation context');
    },
  };
}

export interface InvocationContext {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly directImages: readonly DirectImage[];
  readonly visibleSenders: ReadonlyMap<string, VisibleSender>;
  readonly callerUserId: bigint | null;
  readonly completion: CompletionContext | null;
  readonly omittedNewMessages: number;
}

/**
 * Mutable context for one running invocation.
 *
 * Tools capture this object once and read it at call time, so each injected
 * batch refreshes the parts that grow with the conversation (visible senders,
 * direct images, the newest caller) instead of forcing a tool rebuild that the
 * agent loop would not pick up mid-run anyway.
 */
export class InvocationContextState implements InvocationContext {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  #systemPrompt = '';
  #userPrompt = '';
  #directImages: DirectImage[] = [];
  #visibleSenders = new Map<string, VisibleSender>();
  #callerUserId: bigint | null = null;
  #completion: CompletionContext | null = null;
  #omittedNewMessages = 0;

  constructor(identity: {
    readonly invocationId: bigint;
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly threadId: bigint;
    readonly completion: CompletionContext | null;
  }) {
    this.invocationId = identity.invocationId;
    this.conversationId = identity.conversationId;
    this.chatId = identity.chatId;
    this.threadId = identity.threadId;
    this.#completion = identity.completion;
  }

  get systemPrompt(): string {
    return this.#systemPrompt;
  }
  get userPrompt(): string {
    return this.#userPrompt;
  }
  get directImages(): readonly DirectImage[] {
    return this.#directImages;
  }
  get visibleSenders(): ReadonlyMap<string, VisibleSender> {
    return this.#visibleSenders;
  }
  get callerUserId(): bigint | null {
    return this.#callerUserId;
  }
  get completion(): CompletionContext | null {
    return this.#completion;
  }
  get omittedNewMessages(): number {
    return this.#omittedNewMessages;
  }

  setSystemPrompt(systemPrompt: string): void {
    this.#systemPrompt = systemPrompt;
  }

  /** Applies one injected batch: the newest state wins, senders accumulate. */
  applyInjection(injection: {
    readonly callerUserId: bigint | null;
    readonly completion: CompletionContext | null;
    readonly directImages: readonly DirectImage[];
    readonly omittedNewMessages: number;
    readonly text: string;
    readonly visibleSenders: readonly VisibleSender[];
  }): void {
    this.#userPrompt = injection.text;
    this.#directImages = [...injection.directImages];
    this.#omittedNewMessages = injection.omittedNewMessages;
    this.#completion = injection.completion;
    // A completion is not a new user request and must not inherit the previous
    // speaker's authority to inspect or cancel their tasks.
    if (injection.completion !== null || injection.callerUserId !== null) {
      this.#callerUserId = injection.callerUserId;
    }
    for (const sender of injection.visibleSenders) {
      this.#visibleSenders.set(sender.userId.toString(), sender);
    }
  }

  finishCompletion(): void {
    this.#completion = null;
  }

  /** Drops state for messages that no longer exist in the retained segment. */
  retainVisibleSenders(senders: readonly VisibleSender[]): void {
    this.#visibleSenders = new Map(senders.map((sender) => [sender.userId.toString(), sender]));
  }

  /** Recomputes the trusted caller after history was collected. */
  setCallerUserId(callerUserId: bigint | null): void {
    this.#callerUserId = this.#completion === null ? callerUserId : null;
  }
}

/** Neutral context for registry-time tool validation, outside any invocation. */
export function previewContext(): InvocationContext {
  return {
    invocationId: 0n,
    conversationId: 0n,
    chatId: 0n,
    threadId: 0n,
    systemPrompt: '',
    userPrompt: '',
    directImages: [],
    visibleSenders: new Map(),
    callerUserId: null,
    completion: null,
    omittedNewMessages: 0,
  };
}

/**
 * Shared invocation-context value types. This is a leaf module: it must not
 * import any other src module, because context-builder, memory, and every tool
 * boundary depend on these types.
 */
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
export interface AlarmContext {
  readonly userId: bigint;
  readonly displayName: string;
  readonly summary: string;
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
  readonly alarm: AlarmContext | null;
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
  #alarm: AlarmContext | null = null;
  #omittedNewMessages = 0;

  constructor(identity: {
    readonly invocationId: bigint;
    readonly conversationId: bigint;
    readonly chatId: bigint;
    readonly threadId: bigint;
    readonly alarm: AlarmContext | null;
  }) {
    this.invocationId = identity.invocationId;
    this.conversationId = identity.conversationId;
    this.chatId = identity.chatId;
    this.threadId = identity.threadId;
    this.#alarm = identity.alarm;
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
  get alarm(): AlarmContext | null {
    return this.#alarm;
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
    readonly directImages: readonly DirectImage[];
    readonly omittedNewMessages: number;
    readonly text: string;
    readonly visibleSenders: readonly VisibleSender[];
  }): void {
    this.#userPrompt = injection.text;
    this.#directImages = [...injection.directImages];
    this.#omittedNewMessages = injection.omittedNewMessages;
    if (injection.callerUserId !== null) {
      this.#callerUserId = injection.callerUserId;
    }
    for (const sender of injection.visibleSenders) {
      this.#visibleSenders.set(sender.userId.toString(), sender);
    }
  }

  /** Drops state for messages that no longer exist in the retained segment. */
  retainVisibleSenders(senders: readonly VisibleSender[]): void {
    this.#visibleSenders = new Map(senders.map((sender) => [sender.userId.toString(), sender]));
  }

  /** Recomputes the trusted caller after history was collected. */
  setCallerUserId(callerUserId: bigint | null): void {
    this.#callerUserId = callerUserId;
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
    alarm: null,
    omittedNewMessages: 0,
  };
}

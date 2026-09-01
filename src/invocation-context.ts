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
export interface InvocationContext {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly imageCapabilities: ReadonlyMap<string, bigint>;
  readonly directImages: readonly DirectImage[];
  readonly replyTargets: ReadonlyMap<string, ReplyTarget>;
  readonly visibleSenders: ReadonlyMap<string, VisibleSender>;
  readonly callerUserId: bigint | null;
  readonly alarm: AlarmContext | null;
  readonly omittedNewMessages: number;
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
    imageCapabilities: new Map(),
    directImages: [],
    replyTargets: new Map(),
    visibleSenders: new Map(),
    callerUserId: null,
    alarm: null,
    omittedNewMessages: 0,
  };
}

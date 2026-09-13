import type { Agent } from '@earendil-works/pi-agent-core';
import type { ContextHeader } from '../context/context-store.ts';

/**
 * Per-Conversation runtime state: the cached Pi agent instance, the queue of
 * buckets attached to a running invocation, and the "this run is ending" flag.
 *
 * The canonical Conversation Context in SQLite is the only truth; the cached
 * agent is a disposable cache and eviction is always safe because a missing
 * entry is rebuilt from `context_messages`. The closing flag is load-bearing:
 * the attach path must not hand a bucket to a run that has already decided to
 * stop, and the runtime must not stop while a bucket is waiting to be injected.
 */

export interface CachedConversationAgent {
  readonly conversationId: bigint;
  readonly agent: Agent;
  header: ContextHeader;
  /** Sequence number of each transcript entry; `null` for non-persisted rows. */
  transcriptSeqs: (bigint | null)[];
  systemPromptHash: string;
  lastUsedAt: number;
}

export type InjectionWaitResult = 'pending' | 'timeout' | 'aborted';

interface ConversationState {
  agent: CachedConversationAgent | undefined;
  pendingBuckets: bigint[];
  wake: (() => void) | undefined;
  closing: boolean;
}

export interface ConversationRuntimeOptions {
  readonly agentCacheSize: number;
}

export class ConversationRuntime {
  readonly #states = new Map<string, ConversationState>();
  readonly #cacheSize: number;
  #evicted = 0;

  constructor(options: ConversationRuntimeOptions) {
    this.#cacheSize = options.agentCacheSize;
  }

  cachedAgent(conversationId: bigint): CachedConversationAgent | undefined {
    const state = this.#state(conversationId);
    if (state.agent !== undefined) {
      state.agent.lastUsedAt = Date.now();
    }
    return state.agent;
  }

  /** Stores (or replaces) the cached agent and enforces the LRU bound. */
  remember(entry: CachedConversationAgent): void {
    const state = this.#state(entry.conversationId);
    state.agent = entry;
    entry.lastUsedAt = Date.now();
    this.#evictOverflow(entry.conversationId);
  }

  forget(conversationId: bigint): void {
    const state = this.#states.get(conversationId.toString());
    if (state !== undefined) {
      state.agent = undefined;
    }
  }

  get cachedAgentCount(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.agent !== undefined) {
        count += 1;
      }
    }
    return count;
  }

  get evictedAgentCount(): number {
    return this.#evicted;
  }

  /**
   * Marks a run as ending. After this returns, `attach` callers see
   * `isClosing` and leave their bucket for a fresh invocation, which is what
   * keeps "no bucket is handed to a dying run" true without a lock.
   */
  beginClosing(conversationId: bigint): void {
    this.#state(conversationId).closing = true;
  }

  endClosing(conversationId: bigint): void {
    const state = this.#states.get(conversationId.toString());
    if (state !== undefined) {
      state.closing = false;
    }
  }

  isClosing(conversationId: bigint): boolean {
    return this.#states.get(conversationId.toString())?.closing === true;
  }

  /** Queues one attached bucket and wakes a run waiting for new messages. */
  queueInjection(conversationId: bigint, bucketId: bigint): void {
    const state = this.#state(conversationId);
    state.pendingBuckets.push(bucketId);
    const wake = state.wake;
    state.wake = undefined;
    wake?.();
  }

  takeInjections(conversationId: bigint): bigint[] {
    const state = this.#states.get(conversationId.toString());
    if (state === undefined) {
      return [];
    }
    const pending = state.pendingBuckets;
    state.pendingBuckets = [];
    return pending;
  }

  hasPendingInjections(conversationId: bigint): boolean {
    return (this.#states.get(conversationId.toString())?.pendingBuckets.length ?? 0) > 0;
  }

  /**
   * Waits for the next attached bucket. `timeout` is the configured idle grace:
   * when it expires the run ends normally, so an idle Conversation does not hold
   * an invocation open forever.
   */
  async waitForInjection(
    conversationId: bigint,
    timeoutMilliseconds: number,
    signal: AbortSignal,
  ): Promise<InjectionWaitResult> {
    if (this.hasPendingInjections(conversationId)) {
      return 'pending';
    }
    if (timeoutMilliseconds <= 0 || signal.aborted) {
      return signal.aborted ? 'aborted' : 'timeout';
    }
    const state = this.#state(conversationId);
    return await new Promise<InjectionWaitResult>((resolve) => {
      let settled = false;
      const finish = (result: InjectionWaitResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (state.wake === onWake) {
          state.wake = undefined;
        }
        resolve(result);
      };
      const onWake = (): void => finish('pending');
      const onAbort = (): void => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), timeoutMilliseconds);
      state.wake = onWake;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #evictOverflow(protectedConversationId: bigint): void {
    while (this.cachedAgentCount > this.#cacheSize) {
      let victim: CachedConversationAgent | undefined;
      for (const state of this.#states.values()) {
        const agent = state.agent;
        if (agent === undefined || agent.conversationId === protectedConversationId) {
          continue;
        }
        if (victim === undefined || agent.lastUsedAt < victim.lastUsedAt) {
          victim = agent;
        }
      }
      if (victim === undefined) {
        return;
      }
      this.forget(victim.conversationId);
      this.#evicted += 1;
    }
  }

  #state(conversationId: bigint): ConversationState {
    const key = conversationId.toString();
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { agent: undefined, pendingBuckets: [], wake: undefined, closing: false };
      this.#states.set(key, state);
    }
    return state;
  }
}

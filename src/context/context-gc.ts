import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextWindowRow } from './context-store.ts';

/**
 * Discard-only Context GC.
 *
 * Retention is expressed as "how many `send` calls should stay visible":
 * checkpoints mark the start of an injected batch, and collection jumps to an
 * older checkpoint so one GC crosses several sends instead of trimming message
 * by message — the sliding-window shape the design asks for. Nothing is ever
 * summarized; dropped history is simply gone.
 *
 * A token ratio is the safety valve for transcripts that grow without many
 * sends (long tool chains).
 */

export type { ContextWindowRow } from './context-store.ts';

export interface ContextGcOptions {
  readonly retainedSendsTarget: number;
  readonly retainedSendsMax: number;
  readonly hardTokenRatio: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Estimated input tokens of the current loop context. */
  readonly estimatedInputTokens: number;
  readonly headSeq: bigint;
  /** One entry per loop message, in transcript order; `null` for filtered rows. */
  readonly transcriptSeqs: readonly (bigint | null)[];
  readonly window: readonly ContextWindowRow[];
  readonly messages: readonly AgentMessage[];
}

export interface ContextGcPlan {
  readonly targetSeq: bigint;
  readonly retainedIndex: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly beforeSends: number;
  readonly afterSends: number;
  readonly beforeMessages: number;
  readonly afterMessages: number;
}

const TOKEN_TARGET_FRACTION = 0.8;

/**
 * Decides whether this turn boundary should collect, and where the retained
 * segment would start. Returns `undefined` when nothing should change.
 */
export function planContextGc(options: ContextGcOptions): ContextGcPlan | undefined {
  const rows = options.window;
  if (rows.length === 0) {
    return undefined;
  }
  const beforeSends = countSends(rows, options.headSeq);
  const tokenPressure =
    options.estimatedInputTokens + options.maxOutputTokens >= options.contextWindow * options.hardTokenRatio;
  if (beforeSends <= options.retainedSendsMax && !tokenPressure) {
    return undefined;
  }
  const checkpoints = rows.filter((row) => row.isCheckpoint && row.seq > options.headSeq);
  if (checkpoints.length === 0) {
    // Cold start: no checkpoint above the head yet, so there is nothing safe to
    // cut to. The caller falls back to closing mode instead.
    return undefined;
  }
  const target =
    // Newest checkpoint that still keeps `retained_sends_target` sends: the
    // window slides instead of trimming message by message, exactly what the
    // "keep the latest ~N sends" requirement asks for.
    checkpoints.toReversed().find((candidate) => countSends(rows, candidate.seq) >= options.retainedSendsTarget) ??
    // Tool-heavy, send-light histories: fall back to the token criterion, which
    // takes the newest checkpoint already under the soft token budget.
    checkpoints.toReversed().find((candidate) => tokensFrom(rows, candidate.seq) <= tokenBudget(options));
  if (target === undefined) {
    return undefined;
  }
  const retainedIndex = options.transcriptSeqs.indexOf(target.seq);
  if (retainedIndex <= 0) {
    return undefined;
  }
  const retained = options.messages.slice(retainedIndex);
  if (!isRenderable(retained)) {
    return undefined;
  }
  return {
    targetSeq: target.seq,
    retainedIndex,
    beforeTokens: sumTokens(rows),
    afterTokens: tokensFrom(rows, target.seq),
    beforeSends,
    afterSends: countSends(rows, target.seq),
    beforeMessages: rows.length,
    afterMessages: rows.filter((row) => row.seq >= target.seq).length,
  };
}

function tokenBudget(options: ContextGcOptions): number {
  return options.contextWindow * options.hardTokenRatio * TOKEN_TARGET_FRACTION;
}

function countSends(rows: readonly ContextWindowRow[], fromSeq: bigint): number {
  return rows.filter((row) => row.seq >= fromSeq && row.sendSeq !== null).length;
}

function tokensFrom(rows: readonly ContextWindowRow[], fromSeq: bigint): number {
  return rows.filter((row) => row.seq >= fromSeq).reduce((total, row) => total + Number(row.estTokens), 0);
}

function sumTokens(rows: readonly ContextWindowRow[]): number {
  return rows.reduce((total, row) => total + Number(row.estTokens), 0);
}

/**
 * Structural guard for a retained segment.
 *
 * `pi-ai` only repairs missing tool results; an orphan `toolResult` is sent
 * as-is and makes the provider reject the request, so a segment must never
 * start with one and every tool result must have its assistant tool call
 * somewhere ahead of it.
 */
export function isRenderable(messages: readonly AgentMessage[]): boolean {
  const first = messages[0];
  if (first === undefined || first.role !== 'user') {
    return false;
  }
  const pendingCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          pendingCalls.add(block.id);
        }
      }
      continue;
    }
    if (message.role === 'toolResult') {
      if (!pendingCalls.has(message.toolCallId)) {
        return false;
      }
      pendingCalls.delete(message.toolCallId);
    }
  }
  return true;
}

/** Convenience for callers that only need the retained slice. */
export function retainedMessages(messages: readonly AgentMessage[], retainedIndex: number): AgentMessage[] {
  return messages.slice(retainedIndex);
}

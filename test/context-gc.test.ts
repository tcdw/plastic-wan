import { describe, expect, test } from 'bun:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { type ContextWindowRow, planContextGc } from '../src/context/context-gc.ts';

/**
 * GC is planned against light row projections plus the loop's current messages,
 * so the whole algorithm is testable without a database.
 */
function row(seq: bigint, isCheckpoint: boolean, sendSeq: bigint | null, estTokens = 100): ContextWindowRow {
  return { seq, role: isCheckpoint ? 'user' : 'assistant', estTokens: BigInt(estTokens), isCheckpoint, sendSeq };
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'agent',
    model: 'agent-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
  };
}

/** Mirrors the invariant that every injected batch starts a user message. */
function transcript(rows: readonly ContextWindowRow[]): AgentMessage[] {
  return rows.map((entry, index) =>
    entry.isCheckpoint
      ? ({ role: 'user', content: `m${index}`, timestamp: index } satisfies AgentMessage)
      : assistant(`m${index}`),
  );
}

const base = {
  hardTokenRatio: 0.6,
  contextWindow: 200_000,
  maxOutputTokens: 1_000,
  estimatedInputTokens: 500,
  headSeq: 1n,
} as const;

describe('context gc planning', () => {
  test('stays quiet below the send threshold', () => {
    const rows = [row(1n, true, null), row(2n, false, null, 10), row(3n, true, 1n, 10)];
    expect(
      planContextGc({
        ...base,
        retainedSendsTarget: 2,
        retainedSendsMax: 6,
        transcriptSeqs: [1n, 2n, 3n],
        window: rows,
        messages: transcript(rows),
      }),
    ).toBeUndefined();
  });

  test('slides to the newest checkpoint that still keeps the target sends', () => {
    // Five batches, one send each; the head is already at the first message.
    const rows: ContextWindowRow[] = [];
    for (let index = 0; index < 5; index += 1) {
      rows.push(row(BigInt(index * 3 + 1), true, null));
      rows.push(row(BigInt(index * 3 + 2), false, BigInt(index + 1), 10));
      rows.push(row(BigInt(index * 3 + 3), false, null, 10));
    }
    const plan = planContextGc({
      ...base,
      retainedSendsTarget: 2,
      retainedSendsMax: 3,
      transcriptSeqs: rows.map((entry) => entry.seq),
      window: rows,
      messages: transcript(rows),
    });
    if (plan === undefined) {
      throw new Error('Expected a collection plan');
    }
    // One jump crosses three sends instead of trimming message by message; the
    // retained segment still holds the two newest sends and starts on a
    // checkpoint user message.
    expect(plan.targetSeq).toBe(10n);
    expect(plan.beforeSends).toBe(5);
    expect(plan.afterSends).toBe(2);
    expect(plan.retainedIndex).toBe(9);
    expect(rows.find((entry) => entry.seq === plan.targetSeq)?.isCheckpoint).toBe(true);
    expect(plan.afterMessages).toBeLessThan(plan.beforeMessages);
    expect(plan.afterTokens).toBeLessThan(plan.beforeTokens);
  });

  test('does not collect when there is no checkpoint above the head', () => {
    const rows = [row(1n, false, null), row(2n, false, null, 10)];
    expect(
      planContextGc({
        ...base,
        retainedSendsTarget: 1,
        retainedSendsMax: 1,
        transcriptSeqs: [1n, 2n],
        window: rows,
        messages: transcript(rows),
      }),
    ).toBeUndefined();
  });

  test('cuts on token pressure alone when sends stay low', () => {
    const rows: ContextWindowRow[] = [];
    for (let index = 0; index < 10; index += 1) {
      rows.push(row(BigInt(index * 2 + 1), true, null, 10_000));
      rows.push(row(BigInt(index * 2 + 2), false, null, 10_000));
    }
    const plan = planContextGc({
      ...base,
      retainedSendsTarget: 20,
      retainedSendsMax: 30,
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      estimatedInputTokens: 59_000,
      transcriptSeqs: rows.map((entry) => entry.seq),
      window: rows,
      messages: transcript(rows),
    });
    if (plan === undefined) {
      throw new Error('Expected token-pressure collection');
    }
    // No send at all, so the send window cannot decide; the token valve does.
    expect(plan.beforeSends).toBe(0);
    expect(plan.afterTokens).toBeLessThanOrEqual(100_000 * 0.6 * 0.8);
  });

  test('refuses to cut when the retained segment would start with a tool result', () => {
    const rows = [row(1n, true, null), row(2n, false, null, 10), row(3n, true, null, 10)];
    const messages: AgentMessage[] = [
      { role: 'user', content: 'a', timestamp: 0 },
      {
        role: 'toolResult',
        toolCallId: 'orphan',
        toolName: 'send',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 1,
      },
      { role: 'user', content: 'b', timestamp: 2 },
    ];
    expect(
      planContextGc({
        ...base,
        retainedSendsTarget: 1,
        retainedSendsMax: 1,
        transcriptSeqs: [1n, 2n, 3n],
        window: rows,
        messages,
      }),
    ).toBeUndefined();
  });

  test('never targets the row the head already points at', () => {
    const rows = [row(1n, true, null), row(2n, false, null, 10), row(3n, false, null, 10)];
    expect(
      planContextGc({
        ...base,
        retainedSendsTarget: 1,
        retainedSendsMax: 1,
        transcriptSeqs: [1n, 2n, 3n],
        window: rows,
        messages: transcript(rows),
      }),
    ).toBeUndefined();
  });
});

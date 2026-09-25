import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { buckets, chats, conversations, dailyUsage, invocations, modelCalls } from '../src/store/schema.ts';
import { reconcileDailyTokenUsage } from '../scripts/reconcile-daily-token-usage.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const DAY = '2026-09-10';
const QUIET_DAY = '2026-09-11';
const PURGED_DAY = '2026-09-01';
const PARTIAL_DAY = '2026-09-02';

function at(day: string): string {
  return `${day}T08:00:00.000Z`;
}

function modelCall(
  id: bigint,
  day: string,
  role: string,
  tokens: readonly [input: bigint, output: bigint, cacheRead: bigint, cacheWrite: bigint],
): typeof modelCalls.$inferInsert {
  const [input, output, cacheRead, cacheWrite] = tokens;
  return {
    id,
    invocationId: role === 'vision_sticker' || role === 'doctor' ? null : 1n,
    role,
    provider: 'agent',
    model: 'agent-model',
    attempt: 1n,
    state: 'success',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    createdAt: at(day),
    finishedAt: at(day),
  };
}

/** A dev database as the retired migration 018 left it: cache-excluded rollup rows. */
async function seededStore(): Promise<SqliteStore> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-reconcile-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const store = await SqliteStore.open((await loadConfig(configPath)).config);
  const now = at(DAY);
  store.orm
    .insert(chats)
    .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
    .run();
  store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
  store.orm
    .insert(buckets)
    .values({
      id: 1n,
      conversationId: 1n,
      state: 'completed',
      firstReceivedAt: now,
      deadlineAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  store.orm
    .insert(invocations)
    .values({
      id: 1n,
      bucketId: 1n,
      conversationId: 1n,
      state: 'completed',
      configHash: 'hash',
      promptVersion: 1n,
      createdAt: now,
    })
    .run();
  // `model_calls.invocation_id` is NOT NULL in the drizzle schema but nullable in
  // the migrations, so sticker and doctor rows go through raw SQL.
  const insertNullable = store.db.prepare(
    `INSERT INTO model_calls(id, invocation_id, role, provider, model, attempt, state, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, total_tokens, created_at, finished_at)
     VALUES (@id, NULL, @role, @provider, @model, 1, 'success', @inputTokens, @outputTokens, @cacheReadTokens,
       @cacheWriteTokens, @totalTokens, @createdAt, @finishedAt)`,
  );
  const calls = [
    modelCall(1n, DAY, 'agent', [1_000n, 250n, 40_000n, 500n]),
    modelCall(2n, DAY, 'vision_chat', [100n, 10n, 0n, 0n]),
    modelCall(3n, DAY, 'vision_sticker', [100n, 20n, 900n, 0n]),
    // Doctor probes never write daily_usage and must not be folded in.
    modelCall(4n, DAY, 'doctor', [5n, 5n, 5n, 5n]),
    modelCall(5n, QUIET_DAY, 'agent', [10n, 5n, 0n, 0n]),
    modelCall(6n, PARTIAL_DAY, 'agent', [10n, 5n, 100n, 0n]),
  ];
  for (const call of calls) {
    if (call.invocationId === null) {
      insertNullable.run(call);
    } else {
      store.orm.insert(modelCalls).values(call).run();
    }
  }
  const usage = (day: string, scope: string, resource: string, metric: string, amount: bigint) => ({
    utcDate: day,
    scope,
    resource,
    metric,
    amount,
    updatedAt: now,
  });
  store.orm
    .insert(dailyUsage)
    .values([
      usage(DAY, 'chat', '123456789', 'model_tokens', 1_360n),
      usage(DAY, 'system', 'sticker_index', 'vision_tokens', 120n),
      usage(DAY, 'system', 'sticker_index', 'vision_images', 3n),
      usage(QUIET_DAY, 'chat', '123456789', 'model_tokens', 15n),
      // Retention purged every audit row of this day.
      usage(PURGED_DAY, 'chat', '123456789', 'model_tokens', 5_000n),
      // Retention purged part of this day's audit rows.
      usage(PARTIAL_DAY, 'chat', '123456789', 'model_tokens', 9_999n),
    ])
    .run();
  return store;
}

function amounts(store: SqliteStore): Record<string, bigint> {
  return Object.fromEntries(
    store.orm
      .select()
      .from(dailyUsage)
      .all()
      .map((row) => [`${row.utcDate} ${row.resource} ${row.metric}`, row.amount]),
  );
}

const BEFORE = {
  [`${DAY} 123456789 model_tokens`]: 1_360n,
  [`${DAY} sticker_index vision_tokens`]: 120n,
  [`${DAY} sticker_index vision_images`]: 3n,
  [`${QUIET_DAY} 123456789 model_tokens`]: 15n,
  [`${PURGED_DAY} 123456789 model_tokens`]: 5_000n,
  [`${PARTIAL_DAY} 123456789 model_tokens`]: 9_999n,
};

const AFTER = {
  ...BEFORE,
  [`${DAY} 123456789 model_tokens`]: 41_860n,
  [`${DAY} sticker_index vision_tokens`]: 1_020n,
};

test('dry run reports the reconciliation without writing', async () => {
  const store = await seededStore();
  try {
    const rows = reconcileDailyTokenUsage(store.db, { apply: false });
    expect(
      rows.map((row) => [row.utcDate, row.metric, row.status, row.oldTotal, row.recalculatedTotal, row.delta]),
    ).toEqual([
      [PURGED_DAY, 'model_tokens', 'unreconcilable', 5_000n, 0n, 0n],
      [PARTIAL_DAY, 'model_tokens', 'unreconcilable', 9_999n, 115n, 0n],
      [DAY, 'model_tokens', 'reconcile', 1_360n, 41_860n, 40_500n],
      [DAY, 'vision_tokens', 'reconcile', 120n, 1_020n, 900n],
      [QUIET_DAY, 'model_tokens', 'already_reconciled', 15n, 15n, 0n],
    ]);
    expect(rows.find((row) => row.utcDate === DAY && row.metric === 'model_tokens')).toMatchObject({
      cacheReadTokens: 40_000n,
      cacheWriteTokens: 500n,
      modelCalls: 2n,
    });
    expect(rows.find((row) => row.utcDate === PURGED_DAY)?.reason).toContain('no model_calls rows');
    expect(amounts(store)).toEqual(BEFORE);
  } finally {
    store.close();
  }
});

test('apply rebuilds cache-inclusive totals and is idempotent', async () => {
  const store = await seededStore();
  try {
    reconcileDailyTokenUsage(store.db, { apply: true });
    expect(amounts(store)).toEqual(AFTER);

    const again = reconcileDailyTokenUsage(store.db, { apply: true });
    expect(again.filter((row) => row.status === 'reconcile')).toEqual([]);
    expect(again.filter((row) => row.status === 'unreconcilable')).toHaveLength(2);
    expect(amounts(store)).toEqual(AFTER);
  } finally {
    store.close();
  }
});

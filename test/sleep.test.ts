import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { type LoadedConfig, loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import type { ModelRegistry } from '../src/platform/providers.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { activeSleepUntil, enterSleep, SLEEP_STATE_KEY } from '../src/store/sleep.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

const update: Update = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: 123456789, type: 'private', first_name: 'Owner' },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
    text: 'hello',
  },
};

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function openStore(prefix = 'plasticwan-sleep-'): Promise<{ loaded: LoadedConfig; store: SqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  return { loaded, store: await SqliteStore.open(loaded.config) };
}

async function runtimeSetup(
  usedTokens: bigint,
  usageResource = '123456789',
): Promise<{
  store: SqliteStore;
  runtime: AgentRuntime;
  invocationId: bigint;
  faux: FauxProviderHandle;
}> {
  const { loaded, store } = await openStore();
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const now = new Date().toISOString();
  store.db
    .query(
      "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?)",
    )
    .run(now.slice(0, 10), usageResource, usedTokens, now);

  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
  let messageId = 500;
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    secrets: new SecretStore(),
    registry,
    modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
    telegramApi: api,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
  });
  return { store, runtime, invocationId, faux };
}

function modelToolLists(store: SqliteStore): string[][] {
  return store.db
    .query<{ tools_json: string }, []>("SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id")
    .all()
    .map((row) => JSON.parse(row.tools_json) as string[]);
}

test('does not expose zzz while more than five percent remains', async () => {
  const { store, runtime, invocationId, faux } = await runtimeSetup(284_999n);
  faux.setResponses([fauxAssistantMessage('done')]);
  await runtime.run(invocationId, new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['send']]);
  store.close();
});

test('exposes zzz after global remaining budget falls below five percent', async () => {
  const { store, runtime, invocationId, faux } = await runtimeSetup(285_001n, '987654321');
  faux.setResponses([fauxAssistantMessage('done')]);
  await runtime.run(invocationId, new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['send', 'zzz']]);
  store.close();
});

test('blocks model calls after another chat exhausts the global daily budget', async () => {
  const { store, runtime, invocationId } = await runtimeSetup(300_000n, '987654321');
  expect(await runtime.run(invocationId, new AbortController().signal)).toEqual({
    state: 'failed',
    reason: 'daily_token_budget',
  });
  expect(modelToolLists(store)).toEqual([]);
  store.close();
});

test('keeps zzz hidden at exactly five percent remaining', async () => {
  const { store, runtime, invocationId, faux } = await runtimeSetup(285_000n);
  faux.setResponses([fauxAssistantMessage('done')]);
  await runtime.run(invocationId, new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['send']]);
  store.close();
});

test('adds zzz at the next turn boundary when a running session crosses the threshold', async () => {
  const { store, runtime, invocationId, faux } = await runtimeSetup(285_000n);
  const first = fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'good night' }), {
    stopReason: 'toolUse',
  });
  faux.setResponses([
    {
      ...first,
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    fauxAssistantMessage(fauxToolCall('zzz', {}), { stopReason: 'toolUse' }),
  ]);
  await runtime.run(invocationId, new AbortController().signal);
  expect(modelToolLists(store)).toEqual([['send'], ['send', 'zzz']]);
  expect(activeSleepUntil(store.orm)).not.toBeNull();
  store.close();
});

test('zzz enters sleeping and ends without another model turn', async () => {
  const { store, runtime, invocationId, faux } = await runtimeSetup(285_001n);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('zzz', {}), { stopReason: 'toolUse' })]);
  expect(await runtime.run(invocationId, new AbortController().signal)).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  expect(activeSleepUntil(store.orm)).not.toBeNull();
  expect(modelToolLists(store)).toHaveLength(1);
  expect(
    store.db
      .query<{ count: bigint }, []>(
        "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'zzz' AND state = 'success'",
      )
      .get()?.count,
  ).toBe(1n);
  expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(0n);
  store.close();
});

test('sleeping skips both due and already queued agent sessions', async () => {
  const { loaded, store } = await openStore();
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => {
    throw new Error('Sleeping scheduler must not create an agent session');
  });
  const now = new Date();
  ingestion.ingest(update, now);
  enterSleep(store.orm, new Date(now.getTime() + 16_000));
  expect(scheduler.processDue(new Date(now.getTime() + 15_000))).toEqual([]);

  const secondUpdate = structuredClone(update);
  if (secondUpdate.message === undefined) {
    throw new Error('Expected message update');
  }
  secondUpdate.update_id = 2;
  secondUpdate.message.message_id = 11;
  const secondReceived = new Date(now.getTime() + 17_000);
  activeSleepUntil(store.orm, new Date(now.getTime() + 16_500));
  store.db.query('DELETE FROM app_state WHERE key = ?').run(SLEEP_STATE_KEY);
  ingestion.ingest(secondUpdate, secondReceived);
  const [queuedId] = scheduler.processDue(new Date(secondReceived.getTime() + 15_000));
  if (queuedId === undefined) {
    throw new Error('Expected a queued invocation');
  }
  enterSleep(store.orm, new Date(secondReceived.getTime() + 16_000));
  scheduler.start(new Date(secondReceived.getTime() + 16_000));
  await scheduler.stop();
  expect(
    store.db.query<{ state: string }, [bigint]>('SELECT state FROM invocations WHERE id = ?').get(queuedId)?.state,
  ).toBe('skipped_budget');
  store.close();
});

test('sleeping persists across reopening the SQLite store', async () => {
  const { loaded, store } = await openStore('plasticwan-sleep-restart-');
  const expected = enterSleep(store.orm).sleepUntil;
  store.close();
  const reopened = await SqliteStore.open(loaded.config);
  expect(activeSleepUntil(reopened.orm)).toBe(expected);
  reopened.close();
});

test('the next UTC budget period wakes the bot after its minimum sleep', async () => {
  const { loaded, store } = await openStore();
  const slept = enterSleep(store.orm, new Date('2026-08-15T01:00:00.000Z'));
  expect(slept.sleepUntil).toBe('2026-08-16T00:00:00.000Z');
  expect(activeSleepUntil(store.orm, new Date('2026-08-15T23:59:59.999Z'))).toBe(slept.sleepUntil);
  expect(activeSleepUntil(store.orm, new Date('2026-08-16T00:00:00.000Z'))).toBeNull();
  expect(store.db.query('SELECT value FROM app_state WHERE key = ?').get(SLEEP_STATE_KEY)).toBeNull();
  const awakeAt = new Date('2026-08-16T00:00:00.001Z');
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  ingestion.ingest(update, awakeAt);
  expect(scheduler.processDue(new Date(awakeAt.getTime() + 15_000))).toHaveLength(1);
  store.close();
});

test('repeated concurrent sleep requests keep one unchanged state', async () => {
  const { store } = await openStore();
  const now = new Date('2026-08-15T20:00:00.000Z');
  const transitions = await Promise.all(Array.from({ length: 8 }, async () => enterSleep(store.orm, now)));
  expect(transitions.filter((transition) => transition.entered)).toHaveLength(1);
  expect(new Set(transitions.map((transition) => transition.sleepUntil)).size).toBe(1);
  expect(
    store.db
      .query<{ count: bigint }, [string]>('SELECT COUNT(*) AS count FROM app_state WHERE key = ?')
      .get(SLEEP_STATE_KEY)?.count,
  ).toBe(1n);
  store.close();
});

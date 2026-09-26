import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { loadConfig, type AgentSettings, type FileConfig, type RawConfig } from '../src/platform/config.ts';
import { eq } from 'drizzle-orm';
import { buckets, chatMigrations, invocations } from '../src/store/schema.ts';
import { buildModelRegistry } from '../src/platform/providers.ts';
import { RuntimeConfigurationStore, type InvocationConfigSnapshot } from '../src/platform/runtime-config.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { type TestRegistry, sleep, testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const CHAT_A = -100_000_000;
const CHAT_B = -200_000_000;
const CHAT_MIGRATED_FROM = -300_000_000;
const CHAT_MIGRATED_TO = -300_000_001;
const DEFAULT_MODEL = 'agent-model';
const VISION_MODEL = 'agent-model-vision';
const FORUM_TOPIC_ID = 7_000_000n;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

/** One faux provider hosting both the default (text-only) and the vision model. */
function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'agent',
    models: [
      { id: DEFAULT_MODEL, input: ['text'], contextWindow: 128_000, maxTokens: 8_192, reasoning: true },
      { id: VISION_MODEL, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768, reasoning: true },
    ],
  });
}

function textUpdate(chatId: number, updateId: number, messageId: number, text: string, threadId?: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: 'Group', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: Number(threadId), is_topic_message: true }),
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

interface ModelCallRow {
  readonly provider: string;
  readonly model: string;
  readonly state: string;
}

function modelCalls(store: SqliteStore, invocationId: bigint): ModelCallRow[] {
  return store.db
    .prepare<[bigint], ModelCallRow>(
      "SELECT provider, model, state FROM model_calls WHERE invocation_id = ? AND role = 'agent' ORDER BY id",
    )
    .all(invocationId);
}

interface ContextMessageRow {
  readonly context_id: bigint;
  readonly chat_id: bigint;
  readonly seq: bigint;
  readonly role: string;
  readonly payload_json: string;
}

function contextMessagesByChat(store: SqliteStore): ContextMessageRow[] {
  return store.db
    .prepare<[], ContextMessageRow>(
      `SELECT cm.context_id, c.telegram_chat_id AS chat_id, cm.seq, cm.role, cm.payload_json
       FROM context_messages cm
       JOIN conversation_contexts cc ON cc.id = cm.context_id
       JOIN conversations v ON v.id = cc.conversation_id
       JOIN chats c ON c.id = v.chat_id
       ORDER BY cm.context_id, cm.seq`,
    )
    .all();
}

function contextIds(store: SqliteStore): { context_id: bigint; chat_id: bigint }[] {
  return store.db
    .prepare<[], { context_id: bigint; chat_id: bigint }>(
      `SELECT cc.id AS context_id, c.telegram_chat_id AS chat_id
       FROM conversation_contexts cc
       JOIN conversations v ON v.id = cc.conversation_id
       JOIN chats c ON c.id = v.chat_id
       ORDER BY cc.id`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly registry: TestRegistry;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly sends: string[];
  runtimeWith(
    faux: ReturnType<typeof fauxProvider>,
    config?: RawConfig,
  ): { readonly runtime: AgentRuntime; readonly registry: TestRegistry };
}

async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-chat-model-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config: FileConfig) => {
    config.telegram.bucket_window_seconds = 0;
    config.agent.send_nudge_enabled = false;
    config.agent.context.idle_grace_seconds = 0;
    // Add the vision model to the provider definition so validation passes.
    const agentProvider = config.providers.agent;
    if (agentProvider === undefined || agentProvider.kind !== 'custom') {
      throw new Error('fixture needs custom agent provider');
    }
    agentProvider.models.push({
      id: VISION_MODEL,
      name: 'Vision Model',
      reasoning: true,
      compat: { supports_developer_role: false },
      input: ['text', 'image'],
      context_window: 200_000,
      max_tokens: 32_768,
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    });
    // Chat A: overrides provider + model + thinking.
    // Chat B: inherits global defaults.
    // CHAT_MIGRATED_FROM: an entry for a chat that was migrated away.
    config.telegram.chats = [
      {
        id: CHAT_A,
        instructions_file: 'chat-instructions.md',
        provider: 'agent',
        model: VISION_MODEL,
        thinking_level: 'high',
      },
      {
        id: CHAT_B,
        instructions_file: 'chat-instructions.md',
      },
      {
        id: CHAT_MIGRATED_FROM,
        instructions_file: 'chat-instructions.md',
        provider: 'agent',
        model: VISION_MODEL,
        thinking_level: 'high',
      },
    ];
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  // Insert a migration: messages for CHAT_MIGRATED_TO resolve to CHAT_MIGRATED_FROM.
  store.orm
    .insert(chatMigrations)
    .values({
      oldChatId: BigInt(CHAT_MIGRATED_FROM),
      newChatId: BigInt(CHAT_MIGRATED_TO),
      receivedAt: new Date().toISOString(),
    })
    .run();
  const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const sends: string[] = [];
  let messageId = 900;
  const sendApi: TelegramSendApi = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_A } };
    },
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_A } }),
  };
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: loaded.config.agent.context.agent_cache_size,
  });
  return {
    store,
    config: loaded.config,
    configStore,
    registry,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    sends,
    runtimeWith: (faux, config = loaded.config) => {
      const models = createModels();
      models.setProvider(faux.provider);
      const fauxModels: TestRegistry = { models, visionModel: faux.getModel() };
      const runtimeStore = new RuntimeConfigurationStore({ config, hash: 'runtime', ...fauxModels });
      return {
        runtime: new AgentRuntime({
          store,
          configStore: runtimeStore,
          secrets: new SecretStore(),
          telegramApi: sendApi,
          bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
          systemResources: SystemResources.empty(),
          conversationRuntime,
        }),
        registry: fauxModels,
      };
    },
  };
}

function snapshotOf(config: RawConfig, registry: TestRegistry, hash = 'snapshot'): InvocationConfigSnapshot {
  return new RuntimeConfigurationStore({ config, hash, ...registry }).beginInvocation();
}

function withChat(base: RawConfig, chatId: number, patch: Partial<AgentSettings>): RawConfig {
  return {
    ...base,
    telegram: {
      ...base.telegram,
      chats: base.telegram.chats.map((chat) => (chat.id === chatId ? { ...chat, ...patch } : chat)),
    },
  };
}

async function runOnce(
  fixture: Fixture,
  runtime: AgentRuntime,
  snapshot: InvocationConfigSnapshot,
  chatId: number,
  updateId: number,
  messageId: number,
  text: string,
  threadId?: bigint,
): Promise<bigint> {
  fixture.ingestion.ingest(textUpdate(chatId, updateId, messageId, text, threadId), new Date());
  const [invocationId] = fixture.scheduler.processDue(new Date());
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const outcome = await runtime.run(invocationId, snapshot, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  const invocation = fixture.store.orm
    .update(invocations)
    .set({ state: 'completed' })
    .where(eq(invocations.id, invocationId))
    .returning({ bucketId: invocations.bucketId })
    .get();
  if (invocation !== undefined) {
    fixture.store.orm.update(buckets).set({ state: 'completed' }).where(eq(buckets.id, invocation.bucketId)).run();
  }
  return invocationId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat model routing', () => {
  test('Chat A override picks vision model + high thinking; Chat B falls back to global defaults', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('reply A');
      },
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('reply B');
      },
    ]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      const invA = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'hello A');
      const invB = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_B, 2, 20, 'hello B');

      const [callA] = modelCalls(fixture.store, invA);
      const [callB] = modelCalls(fixture.store, invB);
      expect(callA?.provider).toBe('agent');
      expect(callA?.model).toBe(VISION_MODEL);
      expect(callA?.state).toBe('success');
      expect(callB?.provider).toBe('agent');
      expect(callB?.model).toBe(DEFAULT_MODEL);
      expect(callB?.state).toBe('success');
      expect(levels).toEqual(['high', 'low']);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('switching a Chat across providers routes to the new provider and preserves an unchanged Context', async () => {
    const fixture = await setup();
    const original = fauxAgent();
    const other = fauxProvider({
      provider: 'vision',
      models: [{ id: 'vision-model', input: ['text', 'image'], reasoning: false }],
    });
    const calls: string[] = [];
    original.setResponses([
      (_context, options) => {
        calls.push(`agent:${options?.reasoning}`);
        return fauxAssistantMessage('original answer');
      },
    ]);
    other.setResponses([
      () => {
        calls.push('vision');
        return fauxAssistantMessage('other answer');
      },
    ]);
    const models = createModels();
    models.setProvider(original.provider);
    models.setProvider(other.provider);
    const registry = { models, visionModel: other.getModel() };
    const { runtime } = fixture.runtimeWith(original);
    try {
      const first = await runOnce(
        fixture,
        runtime,
        snapshotOf(fixture.config, registry),
        CHAT_A,
        1,
        10,
        'before switch',
      );
      const contexts = contextIds(fixture.store);
      const switched = withChat(fixture.config, CHAT_A, {
        provider: 'vision',
        model: 'vision-model',
        thinking_level: 'off',
      });
      const second = await runOnce(
        fixture,
        runtime,
        snapshotOf(switched, registry, 'second'),
        CHAT_A,
        2,
        11,
        'after switch',
      );
      expect(calls).toEqual(['agent:high', 'vision']);
      expect(modelCalls(fixture.store, first)).toEqual([{ provider: 'agent', model: VISION_MODEL, state: 'success' }]);
      expect(modelCalls(fixture.store, second)).toEqual([
        { provider: 'vision', model: 'vision-model', state: 'success' },
      ]);
      expect(contextIds(fixture.store)).toEqual(contexts);
      expect(contextMessagesByChat(fixture.store).some((row) => row.payload_json.includes('original answer'))).toBe(
        true,
      );
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('context messages are isolated per conversation (different chats do not cross-contaminate)', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('A'), () => fauxAssistantMessage('B')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'A msg');
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_B, 2, 20, 'B msg');

      const ctxIds = contextIds(fixture.store);
      expect(ctxIds.length).toBe(2);
      const rows = contextMessagesByChat(fixture.store);
      const aRows = rows.filter((r) => r.chat_id === BigInt(CHAT_A));
      const bRows = rows.filter((r) => r.chat_id === BigInt(CHAT_B));
      expect(aRows.length).toBeGreaterThan(0);
      expect(bRows.length).toBeGreaterThan(0);
      // No cross-contamination.
      expect(aRows.some((r) => r.payload_json.includes('B msg'))).toBe(false);
      expect(bRows.some((r) => r.payload_json.includes('A msg'))).toBe(false);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('thinking-level-only override re-binds the cached agent', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_ctx, opts) => {
        levels.push(opts?.reasoning);
        return fauxAssistantMessage('first');
      },
    ]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      // Chat B inherits its model; only thinking is overridden.
      const highCfg = withChat(fixture.config, CHAT_B, { thinking_level: 'high' });
      await runOnce(fixture, runtime, snapshotOf(highCfg, registry), CHAT_B, 1, 10, 'first');

      faux.setResponses([
        (_ctx, opts) => {
          levels.push(opts?.reasoning);
          return fauxAssistantMessage('second');
        },
      ]);
      const lowCfg = withChat(fixture.config, CHAT_B, { thinking_level: 'low' });
      await runOnce(fixture, runtime, snapshotOf(lowCfg, registry, 'second'), CHAT_B, 2, 11, 'second');

      expect(levels).toEqual(['high', 'low']);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('a queued invocation uses the snapshot current at queued-to-running transition', async () => {
    const fixture = await setup();
    const usedConfigs: string[] = [];
    const scheduler = new BucketScheduler(fixture.store, fixture.configStore, async (_invocationId, snapshot) => {
      usedConfigs.push(snapshot.config.telegram.chats.find((c) => BigInt(c.id) === BigInt(CHAT_A))?.model ?? 'none');
      return { state: 'completed', reason: 'done' };
    });
    try {
      // Ingest under the initial config (VISION_MODEL for Chat A).
      fixture.ingestion.ingest(textUpdate(CHAT_A, 1, 10, 'msg'), new Date());
      const [invocationId] = scheduler.processDue(new Date());
      expect(invocationId).toBeDefined();
      expect(
        fixture.store.db
          .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
          .get(invocationId!)?.state,
      ).toBe('queued');

      // Publish a snapshot that changes Chat A to DEFAULT_MODEL.
      fixture.configStore.publish({
        config: withChat(fixture.config, CHAT_A, { model: DEFAULT_MODEL }),
        hash: 'second',
        ...fixture.registry,
      });

      scheduler.start();
      await waitForInvocation(() => usedConfigs.length > 0);
      // The invocation picked up the SECOND snapshot (current at launch).
      expect(usedConfigs[0]).toBe(DEFAULT_MODEL);
    } finally {
      await scheduler.stop();
      fixture.store.close();
    }
  }, 30_000);

  test('old snapshot persists across sequential invocations; next gets new values', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first'), () => fauxAssistantMessage('second')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      // First invocation: Chat A with vision model (override).
      const invA = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'first');

      // Second invocation: same chat, switched config (DEFAULT_MODEL + low).
      const switched = withChat(fixture.config, CHAT_A, { model: DEFAULT_MODEL, thinking_level: 'low' });
      const invB = await runOnce(fixture, runtime, snapshotOf(switched, registry, 'second'), CHAT_A, 2, 11, 'second');

      const [callA] = modelCalls(fixture.store, invA);
      const [callB] = modelCalls(fixture.store, invB);
      expect(callA?.model).toBe(VISION_MODEL);
      expect(callB?.model).toBe(DEFAULT_MODEL);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('forum topics in the same chat share the chat-level model override', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('topic 1'), () => fauxAssistantMessage('topic 2')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      const invMain = await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'main');
      const invTopic = await runOnce(
        fixture,
        runtime,
        snapshotOf(fixture.config, registry),
        CHAT_A,
        2,
        20,
        'topic msg',
        FORUM_TOPIC_ID,
      );

      const [callMain] = modelCalls(fixture.store, invMain);
      const [callTopic] = modelCalls(fixture.store, invTopic);
      expect(callMain?.model).toBe(VISION_MODEL);
      expect(callTopic?.model).toBe(VISION_MODEL);
      expect(callMain?.provider).toBe('agent');
      expect(callTopic?.provider).toBe('agent');
      expect(
        fixture.store.db
          .prepare<[], { message_thread_id: bigint }>(
            'SELECT message_thread_id FROM conversations ORDER BY message_thread_id',
          )
          .all()
          .map((row) => row.message_thread_id),
      ).toEqual([0n, FORUM_TOPIC_ID]);
      expect(contextIds(fixture.store)).toHaveLength(2);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('chat migration resolves old chat config for the new chat id', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('migrated')]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      const inv = await runOnce(
        fixture,
        runtime,
        snapshotOf(fixture.config, registry),
        CHAT_MIGRATED_TO,
        1,
        10,
        'hello',
      );

      const [call] = modelCalls(fixture.store, inv);
      expect(call?.provider).toBe('agent');
      expect(call?.model).toBe(VISION_MODEL);
      expect(call?.state).toBe('success');
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('a directly configured migrated Chat takes precedence over the old Chat override', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('direct configuration');
      },
    ]);
    const direct: RawConfig = {
      ...fixture.config,
      telegram: {
        ...fixture.config.telegram,
        chats: [...fixture.config.telegram.chats, { id: CHAT_MIGRATED_TO, instructions: '' }],
      },
    };
    fixture.configStore.publish({ config: direct, hash: 'direct', ...fixture.registry });
    const { runtime, registry } = fixture.runtimeWith(faux, direct);
    try {
      const invocation = await runOnce(
        fixture,
        runtime,
        snapshotOf(direct, registry),
        CHAT_MIGRATED_TO,
        1,
        10,
        'hello direct',
      );
      expect(modelCalls(fixture.store, invocation)).toEqual([
        { provider: 'agent', model: DEFAULT_MODEL, state: 'success' },
      ]);
      expect(levels).toEqual(['low']);
      expect(contextMessagesByChat(fixture.store).every((row) => row.chat_id === BigInt(CHAT_MIGRATED_TO))).toBe(true);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('vision model enables image capability prompt; text-only model does not', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('vision');
      },
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('text');
      },
    ]);
    const { runtime, registry } = fixture.runtimeWith(faux);
    try {
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_A, 1, 10, 'hello V');
      await runOnce(fixture, runtime, snapshotOf(fixture.config, registry), CHAT_B, 2, 20, 'hello T');

      expect(prompts[0]).toContain('attached directly to the multimodal Agent input');
      expect(prompts[1]).not.toContain('attached directly to the multimodal Agent input');
      expect(prompts[1]).toContain('available through the read_image capability');
    } finally {
      fixture.store.close();
    }
  }, 30_000);
});

async function waitForInvocation(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error('Timed out waiting for invocation');
}

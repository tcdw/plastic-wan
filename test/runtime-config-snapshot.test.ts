import { afterAll, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig, type FileConfig, type RawConfig } from '../src/platform/config.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import type { ModelRegistry } from '../src/platform/providers.ts';
import { RuntimeConfigurationStore, type InvocationConfigSnapshot } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { sleep, testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const CHAT_ID = 123456789;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768, reasoning: true }],
  });
}

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly sends: string[];
  runtimeWith(faux: ReturnType<typeof fauxProvider>, config?: RawConfig): { readonly runtime: AgentRuntime };
}

async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-config-snapshot-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config: FileConfig) => {
    // Zero-second windows let a test open each invocation by hand; the nudge
    // would otherwise inject turns that are irrelevant to these assertions.
    config.telegram.bucket_window_seconds = 0;
    config.agent.send_nudge_enabled = false;
    config.agent.context.idle_grace_seconds = 0;
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const configStore = new RuntimeConfigurationStore(loaded);
  const sends: string[] = [];
  let messageId = 900;
  const sendApi: TelegramSendApi = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_ID } }),
  };
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: loaded.config.agent.context.agent_cache_size,
  });
  return {
    store,
    config: loaded.config,
    configStore,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    sends,
    runtimeWith: (faux, config = loaded.config) => {
      const models = createModels();
      models.setProvider(faux.provider);
      const registry: ModelRegistry = { models, visionModel: faux.getModel() };
      const runtimeStore = new RuntimeConfigurationStore({ config, hash: 'runtime' });
      return {
        runtime: new AgentRuntime({
          store,
          configStore: runtimeStore,
          secrets: new SecretStore(),
          registry,
          telegramApi: sendApi,
          bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
          systemResources: SystemResources.empty(),
          conversationRuntime,
        }),
      };
    },
  };
}

function snapshotOf(config: RawConfig, hash = 'snapshot'): InvocationConfigSnapshot {
  return new RuntimeConfigurationStore({ config, hash }).beginInvocation();
}

function withAgent(
  base: RawConfig,
  patch: {
    readonly systemPrompt?: string;
    readonly thinkingLevel?: RawConfig['agent']['thinking_level'];
    readonly sendMaxTextLength?: number;
  },
): RawConfig {
  return {
    ...base,
    agent: {
      ...base.agent,
      ...(patch.systemPrompt === undefined ? {} : { system_prompt: patch.systemPrompt }),
      ...(patch.thinkingLevel === undefined ? {} : { thinking_level: patch.thinkingLevel }),
      ...(patch.sendMaxTextLength === undefined ? {} : { send_max_text_length: patch.sendMaxTextLength }),
    },
  };
}

/** Ingests one message, opens its invocation and runs it under `snapshot`. */
async function runOnce(
  fixture: Fixture,
  runtime: AgentRuntime,
  snapshot: InvocationConfigSnapshot,
  updateId: number,
  messageId: number,
  text: string,
): Promise<bigint> {
  fixture.ingestion.ingest(textUpdate(updateId, messageId, text), new Date());
  const [invocationId] = fixture.scheduler.processDue(new Date());
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const outcome = await runtime.run(invocationId, snapshot, new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  fixture.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  fixture.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  return invocationId;
}

function contextRows(
  store: SqliteStore,
): { readonly seq: bigint; readonly role: string; readonly payload_json: string }[] {
  return store.db
    .prepare<[], { seq: bigint; role: string; payload_json: string }>(
      'SELECT seq, role, payload_json FROM context_messages ORDER BY seq',
    )
    .all();
}

/** Assistant turns are never re-rendered from history, so they mark one run's context. */
function assistantTranscript(rows: readonly { readonly role: string; readonly payload_json: string }[]): string {
  return rows
    .filter((row) => row.role === 'assistant')
    .map((row) => row.payload_json)
    .join('\n');
}

function contextHash(store: SqliteStore): string | undefined {
  return store.db
    .prepare<[], { system_prompt_hash: string }>('SELECT system_prompt_hash FROM conversation_contexts')
    .get()?.system_prompt_hash;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

describe('configuration snapshots', () => {
  test('a reused cached agent is re-bound to the snapshot thinking level', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('first answer');
      },
    ]);
    const { runtime } = fixture.runtimeWith(faux);
    try {
      await runOnce(fixture, runtime, snapshotOf(withAgent(fixture.config, { thinkingLevel: 'low' })), 1, 10, 'first');
      faux.setResponses([
        (_context, options) => {
          levels.push(options?.reasoning);
          return fauxAssistantMessage('second answer');
        },
      ]);
      // Only the thinking level differs: the cached agent must still take it.
      await runOnce(
        fixture,
        runtime,
        snapshotOf(withAgent(fixture.config, { thinkingLevel: 'high' }), 'second'),
        2,
        11,
        'second',
      );
      expect(levels).toEqual(['low', 'high']);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('each run applies the send limit of its own snapshot', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    const text = 'x'.repeat(20);
    const sendCall = (): ReturnType<typeof fauxAssistantMessage> =>
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text }), { stopReason: 'toolUse' });
    faux.setResponses([sendCall, () => fauxAssistantMessage('done')]);
    const { runtime } = fixture.runtimeWith(faux);
    try {
      const first = await runOnce(
        fixture,
        runtime,
        snapshotOf(withAgent(fixture.config, { sendMaxTextLength: 10 })),
        1,
        10,
        'first',
      );
      expect(
        fixture.store.db
          .prepare<[bigint], { error_code: string | null }>(
            "SELECT error_code FROM tool_calls WHERE invocation_id = ? AND tool_name = 'send'",
          )
          .all(first)
          .map((row) => row.error_code),
      ).toEqual(['send_text_too_long']);
      expect(
        fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count,
      ).toBe(0n);

      faux.setResponses([sendCall, () => fauxAssistantMessage('done')]);
      const second = await runOnce(
        fixture,
        runtime,
        snapshotOf(withAgent(fixture.config, { sendMaxTextLength: 100 }), 'second'),
        2,
        11,
        'second',
      );
      expect(
        fixture.store.db
          .prepare<[bigint], { state: string }>(
            "SELECT state FROM tool_calls WHERE invocation_id = ? AND tool_name = 'send'",
          )
          .all(second)
          .map((row) => row.state),
      ).toEqual(['success']);
      expect(fixture.sends).toEqual([text]);
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('a snapshot with a different system prompt rebuilds the Conversation Context', async () => {
    const fixture = await setup();
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first answer')]);
    const { runtime } = fixture.runtimeWith(faux);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      await runOnce(fixture, runtime, snapshotOf(fixture.config), 1, 10, 'first');
      const before = contextRows(fixture.store);
      expect(before.length).toBeGreaterThan(0);
      expect(assistantTranscript(before)).toContain('first answer');
      const hashBefore = contextHash(fixture.store);
      logs.length = 0;

      faux.setResponses([() => fauxAssistantMessage('second answer')]);
      await runOnce(
        fixture,
        runtime,
        snapshotOf(withAgent(fixture.config, { systemPrompt: 'A completely different system prompt.' }), 'second'),
        2,
        11,
        'second',
      );
      const after = contextRows(fixture.store);
      // The rebuild drops everything written under the old prompt and restarts
      // the sequence at 1, so the first run's assistant turn is gone while the
      // second run's own turn is there.
      expect(assistantTranscript(after)).not.toContain('first answer');
      expect(assistantTranscript(after)).toContain('second answer');
      expect(Math.min(...after.map((row) => Number(row.seq)))).toBe(1);
      expect(contextHash(fixture.store)).not.toBe(hashBefore);
      expect(logs.some((line) => line.includes('"event":"context_rebuilt"'))).toBe(true);
    } finally {
      spy.mockRestore();
      fixture.store.close();
    }
  }, 30_000);

  test('validateAdditionalTools validates against the model it is given', async () => {
    const fixture = await setup();
    const faux = fauxProvider({
      provider: 'agent',
      models: [
        { id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 },
        { id: 'small-model', input: ['text'], contextWindow: 1_000, maxTokens: 512 },
      ],
    });
    const { runtime } = fixture.runtimeWith(faux);
    const large = faux.getModel('agent-model');
    const small = faux.getModel('small-model');
    if (large === undefined || small === undefined) {
      throw new Error('Expected both faux models to be registered');
    }
    try {
      expect(() => runtime.validateAdditionalTools(previewContext(), [], large)).not.toThrow();
      expect(() => runtime.validateAdditionalTools(previewContext(), [], small)).toThrow(
        /10% of the model context window/,
      );
    } finally {
      fixture.store.close();
    }
  }, 30_000);

  test('the scheduler hands the invocation the configuration current at queued to running', async () => {
    const fixture = await setup();
    const first = fixture.configStore.current();
    const second = snapshotOf(withAgent(fixture.config, { systemPrompt: 'A later published prompt.' }), 'second');
    const seen: InvocationConfigSnapshot[] = [];
    // Phase 0 cannot publish a new configuration yet, so the store stands in for
    // the publication point.
    let published = first;
    fixture.configStore.current = () => published;
    fixture.configStore.beginInvocation = () => published;
    const scheduler = new BucketScheduler(fixture.store, fixture.configStore, async (_invocationId, snapshot) => {
      seen.push(snapshot);
      return { state: 'completed', reason: 'done' };
    });
    try {
      // The loop runs `processDue` and the launch in the same tick, so queue the
      // invocation by hand before the loop starts: it is created under `first`
      // and has to sit in `queued` while the publication happens.
      fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
      const [invocationId] = scheduler.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected a due invocation');
      }
      expect(
        fixture.store.db
          .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
          .get(invocationId)?.state,
      ).toBe('queued');

      published = second;
      scheduler.start();
      await waitFor(() => seen.length === 1);
      // Neither the construction of the scheduler nor the queueing of the
      // invocation fixes its configuration; only the move to `running` does.
      expect(seen[0]).toBe(second);
      expect(seen[0]?.config.agent.system_prompt).toBe('A later published prompt.');
    } finally {
      await scheduler.stop();
      fixture.store.close();
    }
  }, 30_000);
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { loadConfig, type FileConfig, type RawConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { InvocationQueueService } from '../src/orchestration/invocation-queue.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import type { ModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const CHAT_ID = 123456789;
const SEND_MESSAGE_ID = 900;

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly fileConfig: FileConfig;
  readonly conversationRuntime: ConversationRuntime;
  readonly ingestion: TelegramIngestion;
  readonly sendApi: TelegramSendApi;
  /** Builds a runtime over a fresh faux provider, mirroring the composition root. */
  runtimeWith(faux: ReturnType<typeof fauxProvider>, overrides?: { readonly systemPrompt?: string }): AgentRuntime;
}

async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-hot-inject-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    // Zero-second windows keep the scheduler deterministic: a bucket is due the
    // moment its message lands, and the idle grace is the only thing that keeps
    // a run alive afterwards.
    config.telegram.bucket_window_seconds = 0;
    config.agent.send_nudge_enabled = false;
    config.agent.context.idle_grace_seconds = 2;
    config.agent.context.max_wall_clock_seconds = 60;
    transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const sendApi: TelegramSendApi = {
    sendMessage: async () => ({ message_id: SEND_MESSAGE_ID, date: 1_700_000_100, chat: { id: CHAT_ID } }),
    sendSticker: async () => ({ message_id: SEND_MESSAGE_ID + 1, date: 1_700_000_100, chat: { id: CHAT_ID } }),
  };
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: loaded.config.agent.context.agent_cache_size,
  });
  return {
    store,
    config: loaded.config,
    fileConfig: loaded.fileConfig,
    conversationRuntime,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999 }),
    sendApi,
    runtimeWith: (faux, overrides = {}) => {
      const models = createModels();
      models.setProvider(faux.provider);
      const model = faux.getModel();
      const registry: ModelRegistry = { models, agentModel: model, visionModel: model };
      const config: RawConfig =
        overrides.systemPrompt === undefined
          ? loaded.config
          : { ...loaded.config, agent: { ...loaded.config.agent, system_prompt: overrides.systemPrompt } };
      return new AgentRuntime({
        store,
        config,
        secrets: new SecretStore(),
        registry,
        modelSwitcher: new AgentModelSwitcher(config, registry.models),
        telegramApi: sendApi,
        bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
        systemResources: SystemResources.empty(),
        conversationRuntime,
      });
    },
  };
}

function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
}

function update(updateId: number, messageId: number, text: string, threadId?: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
      date: 1_700_000_000 + messageId,
      chat:
        threadId === undefined
          ? { id: CHAT_ID, type: 'private', first_name: 'Owner' }
          : { id: CHAT_ID, type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

/** Polls until the condition holds, so timing-sensitive steps fail loudly. */
async function until(condition: () => boolean, label: string, timeoutMilliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('long-lived invocation', () => {
  test('a message sent while the run is active still waits its own bucket window', async () => {
    // Regression: the ingestion pace rule used to treat any message arriving
    // while an invocation was active as immediately due. That was harmless while
    // a due bucket could not be consumed before the run ended, but a long-lived
    // invocation consumes due buckets on the spot — so once a run outlived one
    // window, every single message became its own zero-length bucket and its own
    // injection (observed in production: six messages sent inside 1.4 s produced
    // six separate injections).
    //
    // This covers the message that arrives after the round ended: the agent is
    // already free, so its window runs from the message itself. A message that
    // arrives *during* a round is covered by the round-end test below.
    const fixtureSetup = await fixture((config) => {
      config.telegram.bucket_window_seconds = 1;
      // Must stay >= the bucket window, else check-config rejects the pairing.
      config.agent.context.idle_grace_seconds = 3;
    });
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('first answer');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => runtime.run(invocationId, signal),
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      scheduler.wake();
      await until(() => requests.length === 1, 'the first model call');

      // Sent while the run is active: it must still collect a full window of its
      // own before it is injected, however long the run has been going.
      const secondIngestAt = Date.now();
      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      scheduler.wake();
      await Bun.sleep(150);

      const bucket = fixtureSetup.store.db
        .query<{ id: bigint; state: string; first_received_at: string; deadline_at: string }, []>(
          'SELECT id, state, first_received_at, deadline_at FROM buckets ORDER BY id DESC LIMIT 1',
        )
        .get();
      if (bucket === null) {
        throw new Error('Expected a second bucket');
      }
      // The bucket is still collecting its own window instead of being injected a
      // few milliseconds after it was created.
      expect(bucket.state).toBe('collecting');
      const windowMilliseconds = Date.parse(bucket.deadline_at) - Date.parse(bucket.first_received_at);
      expect(windowMilliseconds).toBeGreaterThanOrEqual(1_000);
      expect(
        fixtureSetup.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
          ?.count,
      ).toBe(1n);

      // It is injected once its own window closes, into the same invocation.
      await until(() => requests.length === 2, 'the second batch');
      const attachments = fixtureSetup.store.db
        .query<{ invocation_id: bigint; bucket_id: bigint; injected_at: string | null }, []>(
          'SELECT invocation_id, bucket_id, injected_at FROM invocation_buckets ORDER BY bucket_id',
        )
        .all();
      expect(attachments).toHaveLength(2);
      expect(attachments[0]?.invocation_id).toBe(attachments[1]?.invocation_id);
      const injectedAt = Date.parse(attachments[1]?.injected_at ?? '');
      expect(injectedAt - secondIngestAt).toBeGreaterThanOrEqual(950);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('keeps a batch collecting while the round runs instead of attaching it mid-round', async () => {
    const fixtureSetup = await fixture();
    const faux = fauxAgent();
    const requests: string[] = [];
    // A batch whose window closes while the model is still working on its round
    // must keep collecting: the agent is not free, so the batch's window has not
    // started yet. Handing it over mid-round would inject a batch that collected
    // almost nothing (and is exactly what the round-end anchor prevents).
    let collectingDuringRound = 0n;
    let attachedDuringRound = 0n;
    faux.setResponses([
      async (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        fixtureSetup.ingestion.ingest(update(2, 11, 'second message'), new Date());
        scheduler.wake();
        await Bun.sleep(200);
        collectingDuringRound =
          fixtureSetup.store.db
            .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM buckets WHERE state = 'collecting'")
            .get()?.count ?? 0n;
        attachedDuringRound =
          fixtureSetup.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
            ?.count ?? 0n;
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
      (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const started: bigint[] = [];
    let finished!: () => void;
    const finishedSignal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => {
        started.push(invocationId);
        const outcome = await runtime.run(invocationId, signal);
        finished();
        return outcome;
      },
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await finishedSignal;
      // Let the scheduler's terminal-state transaction land before asserting.
      await Bun.sleep(50);

      // The batch stayed out of the run for the whole round, then joined it once
      // the agent was free again: exactly one invocation, one batch per round.
      expect(collectingDuringRound).toBe(1n);
      expect(attachedDuringRound).toBe(1n);
      expect(started).toHaveLength(1);
      expect(requests).toHaveLength(3);
      expect(requests[1]).not.toContain('second message');
      expect(requests[2]).toContain('second message');
      const attached2 = fixtureSetup.store.db
        .query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocation_buckets')
        .get();
      expect(attached2?.count).toBe(2n);
      expect(fixtureSetup.store.db.query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id').all()).toEqual(
        [{ state: 'completed' }, { state: 'completed' }],
      );
      const head = fixtureSetup.store.db
        .query<{ is_checkpoint: bigint; role: string }, []>(
          'SELECT is_checkpoint, role FROM context_messages ORDER BY seq',
        )
        .all()
        .filter((row) => row.is_checkpoint === 1n);
      // One checkpoint per injected batch, always on the batch's user message.
      expect(head).toEqual([
        { is_checkpoint: 1n, role: 'user' },
        { is_checkpoint: 1n, role: 'user' },
      ]);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a batch that collects during a round is injected one window after that round ends', async () => {
    // The collection window is anchored at the moment the agent becomes free
    // again, not at the batch's own first message: messages arriving while a round
    // runs are gathered into one batch whose window starts at the round end, so a
    // quick reply never cuts the conversation into two batches.
    const fixtureSetup = await fixture((config) => {
      config.telegram.bucket_window_seconds = 1;
      config.agent.context.idle_grace_seconds = 3;
    });
    const faux = fauxAgent();
    let roundEnd = 0;
    let injectedAt = 0;
    let collectingDuringRound = '';
    faux.setResponses([
      async (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        fixtureSetup.ingestion.ingest(update(2, 11, 'second message'), new Date());
        scheduler.wake();
        // The round outlives the batch's own window, so a batch handed over on
        // its own deadline would be injected while the model is still working.
        await Bun.sleep(1_500);
        collectingDuringRound =
          fixtureSetup.store.db.query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()
            ?.state ?? '';
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        // A turn without tool calls ends the round: the agent is free from this
        // instant, which is where the pending batch's window starts.
        roundEnd = Date.now();
        return fauxAssistantMessage('');
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    let finished!: () => void;
    const finishedSignal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => {
        const poll = setInterval(recordInjection, 25);
        try {
          const outcome = await runtime.run(invocationId, signal);
          finished();
          return outcome;
        } finally {
          clearInterval(poll);
        }
      },
      fixtureSetup.conversationRuntime,
    );
    function recordInjection(): void {
      const row = fixtureSetup.store.db
        .query<{ injected_at: string | null }, []>(
          'SELECT injected_at FROM invocation_buckets ORDER BY bucket_id DESC LIMIT 1',
        )
        .get();
      if (row?.injected_at !== null && row?.injected_at !== undefined) {
        injectedAt = Date.parse(row.injected_at);
      }
    }
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await finishedSignal;
      await Bun.sleep(50);

      // The window restarted at the round end, so the batch waited out a full
      // window from there: without the round-end anchor it would have been
      // injected on its own deadline, which fell mid-round.
      expect(roundEnd).toBeGreaterThan(0);
      expect(collectingDuringRound).toBe('collecting');
      expect(injectedAt).toBeGreaterThan(0);
      expect(injectedAt - roundEnd).toBeGreaterThanOrEqual(900);
      expect(
        fixtureSetup.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocations').get()?.count,
      ).toBe(1n);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('does not pay the idle grace between the steps of one round', async () => {
    // Regression: the grace used to be awaited after *every* turn, so a round
    // that called send twice waited out the grace twice (and a batch injected
    // while the model was working waited before being answered). The grace
    // belongs to the end of a round, where the run would otherwise stop.
    const fixtureSetup = await fixture((config) => {
      config.agent.context.idle_grace_seconds = 3;
    });
    const faux = fauxAgent();
    const callTimes: number[] = [];
    faux.setResponses([
      () => {
        callTimes.push(Date.now());
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first' }), { stopReason: 'toolUse' });
      },
      () => {
        callTimes.push(Date.now());
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'second' }), { stopReason: 'toolUse' });
      },
      () => {
        callTimes.push(Date.now());
        return fauxAssistantMessage('');
      },
      () => fauxAssistantMessage(''),
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => runtime.run(invocationId, signal),
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await until(() => callTimes.length === 3, 'the third model call');
      // Step two followed step one immediately: nothing was pending, so there was
      // nothing to wait for.
      expect((callTimes[1] ?? 0) - (callTimes[0] ?? 0)).toBeLessThan(1_500);
      expect((callTimes[2] ?? 0) - (callTimes[1] ?? 0)).toBeLessThan(1_500);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('a pause interrupts a run that is waiting for the next bucket', async () => {
    const fixtureSetup = await fixture();
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('idle answer');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const started: bigint[] = [];
    let finished!: () => void;
    const finishedSignal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => {
        started.push(invocationId);
        const outcome = await runtime.run(invocationId, signal);
        finished();
        return outcome;
      },
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await until(() => requests.length === 1, 'the first model call');
      // The run now sits in its idle grace (2 s). Aborting must end it right
      // away; if it did not, this test would time out waiting for the grace.
      const chatId = fixtureSetup.store.db
        .query<{ chat_id: bigint }, []>('SELECT chat_id FROM conversations LIMIT 1')
        .get()?.chat_id;
      if (chatId === undefined) {
        throw new Error('Expected a chat');
      }
      const abortedAt = Date.now();
      scheduler.pauseChat(chatId);
      await finishedSignal;
      expect(Date.now() - abortedAt).toBeLessThan(1_500);
      expect(started).toHaveLength(1);
      expect(requests).toHaveLength(1);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('idle_grace_seconds = 0 keeps one bucket per invocation but the context persists', async () => {
    const fixtureSetup = await fixture((config) => {
      config.agent.context.idle_grace_seconds = 0;
    });
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('first answer');
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const started: bigint[] = [];
    let secondFinished!: () => void;
    const secondFinishedSignal = new Promise<void>((resolve) => {
      secondFinished = resolve;
    });
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => {
        started.push(invocationId);
        const outcome = await runtime.run(invocationId, signal);
        if (started.length === 2) {
          secondFinished();
        }
        return outcome;
      },
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      scheduler.wake();
      await until(() => started.length === 1 && requests.length === 1, 'the first invocation');
      await Bun.sleep(50);
      fixtureSetup.ingestion.ingest(update(2, 11, 'next'), new Date());
      scheduler.wake();
      await secondFinishedSignal;

      // Turning long-lived invocations off changes the attach behaviour only:
      // each bucket still opens its own run, and each attaches exactly one.
      expect(started).toHaveLength(2);
      for (const invocationId of started) {
        const attached = fixtureSetup.store.db
          .query<{ count: bigint }, [bigint]>(
            'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ?',
          )
          .get(invocationId);
        expect(attached?.count).toBe(1n);
      }
      // ...but the transcript is still continuous across the two runs.
      expect(requests[1]).toContain('first answer');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('nudges the batch that was drafted as private text before injecting the next one', async () => {
    // Regression: with a live idle grace the reminder used to sit behind the
    // inject and wait paths, so a batch whose draft was never sent got swallowed
    // as soon as another bucket arrived inside the grace — the model kept its
    // reply private and the chat saw nothing.
    const fixtureSetup = await fixture((config) => {
      config.agent.send_nudge_enabled = true;
    });
    const faux = fauxAgent();
    const requests: string[] = [];
    const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const content = lastUser?.content;
      if (!Array.isArray(content)) {
        return typeof content === 'string' ? content : '';
      }
      return content
        .filter((block: { type: string; text?: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text ?? '')
        .join('');
    };
    faux.setResponses([
      (context) => {
        requests.push(lastUserText(context));
        // The first batch is answered as private assistant text, never sent.
        return fauxAssistantMessage('draft for the first batch');
      },
      (context) => {
        requests.push(lastUserText(context));
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'published first batch' }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        requests.push(lastUserText(context));
        return fauxAssistantMessage('');
      },
      (context) => {
        requests.push(lastUserText(context));
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async (invocationId, signal) => runtime.run(invocationId, signal),
      fixtureSetup.conversationRuntime,
    );
    try {
      scheduler.start();
      fixtureSetup.ingestion.ingest(update(1, 10, 'first message'), new Date());
      scheduler.wake();
      await until(() => requests.length >= 1, 'the first model call');
      // A second bucket lands inside the grace. It must not cost the first batch
      // its reply: the reminder has to be raised before this batch is injected.
      fixtureSetup.ingestion.ingest(update(2, 11, 'second message'), new Date());
      scheduler.wake();
      await until(() => requests.some((request) => request.includes('second message')), 'the second batch');
      await Bun.sleep(50);

      expect(requests[0]).toContain('first message');
      expect(requests[1]).toContain('call the send tool');
      expect(
        fixtureSetup.store.db
          .query<{ text: string }, []>('SELECT text FROM agent_messages')
          .all()
          .map((row) => row.text),
      ).toContain('draft for the first batch');
      const published = fixtureSetup.store.db
        .query<{ arguments_json: string }, []>("SELECT arguments_json FROM tool_calls WHERE tool_name = 'send'")
        .all();
      expect(published).toHaveLength(1);
      expect(published[0]?.arguments_json).toContain('published first batch');
      // The reminder precedes the newer batch, so the model is told about the
      // unpublished draft while its own batch is still the newest one.
      const seqs = fixtureSetup.store.db
        .query<{ seq: bigint; payload_json: string }, []>('SELECT seq, payload_json FROM context_messages ORDER BY seq')
        .all();
      const nudgeSeq = seqs.find((row) => row.payload_json.includes('call the send tool'))?.seq;
      const secondBatchSeq = seqs.find((row) => row.payload_json.includes('second message'))?.seq;
      expect(nudgeSeq).toBeDefined();
      expect(secondBatchSeq).toBeDefined();
      expect(nudgeSeq! < secondBatchSeq!).toBe(true);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('another forum topic of the same chat never attaches to the running invocation', async () => {
    const fixtureSetup = await fixture();
    try {
      // The first conversation opens an invocation; a bucket that becomes due in
      // another topic of the same chat must wait for the chat to go idle instead
      // of being injected into a context it does not belong to.
      fixtureSetup.ingestion.ingest(update(1, 10, 'main thread'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.config, 'hash', {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: () => {
          throw new Error('A bucket must never be injected into another conversation');
        },
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);

      fixtureSetup.ingestion.ingest(update(2, 11, 'topic', 100), new Date());
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(
        fixtureSetup.store.db
          .query<{ count: bigint }, [bigint]>(
            'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ?',
          )
          .get(invocationId)?.count,
      ).toBe(1n);
      expect(
        fixtureSetup.store.db
          .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM buckets WHERE state = 'collecting'")
          .get()?.count,
      ).toBe(1n);
    } finally {
      fixtureSetup.store.close();
    }
  });

  test('re-queues a bucket that was attached but never injected', async () => {
    const fixtureSetup = await fixture();
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.config, 'hash', {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: () => undefined,
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);
      fixtureSetup.ingestion.ingest(update(2, 11, 'attached later'), new Date());
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(
        fixtureSetup.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
          ?.count,
      ).toBe(2n);

      // The run ended before injecting the batch: it becomes its own invocation
      // instead of being dropped, and the invocation that owned it keeps its
      // opening bucket as the only member.
      service.releaseUninjectedBuckets(invocationId, new Date());
      expect(
        fixtureSetup.store.db
          .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM invocations WHERE state = 'queued'")
          .get()?.count,
      ).toBe(1n);
      expect(fixtureSetup.store.db.query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id').all()).toEqual(
        [{ state: 'running' }, { state: 'queued' }],
      );
    } finally {
      fixtureSetup.store.close();
    }
  });

  test('does not attach to a run that is already closing', async () => {
    const fixtureSetup = await fixture();
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const injected: bigint[] = [];
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.config, 'hash', {
        isClosing: () => true,
        isRoundInProgress: () => false,
        queueInjection: (_conversationId, bucketId) => injected.push(bucketId),
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(invocationId);
      fixtureSetup.ingestion.ingest(update(2, 11, 'too late'), new Date());
      // A run that already decided to stop leaves the bucket collecting for the
      // next invocation instead of swallowing it.
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(injected).toEqual([]);
      expect(
        fixtureSetup.store.db.query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()
          ?.state,
      ).toBe('collecting');
    } finally {
      fixtureSetup.store.close();
    }
  });

  test('the input estimate does not grow with the number of model calls', async () => {
    // Regression: every model call added one tool-registry estimate on top of the
    // reported input tokens, which already count the tool schemas the request
    // carried. The estimate therefore grew by one registry per turn, so a long run
    // crossed `hard_token_ratio` and then `context_stop_ratio` on turn count alone:
    // GC discarded live history and the run ended as `context_limit` while the real
    // context was still tiny.
    const fixtureSetup = await fixture((config) => {
      config.agent.rate_limits.turns_per_injection = 40;
    });
    // A window just wide enough for the registry: the drift used to cross
    // `context_stop_ratio` (0.8) well inside the turn budget below.
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 40_000, maxTokens: 1_000 }],
    });
    const responses = Array.from(
      { length: 30 },
      () => () =>
        fauxAssistantMessage(fauxToolCall('read', { path: 'system:///missing.md' }), { stopReason: 'toolUse' }),
    );
    faux.setResponses([...responses, () => fauxAssistantMessage('done')]);
    const runtime = fixtureSetup.runtimeWith(faux);
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'hello'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.config, 'hash', {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: () => undefined,
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);

      const outcome = await runtime.run(invocationId, new AbortController().signal);
      // The run ends because the model stopped calling tools, not because the
      // estimate said the window was full.
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      const requests = fixtureSetup.store.db
        .query<{ tools_json: string }, []>('SELECT tools_json FROM model_calls ORDER BY id')
        .all();
      expect(requests).toHaveLength(31);
      // Closing mode trims the registry to send-only, so a full registry on the
      // last request is the observable proof that the estimate stayed put.
      expect(JSON.parse(requests.at(-1)?.tools_json ?? '[]')).toContain('execute');
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('releases an un-injected batch before the run closes its buckets', async () => {
    // Regression: the terminal transaction closed every bucket in
    // `invocation_buckets` first and released the un-injected ones afterwards, so
    // the release found nothing in state `running` and only its bucket-state write
    // was a no-op — the new invocation was still queued. The batch was therefore
    // re-processed while its bucket read `completed`, and the state never returned
    // to the normal queued → running → terminal path.
    const fixtureSetup = await fixture();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // A stub attachment target is what makes this deterministic: the real runtime
    // would inject the batch at its next turn boundary, and the state under test is
    // the one where the run ends before that boundary is reached.
    const attachment = {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: () => undefined,
    };
    const scheduler = new BucketScheduler(
      fixtureSetup.store,
      fixtureSetup.config,
      'hash',
      async () => {
        await gate;
        return { state: 'completed', reason: 'completed' };
      },
      attachment,
    );
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      scheduler.start();
      scheduler.wake();
      await until(
        () =>
          fixtureSetup.store.db
            .query<{ id: bigint }, []>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1")
            .get() !== null,
        'the opening invocation to start',
      );
      const openingInvocation = fixtureSetup.store.db
        .query<{ id: bigint }, []>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1")
        .get();
      fixtureSetup.ingestion.ingest(update(2, 11, 'attached but never injected'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.config, 'hash', attachment);
      expect(service.processDue(new Date())).toHaveLength(0);
      expect(
        fixtureSetup.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocation_buckets').get()
          ?.count,
      ).toBe(2n);

      // Stop first so the released invocation is not launched before the assertions;
      // `stop` clears the running flag synchronously, then waits for this run.
      const stopping = scheduler.stop();
      release();
      await stopping;

      // The opening bucket closes with the run; the un-injected batch goes back to
      // `queued` and owns the fresh invocation that will replay it.
      expect(
        fixtureSetup.store.db
          .query<{ id: bigint; state: string }, []>('SELECT id, state FROM buckets ORDER BY id')
          .all(),
      ).toEqual([
        { id: 1n, state: 'completed' },
        { id: 2n, state: 'queued' },
      ]);
      const queued = fixtureSetup.store.db
        .query<{ id: bigint; bucket_id: bigint }, []>("SELECT id, bucket_id FROM invocations WHERE state = 'queued'")
        .all();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.bucket_id).toBe(2n);
      expect(queued[0]?.id).not.toBe(openingInvocation?.id);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('drops a queued batch that the run never injected instead of replaying it later', async () => {
    // Regression: `pendingBuckets` outlived the run. A batch attached between rounds
    // and left un-injected (here because the turn budget ends the run before the
    // inject step) stayed in memory, so the next invocation of the same Conversation
    // took it from the queue and injected it a second time — on top of the opening
    // injection that same batch had become in the meantime.
    const fixtureSetup = await fixture((config) => {
      config.agent.rate_limits.turns_per_injection = 1;
    });
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('answered')]);
    const runtime = fixtureSetup.runtimeWith(faux);
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const service = new InvocationQueueService(fixtureSetup.store, fixtureSetup.config, 'hash', {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: () => undefined,
      });
      const [invocationId] = service.processDue(new Date());
      if (invocationId === undefined) {
        throw new Error('Expected an opening invocation');
      }
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
      const conversationId = fixtureSetup.store.db
        .query<{ conversation_id: bigint }, [bigint]>('SELECT conversation_id FROM invocations WHERE id = ?')
        .get(invocationId)?.conversation_id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // Models the attach that lands before the opening injection, when no round is
      // in progress yet: the batch is queued but the run stops on its turn budget
      // before any turn boundary drains the queue.
      fixtureSetup.ingestion.ingest(update(2, 11, 'attached before the opening injection'), new Date());
      fixtureSetup.conversationRuntime.queueInjection(conversationId, 2n);

      const outcome = await runtime.run(invocationId, new AbortController().signal);
      expect(outcome).toEqual({ state: 'completed', reason: 'turn_budget' });
      expect(fixtureSetup.conversationRuntime.hasPendingInjections(conversationId)).toBe(false);
      // Only the opening batch reached the transcript.
      expect(
        fixtureSetup.store.db
          .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM context_messages WHERE role = 'user'")
          .get()?.count,
      ).toBe(1n);
    } finally {
      fixtureSetup.store.close();
    }
  }, 30_000);
});

describe('conversation continuity', () => {
  // The idle grace is off here: these tests care about the transcript, not about
  // waiting for new buckets, and 0 keeps them fast and deterministic.
  const withoutIdleWait = (config: FileConfig): void => {
    config.agent.context.idle_grace_seconds = 0;
  };

  test('a later invocation replays the earlier transcript instead of re-rendering history', async () => {
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    // Each invocation in this test needs its own call the way the loop drives
    // them: the opening answer, its closing turn, then one turn per later run.
    faux.setResponses([
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        });
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('second answer');
      },
      (context, options) => {
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.config, 'hash', async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      for (const [index, text] of ['first', 'second', 'third'].entries()) {
        fixtureSetup.ingestion.ingest(update(index + 1, 10 + index, text), new Date());
        const [invocationId] = scheduler.processDue(new Date());
        if (invocationId === undefined) {
          throw new Error(`Expected invocation ${index + 1}`);
        }
        const outcome = await runtime.run(invocationId, new AbortController().signal);
        expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
        fixtureSetup.store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
        fixtureSetup.store.db
          .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
          .run(invocationId);
      }

      const requests = fixtureSetup.store.db
        .query<{ request_json: string | null }, []>(
          "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id",
        )
        .all();
      // Four calls: the opening answer plus its closing turn, then one turn for
      // each of the two later invocations.
      expect(requests).toHaveLength(4);
      const latest = JSON.parse(requests[3]?.request_json ?? '{}') as {
        messages: { role: string; content: unknown }[];
      };
      const latestUser = [...latest.messages].reverse().find((message) => message.role === 'user');
      const latestText =
        (latestUser?.content as { type: string; text?: string }[] | undefined)
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n') ?? '';
      // The newest batch carries only the new message: everything the transcript
      // already holds is not re-rendered as history.
      expect(latestText).toContain('"message_id":"12"');
      expect(latestText).not.toContain('"message_id":"10"');
      expect(latestText).not.toContain('"message_id":"900"');
      // The earlier turns — the first answer and its send result included —
      // travel as transcript entries instead of a re-rendered history block.
      const transcript = JSON.stringify(latest.messages);
      expect(transcript).toContain('first answer');
      expect(transcript).toContain(`Sent Telegram message ${SEND_MESSAGE_ID}`);
      expect(transcript).toContain('second answer');
      const head = fixtureSetup.store.db
        .query<{ head_seq: bigint; next_seq: bigint }, []>('SELECT head_seq, next_seq FROM conversation_contexts')
        .get();
      // Nothing was collected, so the whole history stays inside the window.
      expect(head?.head_seq).toBe(1n);
      expect(
        fixtureSetup.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM context_messages').get()
          ?.count,
      ).toBe((head?.next_seq ?? 0n) - 1n);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('runs a later invocation after the cached agent is dropped from a provider-shaped history', async () => {
    // Regression: the canonical history is written from what the provider
    // returned, and providers report their own usage counters. A decoder that
    // enumerated a fixed set of them rejected the stored rows, so seeding threw
    // before the first model call and every later invocation of the conversation
    // failed instantly — but only once the in-memory agent was gone (process
    // restart or LRU eviction), which is why a whole conversation went dark right
    // after a restart.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      () => fauxAssistantMessage('first answer'),
      (context, options) => {
        requests.push(JSON.stringify(context.messages));
        options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
        return fauxAssistantMessage('');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.config, 'hash', async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = scheduler.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      await runtime.run(first, new AbortController().signal);
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      // Rewrite the stored row the way a real provider payload reads: the
      // encoder copies `usage` verbatim, so `reasoning` and the cache write split
      // sit in the column exactly like this.
      const stored = fixtureSetup.store.db
        .query<{ seq: bigint; payload_json: string }, []>(
          "SELECT seq, payload_json FROM context_messages WHERE role = 'assistant'",
        )
        .get();
      if (stored === null) {
        throw new Error('Expected a stored assistant message');
      }
      const payload = JSON.parse(stored.payload_json) as { usage: Record<string, unknown> };
      payload.usage.reasoning = 0;
      payload.usage.cacheWrite1h = 12;
      fixtureSetup.store.db
        .query('UPDATE context_messages SET payload_json = ? WHERE seq = ?')
        .run(JSON.stringify(payload), stored.seq);

      // The agent cache is gone — a restart in production, an LRU eviction here.
      const conversationId = fixtureSetup.store.db
        .query<{ id: bigint }, []>('SELECT id FROM conversations LIMIT 1')
        .get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      fixtureSetup.conversationRuntime.forget(conversationId);

      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = scheduler.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      const outcome = await runtime.run(second, new AbortController().signal);
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      const carried = JSON.parse(requests[0] ?? '[]') as { role: string; content: unknown }[];
      // The stored assistant turn was replayed from SQLite, not lost.
      expect(JSON.stringify(carried)).toContain('first answer');
      const latestUser = [...carried].reverse().find((message) => message.role === 'user');
      const latestText =
        (latestUser?.content as { type: string; text?: string }[] | undefined)
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n') ?? '';
      expect(latestText).toContain('"message_id":"11"');
      expect(latestText).not.toContain('"message_id":"10"');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('seeds from a turn boundary when the retained window starts mid-turn', async () => {
    // Regression: `/cut_topic` moves `head_seq` to the end of the history, so a tool
    // result an aborting run still had in flight lands above the new head with its
    // assistant tool call already dropped. `pi-ai` repairs a missing tool result but
    // forwards an orphaned one verbatim, so the provider rejected every request and
    // the whole Conversation stayed broken until someone cut the topic again.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage(''),
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('second answer');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.config, 'hash', async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = scheduler.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      await runtime.run(first, new AbortController().signal);
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      const conversationId = fixtureSetup.store.db
        .query<{ id: bigint }, []>('SELECT id FROM conversations LIMIT 1')
        .get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // The state a cut racing a run leaves behind: everything up to and including
      // the assistant turn that made the call is evicted, and the `send` tool result
      // is the first row of the retained window.
      const sendResult = fixtureSetup.store.db
        .query<{ seq: bigint }, []>("SELECT seq FROM context_messages WHERE role = 'toolResult' ORDER BY seq LIMIT 1")
        .get();
      if (sendResult === null) {
        throw new Error('Expected a stored send result');
      }
      fixtureSetup.store.db
        .query('UPDATE context_messages SET evicted_at = ? WHERE seq < ?')
        .run(new Date().toISOString(), sendResult.seq);
      fixtureSetup.store.db.query('UPDATE conversation_contexts SET head_seq = ?').run(sendResult.seq);
      fixtureSetup.conversationRuntime.forget(conversationId);

      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = scheduler.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      const outcome = await runtime.run(second, new AbortController().signal);
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      // The window had no turn boundary to cut forward to, so it was dropped: the
      // request carries the new batch alone and no orphaned tool result.
      const carried = JSON.parse(requests[0] ?? '[]') as { role: string }[];
      expect(carried.map((message) => message.role)).toEqual(['user']);
      const head = fixtureSetup.store.db
        .query<{ head_seq: bigint; next_seq: bigint }, []>('SELECT head_seq, next_seq FROM conversation_contexts')
        .get();
      expect(head?.head_seq).toBeGreaterThan(sendResult.seq);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('keeps the history after a mid-turn head when a later turn boundary exists', async () => {
    // The other half of the repair: when the broken window does contain a turn
    // boundary, only the tail of the interrupted turn is dropped and the rest of the
    // conversation survives.
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    const requests: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'first answer' }), {
          stopReason: 'toolUse',
        }),
      () => fauxAssistantMessage(''),
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('second answer');
      },
    ]);
    const runtime = fixtureSetup.runtimeWith(faux);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.config, 'hash', async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = scheduler.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      await runtime.run(first, new AbortController().signal);
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      const conversationId = fixtureSetup.store.db
        .query<{ id: bigint }, []>('SELECT id FROM conversations LIMIT 1')
        .get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      // A checkpoint after the interrupted turn, written through the real store so
      // `next_seq` stays consistent.
      const contexts = new ConversationContextStore(fixtureSetup.store);
      const header = contexts.header(conversationId);
      if (header === undefined) {
        throw new Error('Expected a context header');
      }
      const boundarySeq = contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: 'a later batch', timestamp: 1 }),
        role: 'user',
      });
      const sendResult = fixtureSetup.store.db
        .query<{ seq: bigint }, []>("SELECT seq FROM context_messages WHERE role = 'toolResult' ORDER BY seq LIMIT 1")
        .get();
      if (sendResult === null) {
        throw new Error('Expected a stored send result');
      }
      fixtureSetup.store.db
        .query('UPDATE context_messages SET evicted_at = ? WHERE seq < ?')
        .run(new Date().toISOString(), sendResult.seq);
      fixtureSetup.store.db.query('UPDATE conversation_contexts SET head_seq = ?').run(sendResult.seq);
      fixtureSetup.conversationRuntime.forget(conversationId);

      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = scheduler.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      const outcome = await runtime.run(second, new AbortController().signal);
      expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
      // Head moved forward to the boundary, not to the end: the retained batch is
      // still replayed alongside the new one, and the orphan is gone.
      expect(
        fixtureSetup.store.db.query<{ head_seq: bigint }, []>('SELECT head_seq FROM conversation_contexts').get()
          ?.head_seq,
      ).toBe(boundarySeq);
      const carried = JSON.parse(requests[0] ?? '[]') as { role: string }[];
      expect(carried.map((message) => message.role)).toEqual(['user', 'user']);
      expect(requests[0]).toContain('a later batch');
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);

  test('rebuilds the context when the stable system prompt changes', async () => {
    const fixtureSetup = await fixture(withoutIdleWait);
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('')]);
    const scheduler = new BucketScheduler(fixtureSetup.store, fixtureSetup.config, 'hash', async () => ({
      state: 'completed',
      reason: 'done',
    }));
    try {
      fixtureSetup.ingestion.ingest(update(1, 10, 'first'), new Date());
      const [first] = scheduler.processDue(new Date());
      if (first === undefined) {
        throw new Error('Expected the first invocation');
      }
      await fixtureSetup.runtimeWith(faux, { systemPrompt: 'prompt A' }).run(first, new AbortController().signal);
      fixtureSetup.store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(first);
      fixtureSetup.store.db
        .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      const before = fixtureSetup.store.db
        .query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM context_messages')
        .get();
      expect(before?.count).toBeGreaterThan(0n);

      fixtureSetup.ingestion.ingest(update(2, 11, 'second'), new Date());
      const [second] = scheduler.processDue(new Date());
      if (second === undefined) {
        throw new Error('Expected the second invocation');
      }
      await fixtureSetup.runtimeWith(faux, { systemPrompt: 'prompt B' }).run(second, new AbortController().signal);

      // The old rows were dropped, so every row left in the canonical history
      // belongs to the new run and the retained window starts fresh.
      const retained = fixtureSetup.store.db
        .query<{ invocation_id: bigint }, [bigint]>(
          'SELECT invocation_id FROM context_messages WHERE seq >= (SELECT head_seq FROM conversation_contexts)',
        )
        .all(second);
      expect(retained.length).toBeGreaterThan(0n);
      expect(retained.every((row) => row.invocation_id === second)).toBe(true);
      const head = fixtureSetup.store.db
        .query<{ head_seq: bigint; next_seq: bigint }, []>('SELECT head_seq, next_seq FROM conversation_contexts')
        .get();
      expect(head?.head_seq).toBe(1n);
      expect(head?.next_seq).toBe(BigInt(retained.length) + 1n);
    } finally {
      await scheduler.stop();
      fixtureSetup.store.close();
    }
  }, 30_000);
});

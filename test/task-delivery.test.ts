import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { afterEach, describe, expect, test } from 'vitest';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { cancelOngoingSessions } from '../src/ingress/admin/operations.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { InvocationQueueService } from '../src/orchestration/invocation-queue.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig } from '../src/platform/config.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const stores: SqliteStore[] = [];
const CHAT_ID = 123456789;

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(sendResponse = true): Promise<{
  store: SqliteStore;
  scheduler: BucketScheduler;
  tasks: LongTaskService;
  configStore: Awaited<ReturnType<typeof testConfigStore>>;
  capturedPrompts: string[];
  sends: string[];
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-task-delivery-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 60;
      config.agent.send_nudge_enabled = false;
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const capturedPrompts: string[] = [];
  faux.setResponses([
    (context, options) => {
      capturedPrompts.push(JSON.stringify(context.messages));
      options?.onPayload?.({ model: 'agent-model', messages: context.messages }, faux.getModel());
      return sendResponse
        ? fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'task delivered' }), {
            stopReason: 'toolUse',
          })
        : fauxAssistantMessage('private completion analysis');
    },
    fauxAssistantMessage(''),
  ]);
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  const sends: string[] = [];
  const telegramApi: TelegramSendApi = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: 700 + sends.length, date: 1_700_000_000, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => ({ message_id: 999, date: 1_700_000_000, chat: { id: CHAT_ID } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    telegramApi,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: SystemResources.empty(),
  });
  const tasks = new LongTaskService(store.orm);
  const scheduler = new BucketScheduler(
    store,
    configStore,
    async (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
    undefined,
    tasks,
  );
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: 'establish conversation',
    },
  };
  ingestion.ingest(update, new Date('2026-08-15T00:00:00.000Z'));
  return { store, scheduler, tasks, configStore, capturedPrompts, sends };
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('generic task receipt delivery', () => {
  test('an external completion after the creating invocation is gone wakes a receipt invocation that can publish only via send', async () => {
    const { store, scheduler, tasks, capturedPrompts, sends } = await setup();
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected ingestion to establish a conversation');
    }

    store.db
      .prepare(
        "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (900, ?, 'completed', 'realtime', ?, ?, ?, ?)",
      )
      .run(
        conversation.id,
        '2026-08-14T00:00:00.000Z',
        '2026-08-14T00:00:00.000Z',
        '2026-08-14T00:00:00.000Z',
        '2026-08-14T00:00:00.000Z',
      );
    store.db
      .prepare(
        "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at) VALUES (900, 900, ?, 'completed', 'h', 1, ?)",
      )
      .run(conversation.id, '2026-08-14T00:00:00.000Z');
    const payload = { kind: 'export', request: 'weekly report', marker: 'payload-is-persisted' };
    const creator = tasks.invocationScope('test-plugin', {
      ...previewContext(),
      invocationId: 900n,
      conversationId: conversation.id,
      callerUserId: 42n,
    });
    const created = creator.create({
      payload,
      delivery: { bypassDailyBudget: false, mentionUser: { userId: 42n, displayName: 'Alice' } },
    });
    expect(
      store.db
        .prepare<[bigint], { created_by_invocation_id: bigint | null }>(
          'SELECT created_by_invocation_id FROM long_tasks WHERE id = ?',
        )
        .get(created.taskId),
    ).toEqual({ created_by_invocation_id: 900n });
    store.db.prepare('DELETE FROM invocations WHERE id = 900').run();
    expect(
      tasks.scoped('test-plugin', conversation.id).complete(created.taskId, { url: 'https://example.test/report' }),
    ).toBe(true);

    try {
      scheduler.start();
      scheduler.wake();
      await eventually(() => sends.length === 1, 'the generic receipt send');
    } finally {
      await scheduler.stop();
    }

    expect(sends).toEqual(['@Alice task delivered']);
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM telegram_sends WHERE state = 'success'")
        .get()?.count,
    ).toBe(1n);
    expect(
      store.db
        .prepare<[], { count: bigint }>(
          "SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'send' AND state = 'success'",
        )
        .get()?.count,
    ).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls').get()?.count,
    ).toBeGreaterThan(0n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()?.count,
    ).toBeGreaterThan(0n);
    expect(
      store.db.prepare<[], { head_seq: bigint }>('SELECT head_seq FROM conversation_contexts').get()?.head_seq,
    ).toBeGreaterThan(0n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_refs').get()?.count).toBe(0n);
    expect(
      store.db
        .prepare<[bigint], { state: string; invocation_outcome: string | null }>(
          'SELECT state, invocation_outcome FROM task_receipts WHERE task_id = ?',
        )
        .get(created.taskId),
    ).toEqual({ state: 'handled', invocation_outcome: 'completed' });
    expect(capturedPrompts.join('\n')).toContain('https://example.test/report');
    expect(
      store.db
        .prepare<[bigint], { created_by_invocation_id: bigint | null; payload_json: string }>(
          'SELECT created_by_invocation_id, payload_json FROM long_tasks WHERE id = ?',
        )
        .get(created.taskId),
    ).toEqual({ created_by_invocation_id: null, payload_json: JSON.stringify(payload) });
  }, 15_000);

  test('a failed receipt is injected and audited even when private assistant text does not publish', async () => {
    const { store, scheduler, tasks, capturedPrompts, sends } = await setup(false);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected ingestion to establish a conversation');
    }

    const created = tasks.scoped('test-plugin', conversation.id).create({ payload: { operation: 'export' } });
    expect(
      tasks.scoped('test-plugin', conversation.id).fail(created.taskId, { code: 'upstream_failed', retryable: false }),
    ).toBe(true);

    try {
      scheduler.start();
      scheduler.wake();
      await eventually(
        () =>
          store.db
            .prepare<[bigint], { state: string }>('SELECT state FROM task_receipts WHERE task_id = ?')
            .get(created.taskId)?.state === 'handled',
        'failed receipt settlement',
      );
    } finally {
      await scheduler.stop();
    }

    expect(sends).toEqual([]);
    expect(capturedPrompts.join('\n')).toContain('upstream_failed');
    expect(
      store.db
        .prepare<[bigint], { state: string; error_json: string | null; invocation_outcome: string | null }>(
          'SELECT state, error_json, invocation_outcome FROM task_receipts WHERE task_id = ?',
        )
        .get(created.taskId),
    ).toEqual({
      state: 'handled',
      error_json: JSON.stringify({ code: 'upstream_failed', retryable: false }),
      invocation_outcome: 'completed',
    });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(
      0n,
    );
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM tool_calls').get()?.count).toBe(0n);
    expect(
      store.db.prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE state = 'success'").get()
        ?.count,
    ).toBe(1n);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()?.count,
    ).toBeGreaterThan(0n);
    expect(
      store.db.prepare<[], { head_seq: bigint }>('SELECT head_seq FROM conversation_contexts').get()?.head_seq,
    ).toBeGreaterThan(0n);
  }, 15_000);

  test('invalid destinations suppress pending receipts and claimed receipt invocations with their buckets', async () => {
    const { store, scheduler, tasks, configStore } = await setup();
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected ingestion to establish a conversation');
    }
    const chat = store.db
      .prepare<[bigint], { id: bigint }>('SELECT chat_id AS id FROM conversations WHERE id = ?')
      .get(conversation.id);
    if (chat === undefined) {
      throw new Error('Expected conversation chat');
    }

    const pending = tasks.scoped('test-plugin', conversation.id).create({ payload: { state: 'pending' } });
    expect(tasks.scoped('test-plugin', conversation.id).complete(pending.taskId)).toBe(true);
    store.db
      .prepare('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)')
      .run(chat.id, '2026-08-15T00:00:00.000Z');
    expect(scheduler.processTasksDue(new Date('2026-08-15T00:00:01.000Z'))).toEqual([]);
    expect(
      store.db
        .prepare<[bigint], { state: string; cancel_reason: string | null }>(
          'SELECT state, cancel_reason FROM task_receipts WHERE task_id = ?',
        )
        .get(pending.taskId),
    ).toEqual({ state: 'suppressed', cancel_reason: 'chat_paused' });
    store.db.prepare('DELETE FROM chat_pause WHERE chat_id = ?').run(chat.id);

    const claimed = tasks.scoped('test-plugin', conversation.id).create({ payload: { state: 'claimed' } });
    expect(tasks.scoped('test-plugin', conversation.id).complete(claimed.taskId)).toBe(true);
    const [invocationId] = scheduler.processTasksDue(new Date('2026-08-15T00:00:02.000Z'));
    if (invocationId === undefined) {
      throw new Error('Expected claimed receipt invocation');
    }
    configStore.publish({
      ...configStore.current(),
      config: {
        ...configStore.current().config,
        telegram: { ...configStore.current().config.telegram, chats: [] },
      },
    });
    // Queue construction and destination revalidation are separate calls: this
    // reproduces a config change after claim but before the scheduler can launch.
    new InvocationQueueService(store, configStore, undefined, tasks).suppressInvalidQueuedReceipts(
      new Date('2026-08-15T00:00:03.000Z'),
    );

    expect(
      store.db
        .prepare<[bigint], { state: string; cancel_reason: string | null }>(
          'SELECT state, cancel_reason FROM task_receipts WHERE task_id = ?',
        )
        .get(claimed.taskId),
    ).toEqual({ state: 'suppressed', cancel_reason: 'chat_removed' });
    expect(
      store.db
        .prepare<[bigint], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations WHERE id = ?',
        )
        .get(invocationId),
    ).toEqual({ state: 'aborted', completion_reason: 'chat_removed' });
    expect(
      store.db
        .prepare<[bigint], { state: string; error_code: string | null }>(
          'SELECT state, error_code FROM buckets WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)',
        )
        .get(invocationId),
    ).toEqual({ state: 'aborted', error_code: 'chat_removed' });
    expect(
      store.db
        .prepare<[bigint], { count: bigint }>(
          'SELECT COUNT(*) AS count FROM invocation_buckets WHERE invocation_id = ?',
        )
        .get(invocationId)?.count,
    ).toBe(1n);
  }, 15_000);

  test('admin cancellation suppresses queued claims but lets a running receipt settle through AbortSignal', async () => {
    const { store, scheduler, tasks, configStore } = await setup();
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected ingestion to establish a conversation');
    }

    const queued = tasks.scoped('test-plugin', conversation.id).create({ payload: { mode: 'queued' } });
    expect(tasks.scoped('test-plugin', conversation.id).complete(queued.taskId)).toBe(true);
    const [queuedInvocation] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (queuedInvocation === undefined) {
      throw new Error('Expected queued receipt invocation');
    }
    expect(cancelOngoingSessions(store.orm, new Date('2026-08-15T00:00:01.000Z')).canceled_invocations).toBe(1);
    expect(
      store.db
        .prepare<[bigint], { state: string; cancel_reason: string | null }>(
          'SELECT state, cancel_reason FROM task_receipts WHERE task_id = ?',
        )
        .get(queued.taskId),
    ).toEqual({ state: 'suppressed', cancel_reason: 'admin_cancel' });

    const running = tasks.scoped('test-plugin', conversation.id).create({ payload: { mode: 'running' } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    let runningInvocation!: bigint;
    const abortingScheduler = new BucketScheduler(
      store,
      configStore,
      async (_invocationId, _snapshot, signal) => {
        started();
        await gate;
        return signal.aborted ? { state: 'aborted', reason: 'admin_cancel' } : { state: 'completed', reason: 'done' };
      },
      undefined,
      tasks,
    );
    try {
      abortingScheduler.start(new Date('2026-08-15T00:00:02.000Z'));
      expect(tasks.scoped('test-plugin', conversation.id).complete(running.taskId)).toBe(true);
      const [claimedRunningInvocation] = abortingScheduler.processTasksDue(new Date('2026-08-15T00:00:03.000Z'));
      if (claimedRunningInvocation === undefined) {
        throw new Error('Expected running receipt invocation');
      }
      runningInvocation = claimedRunningInvocation;
      abortingScheduler.wake();
      await startedSignal;
      expect(cancelOngoingSessions(store.orm, new Date('2026-08-15T00:00:04.000Z')).canceled_invocations).toBe(0);
      expect(abortingScheduler.abortAll()).toBe(1);
      release();
      await eventually(
        () =>
          store.db
            .prepare<[bigint], { state: string }>('SELECT state FROM task_receipts WHERE task_id = ?')
            .get(running.taskId)?.state === 'handled',
        'running receipt abort settlement',
      );
    } finally {
      release();
      await abortingScheduler.stop();
    }

    expect(
      store.db
        .prepare<[bigint], { state: string; invocation_outcome: string | null; completion_reason: string | null }>(
          'SELECT state, invocation_outcome, completion_reason FROM task_receipts WHERE task_id = ?',
        )
        .get(running.taskId),
    ).toEqual({ state: 'handled', invocation_outcome: 'aborted', completion_reason: 'admin_cancel' });
    expect(
      store.db.prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?').get(runningInvocation)
        ?.state,
    ).toBe('aborted');
  }, 15_000);
});

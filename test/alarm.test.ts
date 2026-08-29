import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { Compile } from 'typebox/compile';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { AdminServer } from '../src/admin/server.ts';
import { cancelAlarm, listAlarms } from '../src/admin/alarm-admin.ts';
import { AgentRuntime } from '../src/agent-runtime.ts';
import { AlarmInputSchema, createAlarmTool } from '../src/alarm.ts';
import { BotCommandService } from '../src/bot-commands.ts';
import { KeyedSemaphore } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { purgeExpiredData, SqliteStore } from '../src/database.ts';
import { AgentModelSwitcher } from '../src/model-switch.ts';
import { BucketScheduler } from '../src/scheduler.ts';
import { SecretStore } from '../src/secrets.ts';
import { createSendTool, type TelegramSendApi } from '../src/send-tool.ts';
import { enterSleep } from '../src/sleep.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return {
    directory,
    configPath,
    loaded,
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999 }),
    scheduler: new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
      state: 'completed',
      reason: 'done',
    })),
    builder: new ContextBuilder(store, loaded.config),
  };
}

async function setupAdmin(): Promise<{ store: SqliteStore; loaded: Awaited<ReturnType<typeof loadConfig>> }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
      };
    }),
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded };
}

function update(updateId: number, messageId: number, text: string, userId = 42): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function processDue(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

const ADMIN_PASSWORD = 'correct-horse-battery';

function adminRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function adminPost(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return adminRequest(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function adminSessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function futureIso(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString();
}

function ensureConversation(store: SqliteStore): bigint {
  const existing = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations LIMIT 1').get();
  if (existing !== null) {
    return existing.id;
  }
  const chat = store.db
    .query<{ id: bigint }, [string]>(
      "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (123456789, 123456789, 'private', 'Owner', ?) RETURNING id",
    )
    .get(new Date().toISOString());
  const conversation = store.db
    .query<{ id: bigint }, [bigint, string, string]>(
      'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
    )
    .get(chat?.id ?? 0n, new Date().toISOString(), new Date().toISOString());
  return conversation?.id ?? 0n;
}

function insertAlarm(
  store: SqliteStore,
  conversationId: bigint,
  scheduledAt: string,
  options: {
    targetUserId?: bigint;
    displayName?: string;
    summary?: string;
    state?: string;
    invocationId?: bigint;
  } = {},
): bigint {
  const created = store.db
    .query(
      `INSERT INTO alarms(conversation_id, target_user_id, target_display_name, summary, scheduled_at, created_at,
                          state, invocation_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      conversationId,
      options.targetUserId ?? 42n,
      options.displayName ?? 'Alice',
      options.summary ?? 'test alarm',
      scheduledAt,
      new Date(Date.parse(scheduledAt) - 60_000).toISOString(),
      options.state ?? 'pending',
      options.invocationId ?? null,
      new Date().toISOString(),
    );
  return BigInt(created.lastInsertRowid);
}

describe('alarm tool', () => {
  test('validates schema boundaries and persists a pending alarm with UTC deadline', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);

    expect(Compile(AlarmInputSchema).Check({ target_user_id: '42', summary: 'x', datetime: futureIso(3600_000) })).toBe(
      true,
    );
    expect(Compile(AlarmInputSchema).Check({ target_user_id: '42', summary: '', datetime: futureIso(3600_000) })).toBe(
      false,
    );
    expect(
      Compile(AlarmInputSchema).Check({
        target_user_id: '42',
        summary: 'x'.repeat(501),
        datetime: futureIso(3600_000),
      }),
    ).toBe(false);
    expect(Compile(AlarmInputSchema).Check({ target_user_id: '0', summary: 'x', datetime: futureIso(3600_000) })).toBe(
      false,
    );

    const scheduled = futureIso(3_600_000);
    const tool = createAlarmTool({ store, context });
    const result = await tool.execute('call-1', {
      target_user_id: '42',
      summary: 'follow up on the hospital visit',
      datetime: scheduled,
    });
    expect(result.details.scheduled_at).toBe(scheduled);
    const row = store.db
      .query<{ state: string; target_user_id: bigint; scheduled_at: string }, [string]>(
        'SELECT state, target_user_id, scheduled_at FROM alarms WHERE id = ?',
      )
      .get(result.details.id);
    expect(row).toEqual({ state: 'pending', target_user_id: 42n, scheduled_at: scheduled });
    const audit = store.db
      .query<{ state: string; error_code: string | null; result_text: string | null }, []>(
        'SELECT state, error_code, result_text FROM tool_calls',
      )
      .get();
    expect(audit?.state).toBe('success');
    expect(audit?.error_code).toBe(null);
    expect(audit?.result_text).toContain('alarm_id=');
    store.close();
  });

  test('rejects unauthorized targets, bad datetimes, and enforces a per-invocation quota', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello', 42), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const tool = createAlarmTool({ store, context });

    await expect(
      tool.execute('unauthorized', { target_user_id: '999', summary: 'x', datetime: futureIso(3600_000) }),
    ).rejects.toThrow('not visible');
    expect(
      store.db
        .query<{ error_code: string | null }, []>(
          "SELECT error_code FROM tool_calls WHERE tool_call_id = 'unauthorized'",
        )
        .get()?.error_code,
    ).toBe('alarm_target_not_authorized');

    await expect(
      tool.execute('past', { target_user_id: '42', summary: 'x', datetime: futureIso(-1000) }),
    ).rejects.toThrow('datetime is invalid');
    expect(
      store.db
        .query<{ error_code: string | null }, []>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'past'")
        .get()?.error_code,
    ).toBe('alarm_datetime_not_future');

    await expect(
      tool.execute('far', { target_user_id: '42', summary: 'x', datetime: futureIso(366 * 86_400_000) }),
    ).rejects.toThrow('datetime is invalid');
    expect(
      store.db
        .query<{ error_code: string | null }, []>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'far'")
        .get()?.error_code,
    ).toBe('alarm_datetime_too_far');

    for (let index = 0; index < 3; index += 1) {
      await tool.execute(`quota-${index}`, {
        target_user_id: '42',
        summary: `alarm ${index}`,
        datetime: futureIso((index + 1) * 3_600_000),
      });
    }
    await expect(
      tool.execute('quota-3', { target_user_id: '42', summary: 'fourth', datetime: futureIso(5 * 3_600_000) }),
    ).rejects.toThrow('quota');
    expect(
      store.db
        .query<{ error_code: string | null }, []>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'quota-3'")
        .get()?.error_code,
    ).toBe('alarm_quota_exceeded');
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM alarms').get()?.count).toBe(3n);
    store.close();
  });
});

describe('alarm scheduler', () => {
  test('claims a due alarm into an invocation and leaves the topic conversation untouched', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    const invocations = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(invocations).toHaveLength(1);
    const alarm = store.db
      .query<{ state: string; invocation_id: bigint | null }, [bigint]>(
        'SELECT state, invocation_id FROM alarms WHERE id = ?',
      )
      .get(alarmId);
    expect(alarm?.state).toBe('firing');
    expect(alarm?.invocation_id).toBe(invocations[0]);
    const context = builder.build(invocations[0] ?? 0n, 200_000, 0, 32768);
    expect(context.alarm?.userId).toBe(42n);
    expect(context.systemPrompt).toContain('test alarm');
    const newCount = store.db
      .query<{ count: bigint }, [bigint]>(
        "SELECT COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? AND section = 'new'",
      )
      .get(invocations[0] ?? 0n)?.count;
    expect(newCount).toBe(0n);
    store.close();
  });

  test('cancels due alarms for pause, chat removal, and topic removal without reserving budget', async () => {
    const { store, scheduler } = await setup();
    const conversation = ensureConversation(store);
    const chat = store.db
      .query<{ chat_id: bigint }, [bigint]>('SELECT chat_id FROM conversations WHERE id = ?')
      .get(conversation);
    const pausedAlarm = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
    store.db
      .query('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)')
      .run(chat?.chat_id ?? 0n, new Date().toISOString());
    scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(
      store.db
        .query<{ state: string; cancel_reason: string | null }, [bigint]>(
          'SELECT state, cancel_reason FROM alarms WHERE id = ?',
        )
        .get(pausedAlarm),
    ).toEqual({ state: 'cancelled', cancel_reason: 'chat_paused' });

    const removedChat = store.db
      .query<{ id: bigint }, [string]>(
        "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (999999999, 999999999, 'group', 'Removed', ?) RETURNING id",
      )
      .get(new Date().toISOString());
    const removedConversation = store.db
      .query<{ id: bigint }, [bigint, string, string]>(
        'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
      )
      .get(removedChat?.id ?? 0n, new Date().toISOString(), new Date().toISOString());
    const removedAlarm = insertAlarm(store, removedConversation?.id ?? 0n, '2026-08-14T23:59:00.000Z');
    scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(
      store.db
        .query<{ state: string; cancel_reason: string | null }, [bigint]>(
          'SELECT state, cancel_reason FROM alarms WHERE id = ?',
        )
        .get(removedAlarm),
    ).toEqual({ state: 'cancelled', cancel_reason: 'chat_removed' });
    expect(
      store.db
        .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM daily_usage WHERE metric = 'agent_invocations'")
        .get()?.count,
    ).toBe(0n);
    store.close();
  });

  test('recovers a firing alarm as fired/outcome_unknown and never returns it to pending', async () => {
    const { store, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { state: 'firing' });
    scheduler.recover(new Date('2026-08-15T00:00:00.000Z'));
    expect(
      store.db
        .query<{ state: string; invocation_outcome: string | null }, [bigint]>(
          'SELECT state, invocation_outcome FROM alarms WHERE id = ?',
        )
        .get(alarmId),
    ).toEqual({ state: 'fired', invocation_outcome: 'outcome_unknown' });
    scheduler.recover(new Date('2026-08-15T00:00:01.000Z'));
    expect(
      store.db.query<{ state: string }, [bigint]>('SELECT state FROM alarms WHERE id = ?').get(alarmId)?.state,
    ).toBe('fired');
    store.close();
  });
});

describe('alarm runtime budget bypass', () => {
  test('an alarm invocation bypasses the daily token gate while an ordinary invocation still blocks', async () => {
    const { store, ingestion, scheduler, loaded } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    // Exhaust the daily token budget for the real UTC date.
    const today = new Date().toISOString().slice(0, 10);
    store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?) ON CONFLICT(utc_date, scope, resource, metric) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at",
      )
      .run(today, '123456789', BigInt(loaded.config.agent.daily_budget.max_tokens), new Date().toISOString());

    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    const [alarmInvocation] = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }

    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    faux.setResponses([fauxAssistantMessage('followed up')]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const registry = { models, agentModel: model, visionModel: model };
    const runtime = new AgentRuntime({
      store,
      config: loaded.config,
      secrets: new SecretStore(),
      registry,
      modelSwitcher: new AgentModelSwitcher(loaded.config, registry.models),
      telegramApi: {
        sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
        sendSticker: async () => ({ message_id: 501, date: 1_700_000_101, chat: { id: 123456789 } }),
      },
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      modelGate: new KeyedSemaphore(),
    });
    expect(await runtime.run(alarmInvocation, new AbortController().signal)).toEqual({
      state: 'completed',
      reason: 'completed',
    });

    // Release the alarm invocation so the same chat can schedule a normal bucket.
    store.db
      .query("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), alarmInvocation);
    store.db
      .query(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date().toISOString(), alarmInvocation);
    ingestion.ingest(update(2, 11, 'next'), new Date('2026-08-15T00:00:30.000Z'));
    const [normalInvocation] = scheduler.processDue(new Date('2026-08-15T00:00:45.000Z'));
    if (normalInvocation === undefined) {
      throw new Error('Expected normal invocation');
    }
    expect(await runtime.run(normalInvocation, new AbortController().signal)).toEqual({
      state: 'failed',
      reason: 'daily_token_budget',
    });
    store.close();
  });
});

describe('alarm send mention', () => {
  test('prefixes the first successful text send with a target mention and leaves later sends alone', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = builder.build(alarmInvocation, 200_000, 0, 32768);
    expect(context.alarm).not.toBe(null);

    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map([['stk_1', 'file-id']]),
      maxSends: 6,
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await tool.execute('sticker-1', { kind: 'sticker', sticker_ref: 'stk_1' });
    expect(requests).toHaveLength(0);
    await tool.execute('text-1', { kind: 'text', text: 'how are you now?' });
    expect(requests[0]?.text).toBe('@Alice how are you now?');
    expect(requests[0]?.options.entities).toEqual([
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=42' },
    ]);
    await tool.execute('text-2', { kind: 'text', text: 'second message' });
    expect(requests[1]?.text).toBe('second message');
    expect(requests[1]?.options.entities).toBeUndefined();
    store.close();
  });
});

describe('alarm admin', () => {
  test('lists alarms with pending-first ordering and stable cursor pagination', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    const pending1 = insertAlarm(store, conversation, '2026-08-15T02:00:00.000Z', { summary: 'pending 1' });
    const pending2 = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z', { summary: 'pending 2' });
    const fired = insertAlarm(store, conversation, '2026-08-15T00:30:00.000Z', { state: 'fired', summary: 'fired' });
    store.db.query('UPDATE alarms SET fired_at = ? WHERE id = ?').run('2026-08-15T00:30:00.000Z', fired);

    const first = listAlarms(store.db, { limit: '2' });
    expect(first.items.map((item) => item.id)).toEqual([pending2.toString(), pending1.toString()]);
    expect(first.next_cursor).not.toBe(null);
    const second = listAlarms(store.db, { limit: '2', cursor: first.next_cursor });
    expect(second.items.map((item) => item.id)).toEqual([fired.toString()]);
    expect(second.next_cursor).toBe(null);
    store.close();
  });

  test('filters by state, chat, and target and keeps bigint ids as strings', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z', { summary: 'mine', targetUserId: 42n });
    insertAlarm(store, conversation, '2026-08-15T02:00:00.000Z', { summary: 'other', targetUserId: 7n });
    const mine = listAlarms(store.db, { target: '42' });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]?.target_user_id).toBe('42');
    expect(mine.items[0]?.chat.message_thread_id).toBe('0');
    expect(mine.items[0]?.conversation_id).toBe(conversation.toString());
    const pending = listAlarms(store.db, { state: 'pending' });
    expect(pending.items).toHaveLength(2);
    const fired = listAlarms(store.db, { state: 'fired' });
    expect(fired.items).toHaveLength(0);
    store.close();
  });

  test('atomically cancels only pending alarms and records the admin actor', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z');
    expect(cancelAlarm(store.db, pending, 'owner')).toEqual({ status: 'cancelled' });
    const row = store.db
      .query<
        { state: string; cancelled_by: string | null; admin_cancelled: bigint; cancel_reason: string | null },
        [bigint]
      >('SELECT state, cancelled_by, admin_cancelled, cancel_reason FROM alarms WHERE id = ?')
      .get(pending);
    expect(row).toEqual({
      state: 'cancelled',
      cancelled_by: 'owner',
      admin_cancelled: 1n,
      cancel_reason: 'admin_cancelled',
    });
    expect(() => cancelAlarm(store.db, pending, 'owner')).toThrow('Only pending alarms can be cancelled');
    expect(() => cancelAlarm(store.db, 999999n, 'owner')).toThrow('does not exist');
    store.close();
  });
});

describe('alarm scheduling behavior', () => {
  test('launches a claimed alarm before an already-queued normal invocation, then the queued normal runs', async () => {
    const { store, loaded, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const normalInvocation = processDue(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');

    const launched: bigint[] = [];
    let releaseGate!: () => void;
    let firstLaunched!: () => void;
    const firstSignal = new Promise<void>((resolve) => {
      firstLaunched = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const recording = new BucketScheduler(store, loaded.config, loaded.hash, async (id) => {
      launched.push(id);
      if (launched.length === 1) {
        firstLaunched();
        await gate;
      }
      return { state: 'completed', reason: 'done' };
    });
    recording.start(new Date('2026-08-15T00:00:00.000Z'));
    await firstSignal;
    const alarmInvocation = store.db
      .query<{ invocation_id: bigint }, []>("SELECT invocation_id FROM alarms WHERE state IN ('firing', 'fired')")
      .get()?.invocation_id;
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    // While the alarm is still running, the queued normal invocation must wait.
    expect(
      store.db.query<{ state: string }, [bigint]>('SELECT state FROM invocations WHERE id = ?').get(normalInvocation)
        ?.state,
    ).toBe('queued');
    releaseGate();
    while (launched.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await recording.stop(30_000);
    expect(launched).toEqual([alarmInvocation, normalInvocation]);
    store.close();
  });

  test('a claimed alarm still launches while the bot is sleeping', async () => {
    const { store, loaded, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const normalInvocation = processDue(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    enterSleep(store.db);

    const launched: bigint[] = [];
    const recording = new BucketScheduler(store, loaded.config, loaded.hash, async (id) => {
      launched.push(id);
      return { state: 'completed', reason: 'done' };
    });
    recording.start(new Date('2026-08-15T00:00:00.000Z'));
    await recording.stop(30_000);

    const alarmInvocation = store.db
      .query<{ invocation_id: bigint }, []>("SELECT invocation_id FROM alarms WHERE state = 'fired'")
      .get()?.invocation_id;
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    expect(launched).toEqual([alarmInvocation]);
    expect(
      store.db.query<{ state: string }, [bigint]>('SELECT state FROM invocations WHERE id = ?').get(normalInvocation)
        ?.state,
    ).toBe('skipped_budget');
    store.close();
  });

  test('does not claim while a same-chat invocation is running, then claims on release', async () => {
    const { store, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    store.db
      .query("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(received.toISOString(), invocationId);
    store.db
      .query(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(received.toISOString(), invocationId);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');

    expect(scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'))).toEqual([]);
    expect(
      store.db.query<{ state: string }, [bigint]>('SELECT state FROM alarms WHERE id = ?').get(alarmId)?.state,
    ).toBe('pending');

    store.db
      .query("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run('2026-08-15T00:00:01.000Z', invocationId);
    store.db
      .query(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run('2026-08-15T00:00:01.000Z', invocationId);

    const claimed = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:01.000Z'));
    expect(claimed).toHaveLength(1);
    expect(
      store.db.query<{ state: string }, [bigint]>('SELECT state FROM alarms WHERE id = ?').get(alarmId)?.state,
    ).toBe('firing');
    store.close();
  });

  test('pause after claim closes the firing alarm as cancelled/chat_paused', async () => {
    const { store, loaded, scheduler } = await setup();
    const conversation = ensureConversation(store);
    const alarmId = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
    const [invocationId] = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    if (invocationId === undefined) {
      throw new Error('Expected claimed alarm invocation');
    }

    const now = new Date().toISOString();
    store.db
      .query(
        "INSERT INTO bot_admins(telegram_user_id, display_name, added_by, created_at, updated_at) VALUES (42, 'Alice', 'config', ?, ?)",
      )
      .run(now, now);
    const commands = new BotCommandService(store, loaded.config, scheduler);
    expect(
      commands.run(
        { name: 'pause' },
        123456789n,
        { id: 42n, name: 'Alice', username: null },
        new Date('2026-08-15T00:00:00.000Z'),
      ),
    ).toContain('已暂停');

    const alarm = store.db
      .query<{ state: string; cancel_reason: string | null; admin_cancelled: bigint }, [bigint]>(
        'SELECT state, cancel_reason, admin_cancelled FROM alarms WHERE id = ?',
      )
      .get(alarmId);
    expect(alarm).toEqual({ state: 'cancelled', cancel_reason: 'chat_paused', admin_cancelled: 0n });
    expect(
      store.db
        .query<{ state: string; completion_reason: string | null }, [bigint]>(
          'SELECT state, completion_reason FROM invocations WHERE id = ?',
        )
        .get(invocationId),
    ).toEqual({ state: 'aborted', completion_reason: 'chat_paused' });
    store.close();
  });

  test('every terminal invocation outcome closes the alarm without retry', async () => {
    const { store, loaded } = await setup();
    const outcomes: Array<{ state: 'completed' | 'failed' | 'aborted' | 'outcome_unknown'; reason: string }> = [
      { state: 'completed', reason: 'completed' },
      { state: 'failed', reason: 'model_error' },
      { state: 'aborted', reason: 'timeout' },
      { state: 'outcome_unknown', reason: 'telegram_unknown' },
    ];
    for (const outcome of outcomes) {
      const conversation = ensureConversation(store);
      const alarmId = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
      const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => outcome);
      scheduler.start(new Date('2026-08-15T00:00:00.000Z'));
      await scheduler.stop(30_000);
      const row = store.db
        .query<{ state: string; invocation_outcome: string | null; completion_reason: string | null }, [bigint]>(
          'SELECT state, invocation_outcome, completion_reason FROM alarms WHERE id = ?',
        )
        .get(alarmId);
      expect(row).toEqual({
        state: 'fired',
        invocation_outcome: outcome.state,
        completion_reason: outcome.reason,
      });
    }
    store.close();
  });
});

describe('alarm retention', () => {
  test('keeps pending and firing alarms but purges terminal history', async () => {
    const { store, loaded } = await setup();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z');
    const firing = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'firing' });
    const fired = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'fired' });
    const cancelled = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'cancelled' });
    store.db
      .query('UPDATE alarms SET fired_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', fired);
    store.db
      .query('UPDATE alarms SET cancelled_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', cancelled);

    purgeExpiredData(store.db, loaded.config, new Date('2026-03-01T00:00:00.000Z'));
    const ids = [pending, firing, fired, cancelled];
    const states = store.db
      .query<{ id: bigint; state: string }, bigint[]>(
        'SELECT id, state FROM alarms WHERE id IN (?, ?, ?, ?) ORDER BY id',
      )
      .all(...ids);
    expect(states.map((row) => row.state)).toEqual(['pending', 'firing']);
    store.close();
  });
});

describe('alarm send mention', () => {
  test('retries the first target contact after a Telegram text failure', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = builder.build(alarmInvocation, 200_000, 0, 32768);

    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    let calls = 0;
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        calls += 1;
        if (calls === 1) {
          throw new GrammyError(
            'Bad Request',
            { ok: false, error_code: 400, description: 'bad request', parameters: {} } as never,
            'sendMessage',
            {},
          );
        }
        requests.push({ text, options });
        return { message_id: 500 + calls, date: 1_700_000_100 + calls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(tool.execute('fail-1', { kind: 'text', text: 'are you ok?' })).rejects.toThrow(
      'Telegram send failed: telegram_400',
    );
    await tool.execute('ok-1', { kind: 'text', text: 'are you ok now?' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toBe('@Alice are you ok now?');
    expect(requests[0]?.options.entities).toEqual([
      { type: 'text_link', offset: 0, length: 6, url: 'tg://user?id=42' },
    ]);
    expect(
      store.db
        .query<{ state: string; error_code: string | null }, []>(
          "SELECT state, error_code FROM tool_calls WHERE tool_call_id = 'fail-1'",
        )
        .get(),
    ).toEqual({ state: 'error', error_code: 'telegram_400' });
    store.close();
  });

  test('keeps MarkdownV2 parsing while adding the first-text mention', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Back\\slash!ok[test]' });
    const [alarmInvocation] = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = builder.build(alarmInvocation, 200_000, 0, 32768);

    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100 + requests.length, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      disallowBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await tool.execute('md-1', { kind: 'text', text: '*bold* ok', parse_mode: 'MarkdownV2' });
    expect(requests[0]?.text).toBe('[@Back\\\\slash\\!ok\\[test\\]](tg://user?id=42) *bold* ok');
    expect(requests[0]?.options.parse_mode).toBe('MarkdownV2');
    expect(requests[0]?.options.entities).toBeUndefined();
    store.close();
  });

  test('applies length and blank-line checks after adding the mention prefix', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations').get();
    if (conversation === null) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { displayName: 'Alice' });
    const [alarmInvocation] = scheduler.processAlarmsDue(new Date('2026-08-15T00:00:00.000Z'));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    const context = builder.build(alarmInvocation, 200_000, 0, 32768);

    let sendCalls = 0;
    const api: TelegramSendApi = {
      sendMessage: async () => {
        sendCalls += 1;
        return { message_id: 500 + sendCalls, date: 1_700_000_100 + sendCalls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: 20,
      disallowBlankLines: true,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(tool.execute('long-1', { kind: 'text', text: 'x'.repeat(20) })).rejects.toThrow('exceeds');
    await expect(tool.execute('blank-1', { kind: 'text', text: 'a\n\nb' })).rejects.toThrow('blank lines');
    expect(sendCalls).toBe(0);
    await tool.execute('ok-1', { kind: 'text', text: 'ok' });
    expect(sendCalls).toBe(1);
    store.close();
  });
});

describe('alarm admin HTTP', () => {
  test('enforces auth/Origin/method and 404/409/wake semantics for alarm routes', async () => {
    const { store, loaded } = await setupAdmin();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z');
    let wakeCalls = 0;
    const fakeScheduler = {
      wake: () => {
        wakeCalls += 1;
      },
    };
    const server = new AdminServer({
      store,
      config: loaded.config,
      scheduler: fakeScheduler as unknown as BucketScheduler,
    });
    try {
      expect((await server.handle(adminRequest('/api/alarms'))).status).toBe(401);

      const created = await server.handle(
        adminPost('/api/auth/setup', { username: 'owner', password: ADMIN_PASSWORD }),
      );
      const cookie = adminSessionCookie(created);

      const list = await readJson(await server.handle(adminRequest('/api/alarms', { headers: { cookie } })));
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        id: pending.toString(),
        chat: { telegram_chat_id: '123456789', message_thread_id: '0' },
      });

      const method = await server.handle(adminPost('/api/alarms', {}, cookie));
      expect(method.status).toBe(405);

      const missing = await server.handle(
        adminRequest('/api/alarms/999999', { method: 'DELETE', headers: { cookie } }),
      );
      expect(missing.status).toBe(404);
      expect(await readJson(missing)).toMatchObject({ error: 'not_found' });

      const crossOrigin = await server.handle(
        adminRequest(`/api/alarms/${pending}`, {
          method: 'DELETE',
          headers: { cookie, origin: 'http://evil.test' },
        }),
      );
      expect(crossOrigin.status).toBe(403);
      expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

      const cancelled = await server.handle(
        adminRequest(`/api/alarms/${pending}`, { method: 'DELETE', headers: { cookie } }),
      );
      expect(cancelled.status).toBe(200);
      expect(await readJson(cancelled)).toEqual({ status: 'cancelled' });
      expect(wakeCalls).toBe(1);

      const conflict = await server.handle(
        adminRequest(`/api/alarms/${pending}`, { method: 'DELETE', headers: { cookie } }),
      );
      expect(conflict.status).toBe(409);
      expect(await readJson(conflict)).toMatchObject({ error: 'alarm_not_pending' });
    } finally {
      store.close();
    }
  });
});

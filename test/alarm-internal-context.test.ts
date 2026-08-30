import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { createAlarmTool, createDeleteAlarmTool, createListAlarmTool } from '../src/alarm.ts';
import { loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { SqliteStore } from '../src/database.ts';
import { BucketScheduler } from '../src/scheduler.ts';
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
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-map-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.agent.history_messages = 5;
    }),
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return {
    directory,
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

function update(updateId: number, messageId: number, text: string, userId = 42): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: userId === 42 ? 'Alice' : 'Bob' },
      text,
    },
  };
}

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

function futureIso(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString();
}

function finishInvocation(store: SqliteStore, invocationId: bigint, at: string): void {
  store.db
    .query("UPDATE invocations SET state = 'completed', finished_at = ?, completion_reason = 'completed' WHERE id = ?")
    .run(at, invocationId);
  store.db
    .query(
      "UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
    )
    .run(at, at, invocationId);
}

function insertAlarm(
  store: SqliteStore,
  conversationId: bigint,
  targetUserId: bigint,
  summary: string,
  scheduledAt: string,
  createdByUserId: bigint | null = targetUserId,
): bigint {
  const created = store.db
    .query(
      `INSERT INTO alarms(conversation_id, target_user_id, created_by_user_id, target_display_name, summary,
                          scheduled_at, created_at, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      conversationId,
      targetUserId,
      createdByUserId,
      targetUserId === 42n ? 'Alice' : 'Bob',
      summary,
      scheduledAt,
      '2026-08-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    );
  return BigInt(created.lastInsertRowid);
}

describe('alarm internal context and ownership', () => {
  test('list_alarm returns only caller pending alarms, persists ordered hidden mapping, and send path does not leak it', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '我有哪些闹钟'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const conversationId = store.db
      .query<{ conversation_id: bigint }, [bigint]>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(invocationId)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected conversation');
    }
    const a1 = insertAlarm(store, conversationId, 42n, '赶高铁', '2026-08-16T04:30:00.000Z');
    const a2 = insertAlarm(store, conversationId, 42n, '吃饭', '2026-08-16T10:00:00.000Z');
    insertAlarm(store, conversationId, 99n, '别人的', '2026-08-16T08:00:00.000Z');
    store.db
      .query("UPDATE alarms SET state = 'fired', updated_at = ? WHERE id = ?")
      .run('2026-08-16T04:31:00.000Z', a1);
    const a3 = insertAlarm(store, conversationId, 42n, '开会', '2026-08-16T12:00:00.000Z');
    store.db
      .query(
        "UPDATE alarms SET state = 'cancelled', cancelled_at = ?, cancel_reason = 'test', updated_at = ? WHERE id = ?",
      )
      .run('2026-08-16T12:01:00.000Z', '2026-08-16T12:01:00.000Z', a3);
    const pending = insertAlarm(store, conversationId, 42n, '复盘', '2026-08-16T14:00:00.000Z');

    const context = builder.build(invocationId, 200_000, 0, 32768);
    expect(context.systemPrompt).not.toContain('<internal_context_history>');
    const tool = createListAlarmTool({
      store,
      context,
      runtime: {
        recordAgentMessage: (currentInvocationId, role, text) => {
          const created = store.db
            .query(
              "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, ?, ?, '', ?)",
            )
            .run(currentInvocationId, role, text, '2026-08-15T00:00:15.000Z');
          return BigInt(created.lastInsertRowid);
        },
      },
    });
    const result = await tool.execute('call-1', {});
    expect(result.details.items).toEqual([
      { id: a2.toString(), scheduled_at: '2026-08-16T10:00:00.000Z', summary: '吃饭' },
      { id: pending.toString(), scheduled_at: '2026-08-16T14:00:00.000Z', summary: '复盘' },
    ]);
    const audit = store.db
      .query<{ state: string; error_code: string | null; result_text: string | null }, [string]>(
        'SELECT state, error_code, result_text FROM tool_calls WHERE tool_call_id = ?',
      )
      .get('call-1');
    expect(audit).toEqual({
      state: 'success',
      error_code: null,
      result_text: `count=2 1:${a2.toString()}@2026-08-16T10:00:00.000Z 2:${pending.toString()}@2026-08-16T14:00:00.000Z`,
    });
    const internal = store.db
      .query<
        {
          kind: string;
          version: bigint;
          observed_at: string;
          payload_json: string;
          source_agent_message_id: bigint | null;
        },
        []
      >('SELECT kind, version, observed_at, payload_json, source_agent_message_id FROM internal_contexts')
      .get();
    expect(internal?.kind).toBe('alarm_list');
    expect(internal?.version).toBe(1n);
    expect(internal?.payload_json).toContain(`"id":"${pending.toString()}"`);
    const toolResultMessage = store.db
      .query<{ id: bigint; role: string }, []>("SELECT id, role FROM agent_messages WHERE role = 'tool_result' LIMIT 1")
      .get();
    expect(internal?.source_agent_message_id).toBe(toolResultMessage?.id ?? null);
    finishInvocation(store, invocationId, '2026-08-15T00:00:20.000Z');

    ingestion.ingest(update(2, 11, '第二个删掉'), new Date(received.getTime() + 20_000));
    const secondInvocation = processOne(scheduler, new Date(received.getTime() + 35_000));
    const secondContext = builder.build(secondInvocation, 200_000, 0, 32768);
    expect(secondContext.systemPrompt).toContain('<internal_context_history>');
    expect(secondContext.systemPrompt).toContain(
      `1. alarm_id=${a2.toString()}; scheduled_at=2026-08-16T10:00:00.000Z; summary="吃饭"`,
    );
    expect(secondContext.systemPrompt).toContain(
      `2. alarm_id=${pending.toString()}; scheduled_at=2026-08-16T14:00:00.000Z; summary="复盘"`,
    );
    expect(secondContext.userPrompt).not.toContain(pending.toString());
    expect(secondContext.userPrompt).not.toContain('internal_context_history');
    store.close();
  });

  test('Alice can list/delete alarms she created for Bob, while Bob cannot operate them', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '提醒 Bob', 42), received);
    const aliceInvocation = processOne(scheduler, new Date(received.getTime() + 15_000));
    const aliceContext = builder.build(aliceInvocation, 200_000, 0, 32768);
    const created = await createAlarmTool({ store, context: aliceContext }).execute('alice-create', {
      target_user_id: '42',
      summary: '提醒 Bob 开会',
      datetime: futureIso(7_200_000),
    });
    const listAlice = await createListAlarmTool({
      store,
      context: aliceContext,
      runtime: {
        recordAgentMessage: (currentInvocationId, role, text) => {
          const inserted = store.db
            .query(
              "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, ?, ?, '', ?)",
            )
            .run(currentInvocationId, role, text, '2026-08-15T00:00:15.000Z');
          return BigInt(inserted.lastInsertRowid);
        },
      },
    }).execute('alice-list', {});
    expect(listAlice.details.items.map((item) => item.id)).toContain(created.details.id);
    const deleted = await createDeleteAlarmTool({ store, context: aliceContext }).execute('alice-delete', {
      id: created.details.id,
    });
    expect(deleted.details.state).toBe('cancelled');
    finishInvocation(store, aliceInvocation, '2026-08-15T00:00:20.000Z');

    ingestion.ingest(update(2, 11, '我有哪些闹钟', 99), new Date(received.getTime() + 20_000));
    const bobInvocation = processOne(scheduler, new Date(received.getTime() + 35_000));
    const bobContext = builder.build(bobInvocation, 200_000, 0, 32768);
    const bobList = await createListAlarmTool({
      store,
      context: bobContext,
      runtime: {
        recordAgentMessage: (currentInvocationId, role, text) => {
          const inserted = store.db
            .query(
              "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, ?, ?, '', ?)",
            )
            .run(currentInvocationId, role, text, '2026-08-15T00:00:35.000Z');
          return BigInt(inserted.lastInsertRowid);
        },
      },
    }).execute('bob-list', {});
    expect(bobList.details.items).toEqual([]);
    await expect(
      createDeleteAlarmTool({ store, context: bobContext }).execute('bob-delete', { id: created.details.id }),
    ).rejects.toThrow('alarm not found');
    store.close();
  });

  test('delete_alarm only cancels caller own pending alarm and normalizes failures to not_found', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '删闹钟'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const conversationId = context.conversationId;
    const own = insertAlarm(store, conversationId, 42n, '自己', '2026-08-16T06:00:00.000Z', 42n);
    const other = insertAlarm(store, conversationId, 99n, '别人', '2026-08-16T07:00:00.000Z', 99n);
    const tool = createDeleteAlarmTool({ store, context });

    const ok = await tool.execute('delete-ok', { id: own.toString() });
    expect(ok.details.state).toBe('cancelled');
    expect(
      store.db
        .query<{ state: string; cancel_reason: string | null }, [bigint]>(
          'SELECT state, cancel_reason FROM alarms WHERE id = ?',
        )
        .get(own),
    ).toEqual({ state: 'cancelled', cancel_reason: 'user_requested' });

    await expect(tool.execute('delete-other', { id: other.toString() })).rejects.toThrow('alarm not found');
    await expect(tool.execute('delete-missing', { id: '999999' })).rejects.toThrow('alarm not found');
    store.db
      .query("UPDATE alarms SET state = 'fired', updated_at = ? WHERE id = ?")
      .run('2026-08-16T07:30:00.000Z', other);
    await expect(tool.execute('delete-changed', { id: other.toString() })).rejects.toThrow('alarm not found');
    const audits = store.db
      .query<{ tool_call_id: string; state: string; error_code: string | null }, []>(
        "SELECT tool_call_id, state, error_code FROM tool_calls WHERE tool_name = 'delete_alarm' ORDER BY id",
      )
      .all();
    expect(audits).toEqual([
      { tool_call_id: 'delete-ok', state: 'success', error_code: null },
      { tool_call_id: 'delete-other', state: 'error', error_code: 'alarm_not_found' },
      { tool_call_id: 'delete-missing', state: 'error', error_code: 'alarm_not_found' },
      { tool_call_id: 'delete-changed', state: 'error', error_code: 'alarm_not_found' },
    ]);
    store.close();
  });

  test('alarm uses latest new user sender as caller even with multi-user visible history', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'alice old', 42), received);
    const firstInvocation = processOne(scheduler, new Date(received.getTime() + 15_000));
    finishInvocation(store, firstInvocation, '2026-08-15T00:00:20.000Z');
    ingestion.ingest(update(2, 11, 'alice history', 42), new Date(received.getTime() + 20_000));
    ingestion.ingest(update(3, 12, 'bob latest new', 99), new Date(received.getTime() + 21_000));
    const invocationId = processOne(scheduler, new Date(received.getTime() + 36_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    expect(context.visibleSenders.size).toBe(2);
    expect(context.callerUserId).toBe(99n);
    const tool = createAlarmTool({ store, context });
    const scheduledAt = futureIso(3_600_000);
    const created = await tool.execute('create-latest-new', {
      target_user_id: '42',
      summary: 'Bob asks to remind Alice',
      datetime: scheduledAt,
    });
    expect(
      store.db
        .query<{ created_by_user_id: bigint | null; target_user_id: bigint }, [string]>(
          'SELECT created_by_user_id, target_user_id FROM alarms WHERE id = ?',
        )
        .get(created.details.id),
    ).toEqual({ created_by_user_id: 99n, target_user_id: 42n });
    store.close();
  });

  test('tools fail closed when caller identity is not reliably available from new user messages', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'seed', 42), received);
    const seedInvocation = processOne(scheduler, new Date(received.getTime() + 15_000));
    finishInvocation(store, seedInvocation, '2026-08-15T00:00:20.000Z');
    store.db
      .query(
        `INSERT INTO senders(telegram_type, telegram_id, is_bot, display_name, username, updated_at)
         VALUES ('sender_chat', 777, 0, 'Channel', NULL, ?)`,
      )
      .run('2026-08-15T00:00:20.000Z');
    ingestion.ingest(update(2, 11, 'alice', 42), new Date(received.getTime() + 20_000));
    store.db.query('UPDATE messages SET sent_by_bot = 0 WHERE telegram_message_id = 11').run();
    store.db
      .query(
        `UPDATE message_revisions
         SET sender_id = (SELECT id FROM senders WHERE telegram_type = 'sender_chat' ORDER BY id DESC LIMIT 1)
         WHERE message_id = (SELECT id FROM messages WHERE telegram_message_id = 11)
        `,
      )
      .run();
    const invocationId = processOne(scheduler, new Date(received.getTime() + 35_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const listTool = createListAlarmTool({
      store,
      context,
      runtime: {
        recordAgentMessage: (currentInvocationId, role, text) => {
          const created = store.db
            .query(
              "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, ?, ?, '', ?)",
            )
            .run(currentInvocationId, role, text, '2026-08-15T00:00:15.000Z');
          return BigInt(created.lastInsertRowid);
        },
      },
    });
    const deleteTool = createDeleteAlarmTool({ store, context });
    const alarmTool = createAlarmTool({ store, context });
    await expect(
      alarmTool.execute('alarm-closed', {
        target_user_id: '42',
        summary: 'x',
        datetime: futureIso(3_600_000),
      }),
    ).rejects.toThrow('caller identity');
    await expect(listTool.execute('list-closed', {})).rejects.toThrow('caller identity');
    await expect(deleteTool.execute('delete-closed', { id: '1' })).rejects.toThrow('caller identity');
    expect(
      store.db
        .query<{ tool_name: string; error_code: string }, []>(
          "SELECT tool_name, error_code FROM tool_calls WHERE error_code = 'alarm_caller_not_available' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { tool_name: 'alarm', error_code: 'alarm_caller_not_available' },
      { tool_name: 'list_alarm', error_code: 'alarm_caller_not_available' },
      { tool_name: 'delete_alarm', error_code: 'alarm_caller_not_available' },
    ]);
    store.close();
  });

  test('legacy alarms with nullable creator are hidden from list and delete', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '看看闹钟', 42), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const legacy = insertAlarm(store, context.conversationId, 42n, '旧闹钟', '2026-08-16T06:00:00.000Z', null);
    const list = await createListAlarmTool({
      store,
      context,
      runtime: {
        recordAgentMessage: (currentInvocationId, role, text) => {
          const created = store.db
            .query(
              "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, ?, ?, '', ?)",
            )
            .run(currentInvocationId, role, text, '2026-08-15T00:00:15.000Z');
          return BigInt(created.lastInsertRowid);
        },
      },
    }).execute('legacy-list', {});
    expect(list.details.items).toEqual([]);
    await expect(
      createDeleteAlarmTool({ store, context }).execute('legacy-delete', { id: legacy.toString() }),
    ).rejects.toThrow('alarm not found');
    store.close();
  });

  test('internal context survives close and reopen and retention removes it with online window', async () => {
    const { directory, loaded, store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '列出闹钟'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    insertAlarm(store, context.conversationId, 42n, '持久化', '2026-08-16T06:00:00.000Z');
    const tool = createListAlarmTool({
      store,
      context,
      runtime: {
        recordAgentMessage: (currentInvocationId, role, text) => {
          const created = store.db
            .query(
              "INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, 1, ?, ?, '', ?)",
            )
            .run(currentInvocationId, role, text, '2026-08-15T00:00:15.000Z');
          return BigInt(created.lastInsertRowid);
        },
      },
    });
    await tool.execute('persist', {});
    finishInvocation(store, invocationId, '2026-08-15T00:00:20.000Z');
    store.close();

    const reopened = await SqliteStore.open(loaded.config, false);
    const secondBuilder = new ContextBuilder(reopened, loaded.config);
    const reopenedIngestion = new TelegramIngestion(reopened, loaded.config, { id: 999 });
    reopenedIngestion.ingest(update(2, 11, '第二个'), new Date(received.getTime() + 20_000));
    const secondScheduler = new BucketScheduler(reopened, loaded.config, loaded.hash, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const secondInvocation = processOne(secondScheduler, new Date(received.getTime() + 35_000));
    const secondContext = secondBuilder.build(secondInvocation, 200_000, 0, 32768);
    expect(secondContext.systemPrompt).toContain('alarm_id=');
    reopened.close();

    const reopenedForPurge = await SqliteStore.open(loaded.config, false);
    const { purgeExpiredData } = await import('../src/database.ts');
    purgeExpiredData(reopenedForPurge.db, loaded.config, new Date('2026-10-01T00:00:00.000Z'));
    expect(
      reopenedForPurge.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM internal_contexts').get()?.count,
    ).toBe(0n);
    reopenedForPurge.close();
    expect(await Bun.file(join(directory, 'config.jsonc')).exists()).toBe(true);
  });
});

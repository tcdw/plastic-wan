import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import { Compile } from 'typebox/compile';
import { loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { SqliteStore } from '../src/database.ts';
import { MemoryStore } from '../src/memory.ts';
import { BucketScheduler } from '../src/scheduler.ts';
import { createSendTool, type TelegramSendApi } from '../src/send-tool.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup(): Promise<{
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  builder: ContextBuilder;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-context-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return {
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999 }),
    scheduler: new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
      state: 'completed',
      reason: 'done',
    })),
    builder: new ContextBuilder(store, loaded.config),
  };
}

function update(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
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

describe('invocation context', () => {
  test('uses twenty prior Telegram messages and separates the current bucket', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    let latestInvocation = 0n;
    for (let index = 0; index < 22; index += 1) {
      const received = new Date(start.getTime() + index * 20_000);
      ingestion.ingest(update(index + 1, index + 1, `message-${index}`), received);
      latestInvocation = processOne(scheduler, new Date(received.getTime() + 15_000));
      store.db
        .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(latestInvocation);
      store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(latestInvocation);
    }
    const counts = store.db
      .query<{ section: string; count: bigint }, [bigint]>(
        'SELECT section, COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? GROUP BY section ORDER BY section',
      )
      .all(latestInvocation);
    expect(counts).toEqual([
      { section: 'history', count: 20n },
      { section: 'new', count: 1n },
    ]);
    store.close();
  });

  test('renders agent templates from the effective model without templating memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-context-template-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      'agent={{ agent.provider }}/{{ agent.model }} vision={{ vision.provider }}/{{ vision.model }}',
      'chat={{ agent.model }}',
    );
    const loaded = await loadConfig(configPath);
    const store = await SqliteStore.open(loaded.config);
    const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
    const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const memory = new MemoryStore(store.db);
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 1, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db
      .query<{ conversation_id: bigint }, [bigint]>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(invocationId);
    if (conversation === null) {
      throw new Error('Expected invocation conversation');
    }
    memory.add(conversation.conversation_id, '{{ agent.model }}', 86_400);
    const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0, 32768, false, {
      provider: 'runtime',
      model: 'runtime-model',
    });
    expect(context.systemPrompt).toContain('agent=runtime/runtime-model vision=vision/vision-model');
    expect(context.systemPrompt).toContain('chat=runtime-model');
    expect(context.systemPrompt).toContain('- mem_');
    expect(context.systemPrompt).toContain('{{ agent.model }}');
    store.close();
  });
});

describe('send tool', () => {
  test('sends plain text and MarkdownV2 while auditing Telegram-visible history', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const requests: Array<{ text: string; options: Parameters<TelegramSendApi['sendMessage']>[2] }> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text, options) => {
        requests.push({ text, options });
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 503, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      disallowConsecutiveBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    expect(Compile(tool.parameters).Check({ text: 'world', reply_to_message_id: '10' })).toBe(true);
    expect(Compile(tool.parameters).Check({ text: '*formatted*', parse_mode: 'MarkdownV2' })).toBe(true);
    expect(Compile(tool.parameters).Check({ text: '<b>formatted</b>', parse_mode: 'HTML' })).toBe(false);
    await tool.execute('call-1', { text: 'world', reply_to_message_id: '10' });
    await tool.execute('call-2', { text: '*formatted*', parse_mode: 'MarkdownV2' });
    expect(requests).toEqual([
      { text: 'world', options: { reply_parameters: { message_id: 10 } } },
      { text: '*formatted*', options: { parse_mode: 'MarkdownV2' } },
    ]);
    const audits = store.db
      .query<{ tool_state: string; send_state: string; sent_by_bot: bigint; text: string }, []>(
        'SELECT tc.state AS tool_state, ts.state AS send_state, m.sent_by_bot, r.text FROM tool_calls tc JOIN telegram_sends ts ON ts.tool_call_id = tc.id JOIN messages m ON m.telegram_message_id = ts.telegram_message_id JOIN message_revisions r ON r.id = m.current_revision_id ORDER BY tc.id',
      )
      .all();
    expect(audits).toEqual([
      { tool_state: 'success', send_state: 'success', sent_by_bot: 1n, text: 'world' },
      { tool_state: 'success', send_state: 'success', sent_by_bot: 1n, text: '*formatted*' },
    ]);
    store.close();
  });

  test('rejects and audits a reply outside visible context', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const api: TelegramSendApi = {
      sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      disallowConsecutiveBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(tool.execute('call-1', { kind: 'text', text: 'world', reply_to_message_id: '9999' })).rejects.toThrow(
      'not visible',
    );
    const row = store.db
      .query<{ state: string; error_code: string }, []>('SELECT state, error_code FROM tool_calls')
      .get();
    expect(row).toEqual({ state: 'error', error_code: 'reply_not_visible' });
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(0n);
    store.close();
  });
  test('enforces six sends and does not retry an unknown network outcome', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    let successfulCalls = 0;
    const successApi: TelegramSendApi = {
      sendMessage: async () => {
        successfulCalls += 1;
        return { message_id: 500 + successfulCalls, date: 1_700_000_100 + successfulCalls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const quotaTool = createSendTool({
      store,
      api: successApi,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      disallowConsecutiveBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    for (let index = 0; index < 6; index += 1) {
      await quotaTool.execute(`quota-${index}`, { kind: 'text', text: `message-${index}` });
    }
    await expect(quotaTool.execute('quota-6', { kind: 'text', text: 'seventh' })).rejects.toThrow('send limit');
    expect(successfulCalls).toBe(6);

    store.db
      .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(invocationId);
    store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);

    const secondReceived = new Date(received.getTime() + 20_000);
    ingestion.ingest(update(2, 11, 'next'), secondReceived);
    const secondInvocation = processOne(scheduler, new Date(secondReceived.getTime() + 15_000));
    const secondContext = builder.build(secondInvocation, 200_000, 0, 32768);
    let unknownCalls = 0;
    const unknownApi: TelegramSendApi = {
      sendMessage: async () => {
        unknownCalls += 1;
        throw new HttpError('network failed', new Error('socket closed'));
      },
      sendSticker: async () => ({ message_id: 700, date: 1_700_000_300, chat: { id: 123456789 } }),
    };
    const unknownTool = createSendTool({
      store,
      api: unknownApi,
      context: secondContext,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      disallowConsecutiveBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(unknownTool.execute('unknown-1', { kind: 'text', text: 'uncertain' })).rejects.toThrow(
      'outcome is unknown',
    );
    expect(unknownCalls).toBe(1);
    expect(
      store.db
        .query<{ state: string }, []>(
          'SELECT state FROM telegram_sends WHERE id = (SELECT MAX(id) FROM telegram_sends)',
        )
        .get()?.state,
    ).toBe('outcome_unknown');
    store.close();
  });

  test('rejects text above the configured length limit without consuming send quota', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    let sendMessageCalls = 0;
    const api: TelegramSendApi = {
      sendMessage: async () => {
        sendMessageCalls += 1;
        return { message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: 5,
      disallowConsecutiveBlankLines: false,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    });
    await expect(tool.execute('call-1', { kind: 'text', text: 'too long' })).rejects.toThrow(
      'exceeds the configured limit of 5 characters',
    );
    expect(sendMessageCalls).toBe(0);
    const row = store.db
      .query<{ state: string; error_code: string; arguments_json: string }, []>(
        'SELECT state, error_code, arguments_json FROM tool_calls',
      )
      .get();
    expect(row?.state).toBe('error');
    expect(row?.error_code).toBe('send_text_too_long');
    expect(JSON.parse(row?.arguments_json ?? '{}')).toEqual({ kind: 'text', text: 'too long' });
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count).toBe(0n);
    const used = store.db
      .query<{ sends_used: bigint }, [bigint]>('SELECT sends_used FROM invocations WHERE id = ?')
      .get(invocationId);
    expect(used?.sends_used).toBe(0n);
    await tool.execute('call-2', { kind: 'text', text: 'ok' });
    expect(sendMessageCalls).toBe(1);
    store.close();
  });

  test('rejects consecutive blank lines only when the restriction is enabled', async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const requests: string[] = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, text) => {
        requests.push(text);
        return { message_id: 500 + requests.length, date: 1_700_000_100, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const base = {
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      maxTextLength: undefined,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    };
    const permissive = createSendTool({ ...base, disallowConsecutiveBlankLines: false });
    await permissive.execute('call-1', { kind: 'text', text: 'a\n\n\nb' });
    expect(requests).toEqual(['a\n\n\nb']);
    const strict = createSendTool({ ...base, disallowConsecutiveBlankLines: true });
    await expect(strict.execute('call-2', { kind: 'text', text: 'a\n\n\nb' })).rejects.toThrow(
      'two or more consecutive blank lines',
    );
    await expect(strict.execute('call-3', { kind: 'text', text: 'a\n  \n\nb' })).rejects.toThrow(
      'two or more consecutive blank lines',
    );
    await strict.execute('call-4', { kind: 'text', text: 'a\n\nb' });
    await strict.execute('call-5', { kind: 'text', text: 'a\n b \nc' });
    expect(requests).toEqual(['a\n\n\nb', 'a\n\nb', 'a\n b \nc']);
    const rejected = store.db
      .query<{ tool_call_id: string; error_code: string }, []>(
        "SELECT tool_call_id, error_code FROM tool_calls WHERE error_code = 'send_consecutive_blank_lines' ORDER BY tool_call_id",
      )
      .all();
    expect(rejected).toEqual([
      { tool_call_id: 'call-2', error_code: 'send_consecutive_blank_lines' },
      { tool_call_id: 'call-3', error_code: 'send_consecutive_blank_lines' },
    ]);
    store.close();
  });
});

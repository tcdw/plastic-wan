import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { type FileConfig, loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { SqliteStore } from '../src/database.ts';
import { BucketScheduler, STARTUP_CATCH_UP_STATE_KEY } from '../src/scheduler.ts';
import { createSendTool, type TelegramSendApi } from '../src/send-tool.ts';
import { runStartupCatchUp, type StartupCatchUpApi } from '../src/startup-catch-up.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

const FIRST_CHAT_ID = 123456789;
const SECOND_CHAT_ID = 987654321;

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function topicUpdate(updateId: number, messageId: number, chatId: number, threadId: number, date: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      message_thread_id: threadId,
      is_topic_message: true,
      date,
      chat: { id: chatId, type: 'supergroup', title: `Chat ${chatId}`, is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `chat-${chatId}-message-${messageId}`,
    },
  };
}

function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: FIRST_CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      sticker: {
        file_id: `sticker-${messageId}`,
        file_unique_id: `sticker-unique-${messageId}`,
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
}

function fakeApi(updates: readonly Update[]): StartupCatchUpApi {
  return {
    getUpdates: async (options) =>
      updates
        .filter((update) => options.offset === undefined || update.update_id >= options.offset)
        .slice(0, options.limit),
  };
}

async function setup(
  twoChats: boolean,
  transform?: (config: FileConfig) => void,
): Promise<{
  readonly store: SqliteStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly builder: ContextBuilder;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-startup-catch-up-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.agent.history_messages = 10;
    if (twoChats) {
      config.telegram.chats.push({
        id: SECOND_CHAT_ID,
        instructions_file: 'chat-instructions.md',
        budget: { max_invocations_per_day: 100 },
      });
    }
    transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
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

function fixedClock(): () => Date {
  let milliseconds = Date.parse('2026-08-17T03:00:00.000Z');
  return () => new Date(milliseconds++);
}

describe('startup catch-up', () => {
  test('creates one invocation per chat with the configured latest messages', async () => {
    const { store, ingestion, scheduler } = await setup(true);
    const updates: Update[] = [];
    for (let index = 0; index < 15; index += 1) {
      updates.push(topicUpdate(index * 2 + 1, index + 1, FIRST_CHAT_ID, 100 + index, 1_700_000_000 + index));
      updates.push(topicUpdate(index * 2 + 2, index + 101, SECOND_CHAT_ID, 200 + index, 1_700_000_000 + index));
    }
    const result = await runStartupCatchUp({
      api: fakeApi(updates),
      store,
      ingestion,
      scheduler,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    expect(result.updates).toBe(30);
    expect(result.invocationIds).toHaveLength(2);
    const buckets = store.db
      .query<{ kind: string; state: string; count: bigint }, []>(
        'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state',
      )
      .all();
    expect(buckets).toEqual([{ kind: 'startup_catch_up', state: 'queued', count: 2n }]);
    const snapshots = store.db
      .query<{ chat_id: bigint; section: string; count: bigint; first_message: bigint; last_message: bigint }, []>(
        `SELECT c.telegram_chat_id AS chat_id, im.section, COUNT(*) AS count,
                MIN(m.telegram_message_id) AS first_message, MAX(m.telegram_message_id) AS last_message
         FROM invocation_messages im
         JOIN invocations i ON i.id = im.invocation_id
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         JOIN messages m ON m.id = im.message_id
         GROUP BY c.telegram_chat_id, im.section
         ORDER BY c.telegram_chat_id`,
      )
      .all();
    expect(snapshots).toEqual([
      { chat_id: BigInt(FIRST_CHAT_ID), section: 'new', count: 10n, first_message: 6n, last_message: 15n },
      { chat_id: BigInt(SECOND_CHAT_ID), section: 'new', count: 10n, first_message: 106n, last_message: 115n },
    ]);
    expect(store.db.query('SELECT value FROM app_state WHERE key = ?').get(STARTUP_CATCH_UP_STATE_KEY)).toBeNull();
    store.close();
  });

  test('applies sticker_trigger_enabled to startup catch-up invocations', async () => {
    const disabled = await setup(false);
    const disabledResult = await runStartupCatchUp({
      api: fakeApi([stickerUpdate(1, 10)]),
      store: disabled.store,
      ingestion: disabled.ingestion,
      scheduler: disabled.scheduler,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(disabledResult.storedMessages).toBe(1);
    expect(disabledResult.invocationIds).toHaveLength(0);
    disabled.store.close();

    const enabled = await setup(false, (config) => {
      config.telegram.sticker_trigger_enabled = true;
    });
    const enabledResult = await runStartupCatchUp({
      api: fakeApi([stickerUpdate(1, 10)]),
      store: enabled.store,
      ingestion: enabled.ingestion,
      scheduler: enabled.scheduler,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    expect(enabledResult.invocationIds).toHaveLength(1);
    enabled.store.close();
  });

  test('switches to realtime buckets after draining pending updates', async () => {
    const { store, ingestion, scheduler } = await setup(false);
    await runStartupCatchUp({
      api: fakeApi([topicUpdate(1, 10, FIRST_CHAT_ID, 100, 1_700_000_000)]),
      store,
      ingestion,
      scheduler,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });

    const live = ingestion.ingest(
      topicUpdate(2, 11, FIRST_CHAT_ID, 200, 1_700_000_100),
      new Date('2026-08-17T03:01:00.000Z'),
    );
    expect(live.bucketId).toBeDefined();
    const states = store.db
      .query<{ kind: string; state: string; count: bigint }, []>(
        'SELECT kind, state, COUNT(*) AS count FROM buckets GROUP BY kind, state ORDER BY kind',
      )
      .all();
    expect(states).toEqual([
      { kind: 'realtime', state: 'collecting', count: 1n },
      { kind: 'startup_catch_up', state: 'queued', count: 1n },
    ]);
    store.close();
  });

  test('routes replies to the visible message topic', async () => {
    const { store, ingestion, scheduler, builder } = await setup(false);
    const result = await runStartupCatchUp({
      api: fakeApi([
        topicUpdate(1, 10, FIRST_CHAT_ID, 100, 1_700_000_000),
        topicUpdate(2, 11, FIRST_CHAT_ID, 200, 1_700_000_001),
      ]),
      store,
      ingestion,
      scheduler,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: fixedClock(),
    });
    const invocationId = result.invocationIds[0];
    if (invocationId === undefined) {
      throw new Error('Expected startup catch-up invocation');
    }
    const context = builder.build(invocationId, 200_000, 0, 32768);
    const sentThreads: Array<number | undefined> = [];
    const api: TelegramSendApi = {
      sendMessage: async (_chatId, _text, options) => {
        sentThreads.push(options.message_thread_id);
        return { message_id: 500 + sentThreads.length, date: 1_700_000_100, chat: { id: FIRST_CHAT_ID } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: FIRST_CHAT_ID } }),
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

    await tool.execute('reply-old-topic', { kind: 'text', text: 'old', reply_to_message_id: '10' });
    await tool.execute('default-latest-topic', { kind: 'text', text: 'latest' });
    expect(sentThreads).toEqual([100, 200]);
    expect(context.userPrompt).toContain('"message_thread_id":"100"');
    expect(context.userPrompt).toContain('"message_thread_id":"200"');
    const outgoingThreads = store.db
      .query<{ message_thread_id: bigint }, []>(
        'SELECT v.message_thread_id FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE m.sent_by_bot = 1 ORDER BY m.id',
      )
      .all()
      .map((row) => row.message_thread_id);
    expect(outgoingThreads).toEqual([100n, 200n]);
    store.close();
  });
});

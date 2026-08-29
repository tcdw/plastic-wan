import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { seedConfigAdmins } from '../src/admin/admins.ts';
import { BotCommandService } from '../src/bot-commands.ts';
import { type LoadedConfig, loadConfig } from '../src/config.ts';
import { SqliteStore } from '../src/database.ts';
import { BucketScheduler } from '../src/scheduler.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const ALICE = { id: 42n, name: 'Alice', username: 'alice' };
const FIRST_CHAT = 123456789n;
const SECOND_CHAT = 987654321n;
const BUCKET_WINDOW_MS = 15_000;

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

function groupUpdate(updateId: number, messageId: number, text: string, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function commandUpdate(updateId: number, messageId: number, chatId: bigint): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: Number(chatId), type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/cut_topic',
      entities: [{ offset: 0, length: 10, type: 'bot_command' }],
    },
  };
}

async function setup(): Promise<{
  loaded: LoadedConfig;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  commands: BotCommandService;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-cut-topic-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.admins = [42];
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.id = Number(FIRST_CHAT);
      config.telegram.chats.push({
        id: Number(SECOND_CHAT),
        instructions_file: 'chat-instructions.md',
        budget: { max_invocations_per_day: 100 },
      });
    }),
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  seedConfigAdmins(store.db, loaded.config.telegram.admins ?? []);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  return {
    loaded,
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999, username: 'plasticwan_test_bot' }),
    scheduler,
    commands: new BotCommandService(store, loaded.config, scheduler),
  };
}

function completeInvocation(store: SqliteStore, invocationId: bigint, at: Date): void {
  store.db
    .query("UPDATE invocations SET state = 'completed', started_at = ?, finished_at = ? WHERE id = ?")
    .run(new Date(at.getTime() - 1_000).toISOString(), at.toISOString(), invocationId);
  store.db
    .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
}

function chatOfInvocation(store: SqliteStore, invocationId: bigint): bigint | undefined {
  return store.db
    .query<{ chat_id: bigint }, [bigint]>(
      'SELECT c.telegram_chat_id AS chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id JOIN chats c ON c.id = v.chat_id WHERE i.id = ?',
    )
    .get(invocationId)?.chat_id;
}

/**
 * Queues and completes every due bucket (mirroring the runtime pacing), then
 * ingests the trigger message, runs its invocation to completion and returns
 * the frozen history texts of that invocation.
 */
function invocationHistory(
  store: SqliteStore,
  ingestion: TelegramIngestion,
  scheduler: BucketScheduler,
  chatId: bigint,
  updateId: number,
  messageId: number,
  text: string,
  at: Date,
): string[] {
  const flushAt = new Date(at.getTime() - 1);
  for (const invocationId of scheduler.processDue(flushAt)) {
    completeInvocation(store, invocationId, flushAt);
  }
  ingestion.ingest(groupUpdate(updateId, messageId, text, chatId), at);
  const queued = scheduler.processDue(new Date(at.getTime() + BUCKET_WINDOW_MS + 1_000));
  if (queued.length === 0) {
    throw new Error(`Expected a queued invocation for chat ${chatId}`);
  }
  let invocationId: bigint | undefined;
  for (const id of queued) {
    completeInvocation(store, id, new Date(at.getTime() + BUCKET_WINDOW_MS + 2_000));
    if (chatOfInvocation(store, id) === chatId) {
      invocationId = id;
    }
  }
  if (invocationId === undefined) {
    throw new Error(`No queued invocation found for chat ${chatId}`);
  }
  return store.db
    .query<{ snapshot_json: string }, [bigint]>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no",
    )
    .all(invocationId)
    .map((row) => (JSON.parse(row.snapshot_json) as { text: string | null }).text ?? '');
}

describe('cut_topic', () => {
  test('without a cutoff, history includes earlier messages unchanged', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'old', FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 11, 'later', FIRST_CHAT), new Date(start.getTime() + 1_000));
    const history = invocationHistory(
      store,
      ingestion,
      scheduler,
      FIRST_CHAT,
      3,
      12,
      'trigger',
      new Date(start.getTime() + BUCKET_WINDOW_MS + 1_000),
    );
    expect(history).toEqual(['old', 'later']);
    store.close();
  });

  test('cut_topic excludes the command message and everything before it from new invocations', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 11, 'still old', FIRST_CHAT), new Date(start.getTime() + 1_000));
    const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date(start.getTime() + 2_000)).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 12n });
    expect(commands.run(command!, FIRST_CHAT, ALICE)).toContain('已切掉');
    expect(
      store.db.query<{ telegram_message_id: bigint }, []>('SELECT telegram_message_id FROM chat_context_cutoffs').get()
        ?.telegram_message_id,
    ).toBe(12n);

    const history = invocationHistory(
      store,
      ingestion,
      scheduler,
      FIRST_CHAT,
      4,
      13,
      'after cut',
      new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
    );
    expect(history).toEqual([]);
    store.close();
  });

  test('messages after the cutoff remain and re-running cut_topic moves the cutoff forward', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);

    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), at(0));
    const first = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), at(1)).command;
    commands.run(first!, FIRST_CHAT, ALICE);

    // After the first cut, the trigger itself is the only eligible message and
    // sits in its own bucket, so the frozen history is empty.
    expect(invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 3, 12, 'fresh start', at(17))).toEqual([]);

    const second = ingestion.ingest(commandUpdate(4, 13, FIRST_CHAT), at(34)).command;
    commands.run(second!, FIRST_CHAT, ALICE);
    expect(
      store.db.query<{ telegram_message_id: bigint }, []>('SELECT telegram_message_id FROM chat_context_cutoffs').get()
        ?.telegram_message_id,
    ).toBe(13n);

    // A message arriving after the second cut stays eligible for later sessions.
    ingestion.ingest(groupUpdate(5, 14, 'between', FIRST_CHAT), at(50));
    expect(invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 6, 15, 'new topic', at(66))).toEqual(['between']);
    store.close();
  });

  test('the cutoff only affects its own chat', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, `polluted ${FIRST_CHAT}`, FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 10, `polluted ${SECOND_CHAT}`, SECOND_CHAT), start);
    const command = ingestion.ingest(commandUpdate(3, 11, FIRST_CHAT), new Date(start.getTime() + 1_000)).command;
    commands.run(command!, FIRST_CHAT, ALICE);
    expect(
      store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chat_context_cutoffs').get()?.count,
    ).toBe(1n);

    expect(
      invocationHistory(
        store,
        ingestion,
        scheduler,
        FIRST_CHAT,
        4,
        12,
        'trigger',
        new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
      ),
    ).toEqual([]);
    expect(
      invocationHistory(
        store,
        ingestion,
        scheduler,
        SECOND_CHAT,
        5,
        13,
        'trigger',
        new Date(start.getTime() + 2 * BUCKET_WINDOW_MS + 4_000),
      ),
    ).toEqual([`polluted ${SECOND_CHAT}`]);
    store.close();
  });

  test('non-admin senders are denied and no cutoff row is written', async () => {
    const { store, ingestion, commands } = await setup();
    const command = ingestion.ingest(commandUpdate(1, 10, FIRST_CHAT), new Date()).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 10n });
    expect(commands.run(command!, FIRST_CHAT, { id: 99n, name: 'Mallory', username: 'mallory' })).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    expect(
      store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chat_context_cutoffs').get()?.count,
    ).toBe(0n);
    store.close();
  });

  test('the cutoff survives scheduler and command service recreation', async () => {
    const { store, loaded, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    const command = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), new Date(start.getTime() + 1_000)).command;
    commands.run(command!, FIRST_CHAT, ALICE);
    await scheduler.stop();

    const reopened = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const recreatedCommands = new BotCommandService(store, loaded.config, reopened);
    expect(
      store.db.query<{ telegram_message_id: bigint }, []>('SELECT telegram_message_id FROM chat_context_cutoffs').get()
        ?.telegram_message_id,
    ).toBe(11n);
    recreatedCommands.run({ name: 'cut_topic', messageId: 20n }, FIRST_CHAT, ALICE);
    expect(
      store.db.query<{ telegram_message_id: bigint }, []>('SELECT telegram_message_id FROM chat_context_cutoffs').get()
        ?.telegram_message_id,
    ).toBe(20n);
    expect(
      invocationHistory(
        store,
        ingestion,
        reopened,
        FIRST_CHAT,
        3,
        21,
        'trigger',
        new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
      ),
    ).toEqual([]);
    await reopened.stop();
    store.close();
  });
});

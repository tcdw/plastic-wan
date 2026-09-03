import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  Bun.gc(true);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup(
  transform?: (config: FileConfig) => void,
): Promise<{ store: SqliteStore; ingestion: TelegramIngestion }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-ingest-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const { config } = await loadConfig(configPath);
  const store = await SqliteStore.open(config);
  return { store, ingestion: new TelegramIngestion(store, config, { id: 999 }) };
}

function textUpdate(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function groupTextUpdate(updateId: number, messageId: number, senderId: number, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'supergroup', title: 'Group' },
      from: { id: senderId, is_bot: false, first_name: `User ${senderId}` },
      text: `message from ${senderId}`,
    },
  };
}

function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
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

describe('Telegram ingestion', () => {
  test('stores denied metadata without content', async () => {
    const { store, ingestion } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'private text', 777));
    const row = store.db
      .query<{ raw_json: string | null; rejection_reason: string }, []>(
        'SELECT raw_json, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(row).toEqual({ raw_json: null, rejection_reason: 'chat_not_allowed' });
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    store.close();
  });

  test('uses the configured window and preserves the first deadline', async () => {
    const { store, ingestion } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const firstTime = new Date('2026-08-15T00:00:00.000Z');
    const first = ingestion.ingest(textUpdate(1, 10, 'first'), firstTime);
    const duplicate = ingestion.ingest(textUpdate(1, 10, 'first'), firstTime);
    const second = ingestion.ingest(textUpdate(2, 11, 'second'), new Date(firstTime.getTime() + 5_000));
    expect(duplicate.messageId).toBeUndefined();
    expect(first.bucketId).toBe(second.bucketId);
    const bucket = store.db
      .query<{ deadline_at: string; messages: bigint }, []>(
        'SELECT b.deadline_at, COUNT(bm.message_id) AS messages FROM buckets b JOIN bucket_messages bm ON bm.bucket_id = b.id GROUP BY b.id',
      )
      .get();
    expect(bucket).toEqual({ deadline_at: '2026-08-15T00:00:06.000Z', messages: 2n });
    store.close();
  });

  test('edits append revisions without creating or extending buckets', async () => {
    const { store, ingestion } = await setup();
    const receivedAt = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), receivedAt);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_005,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(receivedAt.getTime() + 5_000));
    const row = store.db
      .query<{ revisions: bigint; text: string; buckets: bigint }, []>(
        'SELECT (SELECT COUNT(*) FROM message_revisions) AS revisions, r.text, (SELECT COUNT(*) FROM buckets) AS buckets FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id',
      )
      .get();
    expect(row).toEqual({ revisions: 2n, text: 'after', buckets: 1n });
    store.close();
  });

  test('bot and service messages cannot trigger collection', async () => {
    const { store, ingestion } = await setup();
    const botUpdate = textUpdate(1, 10, 'bot');
    if (botUpdate.message === undefined || botUpdate.message.from === undefined) {
      throw new Error('Invalid fixture');
    }
    botUpdate.message.from.is_bot = true;
    botUpdate.message.from.id = 500;
    const serviceUpdate: Update = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        new_chat_members: [{ id: 43, is_bot: false, first_name: 'Bob' }],
      },
    };
    ingestion.ingest(botUpdate);
    ingestion.ingest(serviceUpdate);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    store.close();
  });

  test('drops ignored users before commands, storage, and bucket collection', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const trigger = ingestion.ingest(groupTextUpdate(1, 10, 7));
    const ignored = ingestion.ingest(groupTextUpdate(2, 11, 42));
    const commandUpdate = groupTextUpdate(3, 12, 42);
    if (commandUpdate.message === undefined) {
      throw new Error('Invalid fixture');
    }
    commandUpdate.message.text = '/pause';
    commandUpdate.message.entities = [{ type: 'bot_command', offset: 0, length: 6 }];
    const ignoredCommand = ingestion.ingest(commandUpdate);
    const replyUpdate = groupTextUpdate(4, 13, 7);
    if (replyUpdate.message === undefined) {
      throw new Error('Invalid fixture');
    }
    replyUpdate.message.text = 'reply from 7';
    replyUpdate.message.reply_to_message = {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'User 42' },
      text: 'message from 42',
      reply_to_message: undefined as never,
    };
    ingestion.ingest(replyUpdate);

    expect(trigger.bucketId).toBeDefined();
    expect(ignored).toEqual({});
    expect(ignoredCommand).toEqual({});
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM telegram_updates').get()?.count).toBe(
      4n,
    );
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM senders').get()?.count).toBe(1n);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count).toBe(
      2n,
    );
    expect(
      store.db
        .query<{ reply_to_message_id: bigint | null; reply_snapshot_json: string | null }, [string]>(
          'SELECT reply_to_message_id, reply_snapshot_json FROM message_revisions WHERE text = ?',
        )
        .get('reply from 7'),
    ).toEqual({ reply_to_message_id: null, reply_snapshot_json: null });
    store.close();
  });

  test('drops edits from ignored users without changing a stored message', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    ingestion.ingest(groupTextUpdate(1, 10, 7));
    const ignoredEdit = groupTextUpdate(2, 10, 42);
    if (ignoredEdit.message === undefined) {
      throw new Error('Invalid fixture');
    }
    const editedMessage = ignoredEdit.message;
    const editedUpdate: Update = {
      update_id: ignoredEdit.update_id,
      edited_message: { ...editedMessage, text: 'ignored edit', edit_date: 1_700_000_010 },
    };
    expect(ingestion.ingest(editedUpdate)).toEqual({});
    expect(
      store.db
        .query<{ revisions: bigint; text: string }, []>(
          'SELECT COUNT(*) AS revisions, MAX(text) AS text FROM message_revisions',
        )
        .get(),
    ).toEqual({ revisions: 1n, text: 'message from 7' });
    store.close();
  });

  test('scopes ignored users to the configured chat and not sender_chat identities', async () => {
    const secondChatId = 987654321;
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
      config.telegram.chats.push({
        id: secondChatId,
        budget: { max_invocations_per_day: 100 },
      });
    });
    expect(ingestion.ingest(groupTextUpdate(1, 10, 42))).toEqual({});
    expect(ingestion.ingest(groupTextUpdate(2, 11, 42, secondChatId)).bucketId).toBeDefined();
    const senderChatUpdate: Update = {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 42, is_bot: false, first_name: 'Anonymous sender' },
        sender_chat: { id: 42, type: 'channel', title: 'Channel identity' },
        text: 'sender chat message',
      },
    };
    expect(ingestion.ingest(senderChatUpdate).messageId).toBeDefined();
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    store.close();
  });

  test('inherits ignored users after a group migrates to a supergroup', async () => {
    const migratedChatId = -1001234567890;
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const migration = groupTextUpdate(1, 10, 7);
    if (migration.message === undefined) {
      throw new Error('Invalid fixture');
    }
    migration.message.chat = { id: 123456789, type: 'group', title: 'Old group' };
    migration.message.migrate_to_chat_id = migratedChatId;
    ingestion.ingest(migration);

    expect(ingestion.ingest(groupTextUpdate(2, 11, 42, migratedChatId))).toEqual({});
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('requires sticker_trigger_enabled for a sticker to open a bucket', async () => {
    const disabled = await setup();
    const standalone = disabled.ingestion.ingest(stickerUpdate(1, 10));
    expect(standalone.messageId).toBeDefined();
    expect(standalone.bucketId).toBeUndefined();
    expect(disabled.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(
      0n,
    );
    const text = disabled.ingestion.ingest(textUpdate(2, 11, 'hello'));
    const companion = disabled.ingestion.ingest(stickerUpdate(3, 12));
    expect(companion.bucketId).toBe(text.bucketId);
    expect(
      disabled.store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count,
    ).toBe(2n);
    disabled.store.close();

    const enabled = await setup((config) => {
      config.telegram.sticker_trigger_enabled = true;
    });
    expect(enabled.ingestion.ingest(stickerUpdate(4, 20)).bucketId).toBeDefined();
    enabled.store.close();
  });

  test('keeps ordinary supergroup reply threads in the main conversation', async () => {
    const { store, ingestion } = await setup();
    const chat = { id: 123456789, type: 'supergroup' as const, title: 'Group' };
    const sender = { id: 42, is_bot: false, first_name: 'Alice' };
    const rootMessage = {
      message_id: 10,
      date: 1_700_000_000,
      chat,
      from: sender,
      text: 'root',
    };
    const first = ingestion.ingest({ update_id: 1, message: rootMessage });
    const second = ingestion.ingest({
      update_id: 2,
      message: {
        message_id: 11,
        message_thread_id: 10,
        date: 1_700_000_001,
        chat,
        from: sender,
        text: 'reply',
      },
    });
    expect(second.bucketId).toBe(first.bucketId);
    expect(
      store.db
        .query<{ conversations: bigint; thread_id: bigint; messages: bigint }, []>(
          `SELECT COUNT(DISTINCT v.id) AS conversations, MAX(v.message_thread_id) AS thread_id,
                  COUNT(bm.message_id) AS messages
           FROM conversations v
           JOIN buckets b ON b.conversation_id = v.id
           JOIN bucket_messages bm ON bm.bucket_id = b.id`,
        )
        .get(),
    ).toEqual({ conversations: 1n, thread_id: 0n, messages: 2n });
    store.close();
  });

  test('isolates allowed forum topics and rejects unconfigured topics', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.topic_ids = [100, 200];
    });
    const topicUpdate = (updateId: number, messageId: number, threadId: number): Update => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        message_thread_id: threadId,
        is_topic_message: true,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: `topic-${threadId}`,
      },
    });
    ingestion.ingest(topicUpdate(1, 10, 100));
    ingestion.ingest(topicUpdate(2, 11, 200));
    ingestion.ingest(topicUpdate(3, 12, 300));
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM conversations').get()?.count).toBe(2n);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(2n);
    expect(
      store.db
        .query<{ reason: string }, []>('SELECT rejection_reason AS reason FROM telegram_updates WHERE update_id = 3')
        .get()?.reason,
    ).toBe('topic_not_allowed');
    store.close();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { loadConfig } from '../src/config.ts';
import { SqliteStore } from '../src/database.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigToml, writeTestConfig } from './helpers.ts';

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
  transform: (toml: string) => string = (toml) => toml,
): Promise<{ store: SqliteStore; ingestion: TelegramIngestion }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-ingest-'));
  directories.push(directory);
  const configPath = join(directory, 'config.toml');
  await writeTestConfig(directory, configPath, transform(testConfigToml(directory)));
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
    const { store, ingestion } = await setup((toml) =>
      toml.replace('bucket_window_seconds = 15', 'bucket_window_seconds = 6'),
    );
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
    if (botUpdate.message === undefined || botUpdate.message.from === undefined) throw new Error('Invalid fixture');
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
  test('isolates allowed forum topics and rejects unconfigured topics', async () => {
    const { store, ingestion } = await setup((toml) =>
      toml.replace(
        'instructions_file = "chat-instructions.md"',
        `topic_ids = [100, 200]
instructions_file = "chat-instructions.md"`,
      ),
    );
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

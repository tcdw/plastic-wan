import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { type FileConfig, type LoadedConfig, loadConfig } from '../src/config.ts';
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

async function setup(
  transform?: (config: FileConfig) => void,
  handler: ConstructorParameters<typeof BucketScheduler>[3] = async () => ({ state: 'completed', reason: 'done' }),
): Promise<{
  loaded: LoadedConfig;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-scheduler-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, transform);
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return {
    loaded,
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999 }),
    scheduler: new BucketScheduler(store, loaded.config, loaded.hash, handler),
  };
}

function textUpdate(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function topicUpdate(updateId: number, messageId: number, threadId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      message_thread_id: threadId,
      is_topic_message: true,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

describe('bucket scheduler', () => {
  test('freezes the latest revision at the fixed deadline', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), start);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_005,
        date: 1_700_000_010,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(start.getTime() + 5_000));
    expect(scheduler.processDue(new Date(start.getTime() + 5_999))).toHaveLength(0);
    expect(scheduler.processDue(new Date(start.getTime() + 6_000))).toHaveLength(1);
    const snapshot = store.db
      .query<{ snapshot_json: string }, []>("SELECT snapshot_json FROM invocation_messages WHERE section = 'new'")
      .get();
    expect(snapshot === null ? null : JSON.parse(snapshot.snapshot_json).text).toBe('after');
    expect(
      store.db.query<{ prompt_version: bigint }, []>('SELECT prompt_version FROM invocations').get()?.prompt_version,
    ).toBe(2n);
    store.close();
  });

  test('post-deadline edits affect future history without rewriting the frozen invocation', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(firstInvocation);
    store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(firstInvocation);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_020,
        date: 1_700_000_010,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(start.getTime() + 16_000));
    ingestion.ingest(textUpdate(3, 11, 'next'), new Date(start.getTime() + 20_000));
    const [secondInvocation] = scheduler.processDue(new Date(start.getTime() + 35_000));
    if (secondInvocation === undefined) {
      throw new Error('Expected second invocation');
    }
    const frozen = store.db
      .query<{ snapshot_json: string }, [bigint]>(
        "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'new'",
      )
      .get(firstInvocation);
    const future = store.db
      .query<{ snapshot_json: string }, [bigint]>(
        "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no DESC LIMIT 1",
      )
      .get(secondInvocation);
    expect(frozen === null ? null : JSON.parse(frozen.snapshot_json).text).toBe('before');
    expect(future === null ? null : JSON.parse(future.snapshot_json).text).toBe('after');
    store.close();
  });

  test('recovers a bucket younger than five minutes', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'recent'), start);
    const recoveredAt = new Date(start.getTime() + 4 * 60_000);
    scheduler.recover(recoveredAt);
    const [invocationId] = scheduler.processDue(recoveredAt);
    expect(invocationId).toBeDefined();
    expect(store.db.query<{ state: string }, []>('SELECT state FROM buckets').get()?.state).toBe('queued');
    store.close();
  });

  test('expires restart work older than five minutes', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'old'), start);
    scheduler.recover(new Date(start.getTime() + 5 * 60_000 + 1));
    expect(store.db.query<{ state: string }, []>('SELECT state FROM buckets').get()?.state).toBe('expired');
    store.close();
  });

  test('does not queue another invocation while the conversation is busy', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .query("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 15_000).toISOString(), firstInvocation);
    store.db
      .query(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 15_000).toISOString(), firstInvocation);
    ingestion.ingest(textUpdate(2, 11, 'during'), new Date(start.getTime() + 16_000));
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    expect(
      store.db.query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()?.state,
    ).toBe('collecting');
    store.close();
  });

  test('skips a bucket once the daily invocation reservation is exhausted', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.budget.max_invocations_per_day = 1;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(firstInvocation);
    store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(firstInvocation);
    const secondStart = new Date(start.getTime() + 20_000);
    ingestion.ingest(textUpdate(2, 11, 'second'), secondStart);
    scheduler.processDue(new Date(secondStart.getTime() + 15_000));
    const states = store.db
      .query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id')
      .all()
      .map((row) => row.state);
    expect(states).toEqual(['completed', 'skipped_budget']);
    store.close();
  });

  test('starts the next busy-period bucket on the prior session pace', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 6_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    const firstStarted = new Date(start.getTime() + 6_000);
    store.db
      .query("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(firstStarted.toISOString(), firstInvocation);
    store.db
      .query(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(firstStarted.toISOString(), firstInvocation);
    ingestion.ingest(textUpdate(2, 11, 'next'), new Date(start.getTime() + 9_000));
    expect(scheduler.processDue(new Date(start.getTime() + 11_999))).toHaveLength(0);
    store.db
      .query("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 10_000).toISOString(), firstInvocation);
    store.db
      .query(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 10_000).toISOString(), firstInvocation);
    expect(scheduler.processDue(new Date(start.getTime() + 12_000))).toHaveLength(1);
    const secondDeadline = store.db
      .query<{ deadline_at: string }, []>('SELECT deadline_at FROM buckets ORDER BY id DESC LIMIT 1')
      .get();
    expect(secondDeadline?.deadline_at).toBe('2026-08-15T00:00:12.000Z');
    store.close();
  });

  test('waits for a slow session to finish before queueing the next bucket', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 6_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .query("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 6_000).toISOString(), firstInvocation);
    store.db
      .query(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 6_000).toISOString(), firstInvocation);
    ingestion.ingest(textUpdate(2, 11, 'during'), new Date(start.getTime() + 8_000));
    expect(scheduler.processDue(new Date(start.getTime() + 20_000))).toHaveLength(0);
    store.db
      .query("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 20_000).toISOString(), firstInvocation);
    store.db
      .query(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 20_000).toISOString(), firstInvocation);
    expect(scheduler.processDue(new Date(start.getTime() + 20_000))).toHaveLength(1);
    store.close();
  });

  test('does not create another invocation without new human messages', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'only'), start);
    const [invocationId] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected invocation');
    }
    store.db
      .query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(invocationId);
    store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(1n);
    store.close();
  });

  test('zero-second windows consume each next bucket once without idle retrigger or same-chat reentry', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedSignal = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedSignal = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let secondFinished!: () => void;
    const secondFinishedSignal = new Promise<void>((resolve) => {
      secondFinished = resolve;
    });
    const started: bigint[] = [];
    let active = 0;
    let maxActive = 0;
    const { store, ingestion, scheduler } = await setup(
      (config) => {
        config.telegram.bucket_window_seconds = 0;
      },
      async (invocationId) => {
        started.push(invocationId);
        if (started.length === 1) {
          firstStarted();
        }
        if (started.length === 2) {
          secondStarted();
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started.length === 1) {
          await firstGate;
        }
        active -= 1;
        if (started.length === 2) {
          secondFinished();
        }
        return { state: 'completed', reason: 'done' };
      },
    );
    try {
      scheduler.start();
      const received = new Date();
      ingestion.ingest(textUpdate(1, 10, 'first'), received);
      scheduler.wake();
      await firstStartedSignal;

      const during = ingestion.ingest(textUpdate(2, 11, 'during'), new Date());
      scheduler.processDue();
      expect(started).toHaveLength(1);
      expect(maxActive).toBe(1);
      expect(
        store.db.query<{ state: string }, []>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()?.state,
      ).toBe('collecting');

      releaseFirst();
      await secondStartedSignal;
      expect(maxActive).toBe(1);
      await secondFinishedSignal;
      await scheduler.stop();
      expect(scheduler.processDue()).toHaveLength(0);
      expect(started).toHaveLength(2);
      expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(2n);
      expect(
        store.db
          .query<{ count: bigint }, [bigint]>(
            "SELECT COUNT(*) AS count FROM invocation_messages WHERE message_id = ? AND section = 'new'",
          )
          .get(during.messageId!)?.count,
      ).toBe(1n);
      expect(
        store.db
          .query<{ count: bigint }, []>(
            "SELECT COUNT(*) AS count FROM buckets WHERE state IN ('collecting', 'queued', 'running')",
          )
          .get()?.count,
      ).toBe(0n);
    } finally {
      releaseFirst();
      await scheduler.stop();
      store.close();
    }
  });

  test('serializes agent sessions across forum topics of the same chat', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(topicUpdate(1, 10, 100, 'topic-a'), start);
    ingestion.ingest(topicUpdate(2, 11, 200, 'topic-b'), new Date(start.getTime() + 1_000));
    const [firstId] = scheduler.processDue(new Date(start.getTime() + 6_000));
    if (firstId === undefined) {
      throw new Error('Expected first invocation');
    }
    const firstStarted = new Date(start.getTime() + 6_000);
    store.db
      .query("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(firstStarted.toISOString(), firstId);
    store.db
      .query(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(firstStarted.toISOString(), firstId);
    // the second topic's bucket is due, but the chat session is still busy
    expect(scheduler.processDue(new Date(start.getTime() + 7_000))).toHaveLength(0);
    // finish the first session; its completion pushes every collecting bucket of the chat to the pace
    store.db
      .query("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 6_500).toISOString(), firstId);
    store.db
      .query(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 6_500).toISOString(), firstId);
    const chatId = store.db.query<{ chat_id: bigint }, []>('SELECT chat_id FROM conversations LIMIT 1').get()!.chat_id;
    store.db
      .query(
        `UPDATE buckets SET deadline_at = ?, updated_at = ?
         WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ?) AND state = 'collecting'`,
      )
      .run(new Date(start.getTime() + 12_000).toISOString(), new Date(start.getTime() + 6_500).toISOString(), chatId);
    expect(scheduler.processDue(new Date(start.getTime() + 11_999))).toHaveLength(0);
    const [secondId] = scheduler.processDue(new Date(start.getTime() + 12_000));
    expect(secondId).toBeDefined();
    const secondBucket = store.db
      .query<{ conversation_id: bigint; thread_id: bigint }, [bigint]>(
        `SELECT b.conversation_id, v.message_thread_id AS thread_id FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.id = (SELECT bucket_id FROM invocations WHERE id = ?)`,
      )
      .get(secondId!);
    expect(secondBucket?.thread_id).toBe(200n);
    store.close();
  });

  test('runs agent sessions of different chats concurrently', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.chats.push({ id: 987654321, budget: { max_invocations_per_day: 100 } });
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'chat-a', 123456789), start);
    ingestion.ingest(textUpdate(2, 11, 'chat-b', 987654321), start);
    const invocations = scheduler.processDue(new Date(start.getTime() + 15_000));
    expect(invocations).toHaveLength(2);
    store.close();
  });
});

import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { type LoadedConfig, loadConfig, type FileConfig, resolveAgentSettings } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import {
  bucketMessages,
  buckets,
  chats,
  conversations,
  memories,
  messages,
  schemaMigrations,
  stickerSets,
  telegramUpdates,
} from '../src/store/schema.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function openStore(): Promise<{ store: SqliteStore; loaded: LoadedConfig }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded };
}

test('drizzle layer reads migration versions as bigint', async () => {
  const { store } = await openStore();
  try {
    const versions = store.orm
      .select()
      .from(schemaMigrations)
      .all()
      .map((row) => row.version);
    expect(versions.length).toBeGreaterThanOrEqual(14);
    for (const version of versions) {
      expect(typeof version).toBe('bigint');
    }
  } finally {
    store.close();
  }
});

test('drizzle layer round-trips bigint and boolean columns', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    const inserted = store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .returning({ id: chats.id, telegramChatId: chats.telegramChatId })
      .get();
    expect(inserted?.id).toBe(1n);
    expect(typeof inserted?.id).toBe('bigint');
    expect(inserted?.telegramChatId).toBe(123456789n);

    const allowed = store.orm
      .insert(telegramUpdates)
      .values({ updateId: 10n, chatId: 123456789n, chatType: 'private', receivedAt: now, allowed: true, rawJson: '{}' })
      .returning({ allowed: telegramUpdates.allowed })
      .get();
    expect(allowed?.allowed).toBe(true);
    expect(typeof allowed?.allowed).toBe('boolean');

    const rejected = store.orm
      .insert(telegramUpdates)
      .values({ updateId: 11n, receivedAt: now, allowed: false })
      .returning({ allowed: telegramUpdates.allowed })
      .get();
    expect(rejected?.allowed).toBe(false);
  } finally {
    store.close();
  }
});

test('strict tables still reject text values in integer columns through sql templates', async () => {
  const { store } = await openStore();
  try {
    expect(() => {
      // The typed layer would refuse this; reach around it to prove SQLite
      // STRICT still guards the raw boundary.
      store.orm.run(sql`INSERT INTO chats (id, telegram_chat_id, canonical_chat_id, type, updated_at)
        VALUES (1, ${'not-a-number'}, 123456789, 'private', '2026-09-01T00:00:00.000Z')`);
    }).toThrow();
    const count = store.orm.select({ count: sql<bigint>`count(*)` }).from(chats).get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('drizzle statements join better-sqlite3 immediate transactions and roll back on throw', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
    store.orm
      .insert(messages)
      .values({ id: 1n, conversationId: 1n, chatId: 1n, telegramMessageId: 5n, telegramDate: now, receivedAt: now })
      .run();
    expect(() => {
      store.transaction(() => {
        store.orm
          .insert(buckets)
          .values({
            id: 1n,
            conversationId: 1n,
            state: 'collecting',
            firstReceivedAt: now,
            deadlineAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        store.orm.insert(bucketMessages).values({ bucketId: 1n, messageId: 1n, sequenceNo: 0n }).run();
        throw new Error('rollback');
      });
    }).toThrow('rollback');
    const bucketCount = store.orm.select({ count: sql<bigint>`count(*)` }).from(buckets).get();
    expect(bucketCount?.count).toBe(0n);
    const bucketMessageCount = store.orm.select({ count: sql<bigint>`count(*)` }).from(bucketMessages).get();
    expect(bucketMessageCount?.count).toBe(0n);
  } finally {
    store.close();
  }
});

test('sql templates bind bigint parameters and query the fts5 virtual table', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    const set = store.orm
      .insert(stickerSets)
      .values({ alias: 'cats', telegramName: 'cat_set', updatedAt: now })
      .returning({ id: stickerSets.id })
      .get();
    expect(typeof set?.id).toBe('bigint');
    store.orm.run(
      sql`INSERT INTO sticker_search (sticker_id, description) VALUES (${set?.id ?? 0n}, ${'a happy cat'})`,
    );
    const matched = store.orm.all<{ sticker_id: bigint }>(
      sql`SELECT sticker_id FROM sticker_search WHERE sticker_search MATCH ${'cat'}`,
    );
    expect(matched[0]?.sticker_id).toBe(set?.id);

    const bound = store.orm.all<{ n: bigint }>(sql`SELECT ${9007199254740993n} AS n`);
    expect(bound[0]?.n).toBe(9007199254740993n);
  } finally {
    store.close();
  }
});

test('drizzle layer preserves check constraints from the sql migrations', async () => {
  const { store } = await openStore();
  try {
    const now = new Date('2026-09-01T00:00:00.000Z').toISOString();
    store.orm
      .insert(chats)
      .values({ id: 1n, telegramChatId: 123456789n, canonicalChatId: 123456789n, type: 'private', updatedAt: now })
      .run();
    store.orm.insert(conversations).values({ id: 1n, chatId: 1n, createdAt: now, updatedAt: now }).run();
    expect(() => {
      store.orm
        .insert(memories)
        .values({
          id: 'm1',
          conversationId: 1n,
          content: 'x'.repeat(151),
          createdAt: now,
          expiresAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
          updatedAt: now,
        })
        .run();
    }).toThrow();
    const count = store.orm
      .select({ count: sql<bigint>`count(*)` })
      .from(memories)
      .where(eq(memories.conversationId, 1n))
      .get();
    expect(count?.count).toBe(0n);
  } finally {
    store.close();
  }
});

// --- Config validation: chat-level provider/model/thinking_level overrides ---

test('rejects a chat with provider but no model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'Chat 123456789: provider and model must both be set when overriding agent settings',
  );
});

test('rejects a chat with model but no provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'Chat 123456789: provider and model must both be set when overriding agent settings',
  );
});

test('accepts a chat with valid provider + model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig.telegram.chats[0]?.provider).toBe('agent');
  expect(loaded.fileConfig.telegram.chats[0]?.model).toBe('agent-model');
});

test('rejects a chat referencing a non-existent provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'ghost';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow('chat 123456789.provider references unknown alias ghost');
});

test('rejects a chat referencing a non-existent model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'no-such-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'chat 123456789.model no-such-model is absent from provider agent',
  );
});

test('rejects a chat model that lacks text input capability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Bad fixture');
    }
    provider.models = [{ ...provider.models[0]!, id: 'image-only', input: ['image'] }];
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'image-only';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow('chat 123456789.model image-only lacks text input capability');
});

test('accepts a thinking_level override without provider/model (inherits from global)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  expect(loaded.fileConfig.telegram.chats[0]?.thinking_level).toBe('high');
});

test('rejects an inherited thinking_level incompatible with the Chat model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'vision', model: 'vision-model' });
    }),
  );
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level low is not supported by vision\/vision-model/,
  );
});

test('rejects a thinking_level incompatible with the resolved model (non-reasoning)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    // The vision provider has a non-reasoning model
    config.telegram.chats[0]!.provider = 'vision';
    config.telegram.chats[0]!.model = 'vision-model';
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level high is not supported by vision\/vision-model/,
  );
});

test('rejects a thinking_level above what the model declares', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-schema-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Bad fixture');
    }
    // Narrow the reasoning model to only declare off + minimal
    const model = provider.models[0]!;
    model.thinking_levels = ['off', 'minimal'];
    config.telegram.chats[0]!.thinking_level = 'xhigh';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level xhigh is not supported by agent\/agent-model/,
  );
});

test('resolveAgentSettings inherits from global when chat has no override', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' },
  } as Pick<FileConfig, 'agent'>;
  const result = resolveAgentSettings(config);
  expect(result).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'low' });
});

test('resolveAgentSettings applies chat overrides over global defaults', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' },
  } as Pick<FileConfig, 'agent'>;
  const chat = { provider: 'other', model: 'other-model', thinking_level: 'high' } as Pick<
    FileConfig['telegram']['chats'][number],
    'provider' | 'model' | 'thinking_level'
  >;
  const result = resolveAgentSettings(config, chat);
  expect(result).toEqual({ provider: 'other', model: 'other-model', thinking_level: 'high' });
});

test('resolveAgentSettings inherits thinking_level while overriding provider/model', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'medium' },
  } as Pick<FileConfig, 'agent'>;
  const chat = { provider: 'other', model: 'other-model' } as Pick<
    FileConfig['telegram']['chats'][number],
    'provider' | 'model' | 'thinking_level'
  >;
  const result = resolveAgentSettings(config, chat);
  expect(result).toEqual({ provider: 'other', model: 'other-model', thinking_level: 'medium' });
});

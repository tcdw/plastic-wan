import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import Compile from 'typebox/compile';
import { AdminServer } from '../src/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { purgeExpiredData, SqliteStore } from '../src/database.ts';
import { AddMemoryInputSchema, createMemoryTools, DeleteMemoryInputSchema, MemoryStore } from '../src/memory.ts';
import { BucketScheduler } from '../src/scheduler.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigToml, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly loaded: LoadedConfig;
  readonly conversationId: bigint;
  readonly invocationId: bigint;
}

async function fixture(extra = ''): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-memory-'));
  directories.push(directory);
  const configPath = join(directory, 'config.toml');
  await writeTestConfig(
    directory,
    configPath,
    `${testConfigToml(directory)}
${extra}`,
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) throw new Error('Expected a due invocation');
  const conversation = store.db
    .query<{ conversation_id: bigint }, [bigint]>('SELECT conversation_id FROM invocations WHERE id = ?')
    .get(invocationId);
  if (conversation === null) throw new Error('Expected the invocation conversation');
  return { store, loaded, conversationId: conversation.conversation_id, invocationId };
}

test('memories persist per conversation, expire by TTL, and purge expired rows', async () => {
  const { store, loaded, conversationId } = await fixture();
  try {
    const memory = new MemoryStore(store.db);
    const now = new Date('2026-08-15T12:00:00.000Z');
    const first = memory.add(conversationId, 'remember one', 86_400, now);
    expect(first.id).toMatch(/^mem_[a-f0-9]{32}$/);
    expect(first.expiresAt).toBe('2026-08-16T12:00:00.000Z');

    const second = memory.add(conversationId, 'remember two', 3_600, new Date('2026-08-15T13:00:00.000Z'));
    expect(second.expiresAt).toBe('2026-08-15T14:00:00.000Z');
    const active = memory.listActive(conversationId, new Date('2026-08-15T13:30:00.000Z'));
    expect(active.map((entry) => entry.id)).toEqual([first.id, second.id]);

    // TTL expiry hides rows and opportunistic writes purge them.
    const later = new Date('2026-08-15T14:00:01.000Z');
    expect(memory.listActive(conversationId, later).map((entry) => entry.id)).toEqual([first.id]);
    memory.add(conversationId, 'third', 86_400, later);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(2n);

    // Cross-conversation delete is a no-op and leaks nothing.
    const otherConversation = conversationId + 1n;
    expect(memory.remove(first.id, otherConversation, later)).toBe(false);
    expect(
      store.db
        .query<{ count: bigint }, [string]>('SELECT COUNT(*) AS count FROM memories WHERE id = ?')
        .get(first.id)?.count,
    ).toBe(1n);
    expect(memory.remove(first.id, conversationId, later)).toBe(true);
    expect(
      store.db
        .query<{ count: bigint }, [string]>('SELECT COUNT(*) AS count FROM memories WHERE id = ?')
        .get(first.id)?.count,
    ).toBe(0n);

    // purgeExpiredData also cleans expired rows during retention purging.
    memory.add(conversationId, 'ephemeral', 60, new Date('2026-08-15T15:00:00.000Z'));
    purgeExpiredData(store.db, loaded.config, new Date('2026-08-15T15:00:30.000Z'));
    expect(
      store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM memories WHERE content = 'ephemeral'").get()
        ?.count,
    ).toBe(1n);
    purgeExpiredData(store.db, loaded.config, new Date('2026-08-15T15:01:01.000Z'));
    expect(
      store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM memories WHERE content = 'ephemeral'").get()
        ?.count,
    ).toBe(0n);
  } finally {
    store.close();
  }
});

test('add_memory and delete_memory audit tool calls and respect conversation scope', async () => {
  const { store, loaded, conversationId, invocationId } = await fixture();
  try {
    const memory = new MemoryStore(store.db);
    const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0, 32768, false);
    expect(context.conversationId).toBe(conversationId);
    const [addTool, deleteTool] = createMemoryTools(memory, context);
    if (addTool === undefined || deleteTool === undefined) throw new Error('Expected both memory tools');

    const added = await addTool.execute(
      'call-1',
      { content: 'Alice prefers short replies' },
      new AbortController().signal,
    );
    const id = added.details.id;
    expect(id).toMatch(/^mem_[a-f0-9]{32}$/);
    const row = store.db
      .query<
        { tool_name: string; state: string; side_effect: bigint; result_text: string; arguments_json: string },
        []
      >(
        "SELECT tool_name, state, side_effect, result_text, arguments_json FROM tool_calls WHERE tool_call_id = 'call-1'",
      )
      .get();
    expect(row).toMatchObject({
      tool_name: 'add_memory',
      state: 'success',
      side_effect: 1n,
    });
    expect(row?.arguments_json).toContain('Alice prefers short replies');
    expect(row?.result_text).toContain(`memory_id=${id}`);

    const custom = await addTool.execute(
      'call-2',
      { content: 'short-lived', ttl_seconds: 3_600 },
      new AbortController().signal,
    );
    const stored = store.db
      .query<{ created_at: string; expires_at: string }, [string]>(
        'SELECT created_at, expires_at FROM memories WHERE id = ?',
      )
      .get(custom.details.id);
    expect(stored?.expires_at).toBe(new Date(Date.parse(stored!.created_at) + 3_600_000).toISOString());

    // delete_memory removes only its own conversation's memory.
    const foreignConversation = secondConversation(store, conversationId);
    const foreign = new MemoryStore(store.db).add(foreignConversation, 'foreign note', 86_400);
    const foreignDelete = await deleteTool.execute('call-3', { id: foreign.id }, new AbortController().signal);
    expect(foreignDelete.details.id).toBe(foreign.id);
    expect(
      store.db
        .query<{ count: bigint }, [string]>('SELECT COUNT(*) AS count FROM memories WHERE id = ?')
        .get(foreign.id)?.count,
    ).toBe(1n);
    const deleted = await deleteTool.execute('call-4', { id }, new AbortController().signal);
    expect(deleted.details.id).toBe(id);
    expect(
      store.db
        .query<{ count: bigint }, [string]>('SELECT COUNT(*) AS count FROM memories WHERE id = ?')
        .get(id)?.count,
    ).toBe(0n);
    const audit = store.db
      .query<{ state: string; result_text: string }, []>(
        "SELECT state, result_text FROM tool_calls WHERE tool_call_id = 'call-4'",
      )
      .get();
    expect(audit).toMatchObject({ state: 'success' });
    expect(audit?.result_text).toContain('deleted');

    // Tool-layer hard limits live in the schemas.
    expect(Compile(AddMemoryInputSchema).Check({ content: 'x'.repeat(151) })).toBe(false);
    expect(Compile(AddMemoryInputSchema).Check({ content: 'x'.repeat(150) })).toBe(true);
    expect(Compile(DeleteMemoryInputSchema).Check({ id: 'mem_zzzz' })).toBe(false);
  } finally {
    store.close();
  }
});

test('the system prompt injects active memories in creation order', async () => {
  const { store, loaded, conversationId, invocationId } = await fixture();
  try {
    const memory = new MemoryStore(store.db);
    const now = new Date('2026-08-15T12:00:00.000Z');
    const first = memory.add(conversationId, 'first note', 30 * 86_400, now);
    const second = memory.add(conversationId, 'second note', 30 * 86_400, new Date('2026-08-15T12:00:05.000Z'));
    memory.add(conversationId, 'short note', 60, now);
    memory.add(secondConversation(store, conversationId), 'other conversation note', 30 * 86_400, now);

    const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0, 32768, false);
    expect(context.systemPrompt).toContain('<memory_list>');
    const firstIndex = context.systemPrompt.indexOf(`- ${first.id}: first note`);
    const secondIndex = context.systemPrompt.indexOf(`- ${second.id}: second note`);
    expect(firstIndex).toBeGreaterThan(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(context.systemPrompt).toContain('100 characters');
    expect(context.systemPrompt).not.toContain('short note');
    expect(context.systemPrompt).not.toContain('other conversation note');
    // The per-invocation timestamp must sit after the memory block; anything
    // below it can never be covered by the provider prefix cache.
    expect(context.systemPrompt.indexOf('Current time in ')).toBeGreaterThan(
      context.systemPrompt.indexOf('</memory_list>'),
    );
  } finally {
    store.close();
  }
});

test('admin panel manages memories with chat filter and long-TTL warnings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-memory-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.toml');
  const staticDir = join(directory, 'bundle');
  await Bun.write(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    `${testConfigToml(directory).replace(
      'history_messages = 20',
      'history_messages = 20\nmemory_ttl_warning_days = 2',
    )}

[admin]
enabled = true
host = "127.0.0.1"
port = 8899
session_ttl_hours = 12
static_dir = ${JSON.stringify(staticDir.replaceAll('\\', '/'))}`,
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const server = new AdminServer({ store, config: loaded.config });
  const PASSWORD = 'correct-horse-battery';
  try {
    const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: 'hello',
        },
      } satisfies Update,
      received,
    );
    const setup = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(setup);
    const headers = { cookie };

    const unauthenticated = await server.handle(request('/api/memories'));
    expect(unauthenticated.status).toBe(401);

    const created = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '123456789', content: 'long-lived rule', ttl_seconds: 3 * 86_400 }),
      }),
    );
    expect(created.status).toBe(200);
    const item = await readJson(created);
    expect(item.id).toMatch(/^mem_[a-f0-9]{32}$/);
    expect(item.long_ttl).toBe(true);
    expect(item.expired).toBe(false);
    expect(item.chat).toMatchObject({ telegram_chat_id: '123456789', type: 'private', message_thread_id: 0 });

    const chats = await readJson(await server.handle(request('/api/memories/chats', { headers })));
    expect(chats.items).toContainEqual({ telegram_chat_id: '123456789', type: 'private', title: null, username: null });

    const listed = await readJson(await server.handle(request('/api/memories', { headers })));
    expect(listed.items).toHaveLength(1);
    const longOnly = await readJson(await server.handle(request('/api/memories?state=long_ttl', { headers })));
    expect(longOnly.items).toHaveLength(1);
    const activeOnly = await readJson(await server.handle(request('/api/memories?state=active', { headers })));
    expect(activeOnly.items).toHaveLength(1);

    // Expired rows surface with the expired flag and filter.
    store.db
      .query('UPDATE memories SET created_at = ?, expires_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', item.id);
    const expiredOnly = await readJson(await server.handle(request('/api/memories?state=expired', { headers })));
    expect(expiredOnly.items).toHaveLength(1);
    expect(expiredOnly.items[0].expired).toBe(true);
    const nowActive = await readJson(await server.handle(request('/api/memories?state=active', { headers })));
    expect(nowActive.items).toHaveLength(0);

    const filtered = await readJson(await server.handle(request('/api/memories?chat=999', { headers })));
    expect(filtered.items).toHaveLength(0);

    const updated = await server.handle(
      request(`/api/memories/${item.id}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'edited rule', ttl_seconds: 86_400 }),
      }),
    );
    expect(updated.status).toBe(200);
    expect((await readJson(updated)).content).toBe('edited rule');

    const removed = await server.handle(request(`/api/memories/${item.id}`, { method: 'DELETE', headers }));
    expect(removed.status).toBe(200);
    const missing = await server.handle(request(`/api/memories/${item.id}`, { method: 'DELETE', headers }));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });

    // Validation and method guards.
    const longContent = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '123456789', content: 'x'.repeat(151) }),
      }),
    );
    expect(longContent.status).toBe(400);
    expect(await readJson(longContent)).toMatchObject({ error: 'invalid_content' });
    const unknownChat = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '999', content: 'note' }),
      }),
    );
    expect(unknownChat.status).toBe(404);
    expect(await readJson(unknownChat)).toMatchObject({ error: 'chat_not_found' });
    const badTtl = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '123456789', content: 'note', ttl_seconds: 30 }),
      }),
    );
    expect(badTtl.status).toBe(400);
    expect(await readJson(badTtl)).toMatchObject({ error: 'invalid_ttl_seconds' });
    const badState = await server.handle(request('/api/memories?state=bogus', { headers }));
    expect(badState.status).toBe(400);
    expect(await readJson(badState)).toMatchObject({ error: 'invalid_state' });
    const badCursor = await server.handle(request('/api/memories?cursor=not-a-memory', { headers }));
    expect(badCursor.status).toBe(400);
    expect(await readJson(badCursor)).toMatchObject({ error: 'invalid_cursor' });
    const badId = await server.handle(request('/api/memories/not-an-id', { method: 'DELETE', headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });
    const auditWrite = await server.handle(request('/api/invocations', { method: 'PUT', headers, body: '{}' }));
    expect(auditWrite.status).toBe(405);
    const crossOrigin = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', origin: 'http://evil.test' },
        body: JSON.stringify({ chat_id: '123456789', content: 'note' }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  } finally {
    store.close();
  }
});

function secondConversation(store: SqliteStore, conversationId: bigint): bigint {
  const chat = store.db
    .query<{ chat_id: bigint }, [bigint]>('SELECT chat_id FROM conversations WHERE id = ?')
    .get(conversationId);
  if (chat === null) throw new Error('Expected the conversation chat');
  const timestamp = new Date().toISOString();
  const created = store.db
    .query('INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 1, ?, ?)')
    .run(chat.chat_id, timestamp, timestamp);
  return BigInt(created.lastInsertRowid);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

// Admin payloads are asserted structurally, so a loose type keeps assertions readable.
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) headers.cookie = cookie;
  return request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) throw new Error('Expected a session cookie');
  return header.slice(0, header.indexOf(';'));
}

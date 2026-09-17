import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { loadConfig } from '../src/platform/config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { decodeContextMessage, encodeContextMessage, estimateMessageTokens } from '../src/context/context-codec.ts';
import { ConversationContextStore, listConversationContexts } from '../src/context/context-store.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { isRenderable } from '../src/context/context-gc.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(): Promise<{ store: SqliteStore; loaded: Awaited<ReturnType<typeof loadConfig>> }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-context-store-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  store.db
    .query(
      "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (1, 1, 'private', '2026-08-15T00:00:00.000Z')",
    )
    .run();
  store.db
    .query(
      "INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES ((SELECT id FROM chats LIMIT 1), 0, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
    )
    .run();
  store.db
    .query(
      `INSERT INTO messages(conversation_id, chat_id, telegram_message_id, visible, sent_by_bot, telegram_date, received_at)
       VALUES ((SELECT id FROM conversations LIMIT 1), (SELECT id FROM chats LIMIT 1), 1, 1, 0, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`,
    )
    .run();
  store.db
    .query(
      `INSERT INTO message_revisions(message_id, revision_no, kind, created_at, raw_fragment_json)
       VALUES ((SELECT id FROM messages LIMIT 1), 1, 'photo', '2026-08-15T00:00:00.000Z', '{}')`,
    )
    .run();
  for (const [fileId, fileUniqueId] of [
    ['file-1', 'unique-1'],
    ['file-2', 'unique-2'],
  ] as const) {
    store.db
      .query(
        `INSERT INTO media(revision_id, kind, file_id, file_unique_id, mime_type, telegram_json)
         VALUES ((SELECT id FROM message_revisions LIMIT 1), 'photo', ?, ?, 'image/jpeg', '{}')`,
      )
      .run(fileId, fileUniqueId);
  }
  return { store, loaded };
}

function mediaId(store: SqliteStore, index: number): bigint {
  const rows = store.db.query<{ id: bigint }, []>('SELECT id FROM media ORDER BY id').all();
  const row = rows[index];
  if (row === undefined) {
    throw new Error('Fixture has no media row');
  }
  return row.id;
}

function conversationId(store: SqliteStore): bigint {
  const row = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations LIMIT 1').get();
  if (row === null) {
    throw new Error('Fixture has no conversation');
  }
  return row.id;
}

function assistantText(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'agent',
    model: 'agent-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
  };
}

describe('context codec', () => {
  test('round-trips a tool call with its arguments and thinking signature', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning here', thinkingSignature: 'sig-1' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'send',
          arguments: { kind: 'text', text: 'hello', nested: { a: [1, 2] } },
        },
      ],
      api: 'openai-responses',
      provider: 'agent',
      model: 'agent-model',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 15,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
      stopReason: 'toolUse',
      timestamp: 1_700_000_000_000,
    };
    const encoded = encodeContextMessage(message);
    expect(encoded?.role).toBe('assistant');
    const decoded = decodeContextMessage(encoded?.json ?? '');
    expect(decoded).toEqual(message);
    expect(estimateMessageTokens(message)).toBeGreaterThan(0);
  });

  test('round-trips provider usage counters the schema does not enumerate', () => {
    // Regression: the decoder used to accept only five usage counters, so the
    // moment a provider reported another one (OpenRouter sends `reasoning`, and
    // Anthropic a `cacheWrite1h` split) every stored assistant message of that
    // conversation became undecodable. Seeding then threw before the first model
    // call, and each later invocation failed within milliseconds until a human
    // cleared the history.
    const message: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'as reported by the provider' }],
      api: 'openai-completions',
      provider: 'agent',
      model: 'agent-model',
      usage: {
        input: 3,
        output: 40,
        cacheRead: 0,
        cacheWrite: 15565,
        cacheWrite1h: 12,
        reasoning: 0,
        totalTokens: 15608,
        cost: { input: 0.0000003, output: 0.000024, cacheRead: 0, cacheWrite: 0.001945625, total: 0.001969925 },
      },
      stopReason: 'stop',
      timestamp: 1_700_000_000_000,
    };
    const json = encodeContextMessage(message)?.json ?? '';
    expect(json).toContain('"reasoning":0');
    expect(decodeContextMessage(json)).toEqual(message);
  });

  test('rejects a stored row whose shape really is broken', () => {
    // The tolerance above is limited to provider-reported metadata: a row that is
    // missing what the transcript needs must still fail loudly.
    const message: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'agent-api',
      provider: 'agent',
      model: 'agent-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    };
    const parsed = JSON.parse(encodeContextMessage(message)?.json ?? '{}') as Record<string, unknown>;
    expect(() => decodeContextMessage(JSON.stringify({ ...parsed, timestamp: undefined }))).toThrow(
      'does not match its schema',
    );
    expect(() => decodeContextMessage(JSON.stringify({ ...parsed, role: 'assistant' }))).not.toThrow();
    expect(() => decodeContextMessage(JSON.stringify({ ...parsed, content: [{ type: 'image', data: 'AA' }] }))).toThrow(
      'does not match its schema',
    );
  });

  test('round-trips a tool result and drops inline image blocks', () => {
    const message: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read_image',
      content: [
        { type: 'text', text: 'A cat.' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      details: { cached: true },
      isError: false,
      timestamp: 1_700_000_000_500,
    };
    const decoded = decodeContextMessage(encodeContextMessage(message)?.json ?? '');
    expect(decoded.role).toBe('toolResult');
    if (decoded.role !== 'toolResult') {
      throw new Error('Expected a tool result');
    }
    // Attachments are batch-scoped; replaying base64 on every request would
    // blow up the context and contradict on-demand history reads.
    expect(decoded.content).toEqual([{ type: 'text', text: 'A cat.' }]);
    expect(decoded.details).toEqual({ cached: true });
  });

  test('filters aborted, error, and empty assistant messages', () => {
    const aborted = assistantText('partial');
    if (aborted.role !== 'assistant') {
      throw new Error('Fixture is not an assistant message');
    }
    expect(encodeContextMessage({ ...aborted, stopReason: 'aborted' })).toBeUndefined();
    expect(encodeContextMessage({ ...aborted, stopReason: 'error' })).toBeUndefined();
    expect(encodeContextMessage(assistantText('   '))).toBeUndefined();
    expect(encodeContextMessage({ role: 'user', content: [], timestamp: 1 })).toBeUndefined();
    expect(encodeContextMessage({ role: 'user', content: 'hello', timestamp: 1 })?.role).toBe('user');
  });
});

describe('structural guard', () => {
  test('accepts a segment that starts with user and closes its tool calls', () => {
    const user: AgentMessage = { role: 'user', content: 'hi', timestamp: 1 };
    const call = assistantText('');
    if (call.role !== 'assistant') {
      throw new Error('Fixture is not an assistant message');
    }
    const withCall: AgentMessage = {
      ...call,
      content: [{ type: 'toolCall', id: 'c1', name: 'send', arguments: {} }],
      stopReason: 'toolUse',
    };
    const result: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'send',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 2,
    };
    expect(isRenderable([user, withCall, result])).toBe(true);
    // A dangling tool call is fine: pi-ai synthesizes a "No result provided".
    expect(isRenderable([user, withCall])).toBe(true);
  });

  test('rejects an orphan tool result and a non-user head', () => {
    const orphan: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'missing',
      toolName: 'send',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 2,
    };
    expect(isRenderable([orphan])).toBe(false);
    expect(isRenderable([assistantText('hello')])).toBe(false);
  });
});

describe('conversation context store', () => {
  test('appends history, marks checkpoints, and counts sends', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header, rebuilt } = contexts.open(conversation, 'hash-a');
    expect(rebuilt).toBe(false);
    expect(header.headSeq).toBe(1n);

    const userSeq = contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    const assistantSeq = contexts.append(header, {
      invocationId: null,
      isCheckpoint: false,
      estTokens: 5,
      json: encodeContextMessage(assistantText('published'))?.json ?? '',
      role: 'assistant',
    });
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: false,
      estTokens: 5,
      countedSend: true,
      json: JSON.stringify({
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'send',
        content: [{ type: 'text', text: 'Sent Telegram message 1' }],
        isError: false,
        timestamp: 2,
      }),
      role: 'toolResult',
    });
    expect([userSeq, assistantSeq]).toEqual([1n, 2n]);
    expect(header.nextSeq).toBe(4n);
    expect(header.sendCountTotal).toBe(1n);

    const retained = contexts.retained(header);
    expect(retained).toHaveLength(3);
    expect(retained[0]?.message.role).toBe('user');
    const stats = contexts.stats(header);
    expect(stats.retainedSends).toBe(1);
    expect(stats.messageCount).toBe(3);
    const rows = contexts.window(header);
    expect(rows.map((row) => row.isCheckpoint)).toEqual([true, false, false]);
    expect(rows.map((row) => row.sendSeq)).toEqual([null, null, 1n]);
    store.close();
  });

  test('rebuilds the history when the stable system prompt changes', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const first = contexts.open(conversation, 'hash-a');
    contexts.append(first.header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    const second = contexts.open(conversation, 'hash-b');
    expect(second.rebuilt).toBe(true);
    expect(second.header.headSeq).toBe(1n);
    expect(second.header.nextSeq).toBe(1n);
    expect(contexts.retained(second.header)).toEqual([]);
    expect(second.header.sendCountTotal).toBe(0n);
    store.close();
  });

  test('advanceHead soft-evicts rows and revokes their references', async () => {
    const { store, loaded } = await fixture();
    const contexts = new ConversationContextStore(store);
    const refs = new ContextRefStore(store, { ttlHours: loaded.config.agent.context.ref_ttl_hours });
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    for (let index = 0; index < 4; index += 1) {
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: index % 2 === 0,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: `message ${index}`, timestamp: index }),
        role: 'user',
      });
    }
    const ref = refs.mediaRef(header, mediaId(store, 0), 1n);
    expect(refs.resolve(header, ref, 'media')?.mediaId).toBe(mediaId(store, 0));

    contexts.advanceHead(header, 3n);
    expect(header.headSeq).toBe(3n);
    expect(contexts.window(header).map((row) => row.seq)).toEqual([3n, 4n]);
    // The ref was carried by an evicted row, so it must stop resolving.
    expect(refs.resolve(header, ref, 'media')).toBeUndefined();
    const evicted = store.db
      .query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM context_messages WHERE evicted_at IS NOT NULL')
      .get();
    expect(evicted?.count).toBe(2n);
    expect(() => contexts.advanceHead(header, 2n)).toThrow('Refusing to advance');
    store.close();
  });

  test('clears the whole retained history on demand', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    contexts.clear(header);
    expect(header.headSeq).toBe(header.nextSeq);
    expect(contexts.retained(header)).toEqual([]);
    store.close();
  });

  test('a stale handle cannot resurrect history another handle dropped', async () => {
    // Regression: the retained window was a pure `seq >= head_seq` range read. A
    // handle taken before a concurrent `/cut_topic` keeps the old, lower `headSeq`,
    // so it both read the cut history back and could write that lower head over the
    // cut — the model kept quoting a topic the admin had just cut.
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    for (let index = 0; index < 4; index += 1) {
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: `message ${index}`, timestamp: index }),
        role: 'user',
      });
    }
    // The handle a running invocation is holding, taken before the cut.
    const stale = { ...header };
    const cutting = contexts.header(conversation);
    if (cutting === undefined) {
      throw new Error('Expected a context header');
    }
    contexts.clear(cutting);

    expect(stale.headSeq).toBe(1n);
    expect(contexts.retained(stale)).toEqual([]);
    expect(contexts.window(stale)).toEqual([]);
    expect(contexts.stats(stale).messageCount).toBe(0);
    // A row appended after the cut is still retained by both handles: eviction, not
    // the sequence number, is what decides.
    contexts.append(stale, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'after the cut', timestamp: 9 }),
      role: 'user',
    });
    expect(contexts.retained(stale).map((row) => row.seq)).toEqual([5n]);
    store.close();
  });

  test('lists the retained contexts for the admin projections', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    const listed = listConversationContexts(store, { conversationId: conversation });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.conversationId).toBe(conversation);
    expect(listed[0]?.messageCount).toBe(1n);
    expect(listed[0]?.headSeq).toBe(1n);
    store.close();
  });
});

describe('capability references', () => {
  test('reuses one media ref inside the context and refuses a cross-context lookup', async () => {
    const { store, loaded } = await fixture();
    store.db
      .query(
        "INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES ((SELECT id FROM chats LIMIT 1), 99, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
      )
      .run();
    const contexts = new ConversationContextStore(store);
    const refs = new ContextRefStore(store, { ttlHours: loaded.config.agent.context.ref_ttl_hours });
    const conversations = store.db.query<{ id: bigint }, []>('SELECT id FROM conversations ORDER BY id').all();
    const first = contexts.open(conversations[0]?.id ?? 0n, 'hash-a');
    const second = contexts.open(conversations[1]?.id ?? 0n, 'hash-a');

    const ref = refs.mediaRef(first.header, mediaId(store, 0), 1n);
    // The same media inside the same context keeps its token, which is what
    // keeps retained history stable across requests.
    expect(refs.mediaRef(first.header, mediaId(store, 0), 1n)).toBe(ref);
    expect(refs.resolve(first.header, ref, 'media')?.mediaId).toBe(mediaId(store, 0));
    // Another conversation must never resolve it.
    expect(refs.resolve(second.header, ref, 'media')).toBeUndefined();

    // Expiry is enforced at resolve time, not only by cleanup.
    const expired = refs.mediaRef(first.header, mediaId(store, 1), 1n, new Date(Date.now() - 100 * 3_600_000));
    expect(refs.resolve(first.header, expired, 'media')).toBeUndefined();
    store.close();
  });

  test('derives reply refs from the Telegram message id and honours the TTL', async () => {
    const { store, loaded } = await fixture();
    const contexts = new ConversationContextStore(store);
    const refs = new ContextRefStore(store, { ttlHours: loaded.config.agent.context.ref_ttl_hours });
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    const ref = refs.replyRef(header, 555n, { conversationId: conversation, threadId: 7n }, 1n);
    expect(ref).toBe('reply:555');
    expect(refs.resolve(header, ref, 'reply')?.targetThreadId).toBe(7n);
    expect(refs.resolve(header, 'reply:556', 'reply')).toBeUndefined();
    store.close();
  });
});

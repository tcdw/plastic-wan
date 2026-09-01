import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ContextBuilder } from '../src/context-builder.ts';
import { SqliteStore } from '../src/database.ts';
import type { InvocationContext } from '../src/invocation-context.ts';
import { BucketScheduler } from '../src/scheduler.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { createWebFetchTool } from '../src/web-fetch.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly context: InvocationContext;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-web-fetch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
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
        text: 'fetch the page',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0, 32_768, false);
  return { store, context };
}

test('web_fetch returns bounded untrusted text through proxy synthetic DNS and audits it', async () => {
  const { store, context } = await fixture();
  try {
    const tool = createWebFetchTool({
      store,
      context,
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async (hostname) => {
        expect(hostname).toBe('public.example');
        return [{ address: '198.18.0.42', family: 4 }];
      },
      requestResolved: async (url, address) => {
        expect(url.href).toBe('https://public.example/article?q=1');
        expect(address).toBe('198.18.0.42');
        return new Response('你'.repeat(20_000), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      },
    });
    const result = await tool.execute('web-1', { url: 'https://public.example/article?q=1' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32_768);
    expect(text).toStartWith('Untrusted web content follows.');
    expect(text).toEndWith('[content truncated]');
    expect(result.details).toEqual({
      url: 'https://public.example/article?q=1',
      status: 200,
      truncated: true,
    });
    expect(
      store.db
        .query<{ state: string; side_effect: bigint; result_text: string }, []>(
          "SELECT state, side_effect, result_text FROM tool_calls WHERE tool_call_id = 'web-1'",
        )
        .get(),
    ).toEqual({ state: 'success', side_effect: 0n, result_text: text });
  } finally {
    store.close();
  }
});

test('web_fetch blocks private and literal synthetic addresses, including redirects', async () => {
  const { store, context } = await fixture();
  try {
    let requests = 0;
    const tool = createWebFetchTool({
      store,
      context,
      invocationDeadline: Date.now() + 30_000,
      resolveHostname: async () => [{ address: '198.18.0.42', family: 4 }],
      requestResolved: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      },
    });
    await expect(tool.execute('web-private', { url: 'http://127.0.0.1/secret' })).rejects.toThrow('non-public address');
    await expect(tool.execute('web-synthetic', { url: 'http://198.18.0.42/secret' })).rejects.toThrow(
      'non-public address',
    );
    await expect(tool.execute('web-redirect', { url: 'https://public.example/start' })).rejects.toThrow(
      'non-public address',
    );
    expect(requests).toBe(1);
    expect(
      store.db
        .query<{ tool_call_id: string; state: string; error_code: string }, []>(
          'SELECT tool_call_id, state, error_code FROM tool_calls ORDER BY id',
        )
        .all(),
    ).toEqual([
      { tool_call_id: 'web-private', state: 'error', error_code: 'blocked_address' },
      { tool_call_id: 'web-synthetic', state: 'error', error_code: 'blocked_address' },
      { tool_call_id: 'web-redirect', state: 'error', error_code: 'blocked_address' },
    ]);
  } finally {
    store.close();
  }
});

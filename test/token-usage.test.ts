import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/platform/config.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { buildModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { meteredTokens } from '../src/store/sleep.ts';
import { startFixtureServer, stopFixtureServer, testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('daily budget token definition', () => {
  test.each([
    { name: 'uncached request', usage: { input: 1_000, output: 20, cacheRead: 0, cacheWrite: 0 }, expected: 1_020n },
    { name: 'cache write request', usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 1_000 }, expected: 1_020n },
    { name: 'cache read request', usage: { input: 0, output: 20, cacheRead: 1_000, cacheWrite: 0 }, expected: 1_020n },
    {
      name: 'cached and uncached input together',
      usage: { input: 150, output: 20, cacheRead: 800, cacheWrite: 50 },
      expected: 1_020n,
    },
  ])('counts every token of a $name', ({ usage, expected }) => {
    expect(meteredTokens(usage)).toBe(expected);
  });
});

function sse(events: readonly unknown[], named = false): Response {
  const body = events
    .map((event) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      return named ? `event: ${(event as { type: string }).type}\n${data}` : data;
    })
    .join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * One streamed reply per custom adapter the configuration accepts. Every reply
 * describes the same call: 1,000 prompt tokens (800 of them cache reads, 150
 * cache writes where the wire format has them) and 20 generated tokens. The
 * OpenAI and Google formats count cached tokens inside their prompt total;
 * Anthropic reports them next to an uncached `input_tokens`.
 */
const ADAPTERS = [
  {
    api: 'openai-completions',
    reply: () =>
      new Response(
        `${[
          {
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'agent-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
          },
          {
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'agent-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
          {
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'agent-model',
            choices: [],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 20,
              total_tokens: 1_020,
              prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    expected: { input: 50, output: 20, cacheRead: 800, cacheWrite: 150 },
  },
  {
    api: 'openai-responses',
    reply: () =>
      sse([
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'hi' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hi', annotations: [] }],
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 1_000,
              input_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 },
              output_tokens: 20,
              total_tokens: 1_020,
            },
          },
        },
      ]),
    expected: { input: 50, output: 20, cacheRead: 800, cacheWrite: 150 },
  },
  {
    api: 'anthropic-messages',
    reply: () =>
      sse(
        [
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'agent-model',
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 50,
                cache_read_input_tokens: 800,
                cache_creation_input_tokens: 150,
                output_tokens: 1,
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
          { type: 'message_stop' },
        ],
        true,
      ),
    expected: { input: 50, output: 20, cacheRead: 800, cacheWrite: 150 },
  },
  {
    // Gemini has no cache-write counter; its prompt total includes the cached part.
    api: 'google-generative-ai',
    reply: () =>
      sse([
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: {
            promptTokenCount: 1_000,
            cachedContentTokenCount: 800,
            candidatesTokenCount: 20,
            totalTokenCount: 1_020,
          },
        },
      ]),
    expected: { input: 200, output: 20, cacheRead: 800, cacheWrite: 0 },
  },
] as const;

describe('provider usage normalization', () => {
  test.each(ADAPTERS)('$api usage is metered once per token', async ({ api, reply, expected }) => {
    const fixture = await startFixtureServer(() => reply());
    try {
      const directory = await mkdtemp(join(tmpdir(), 'plasticwan-token-usage-'));
      directories.push(directory);
      const configPath = join(directory, 'config.jsonc');
      await writeTestConfig(
        directory,
        configPath,
        testConfigJsonc(directory, (draft) => {
          const agent = draft.providers.agent;
          if (agent === undefined || agent.kind !== 'custom') {
            throw new Error('Expected the custom agent provider fixture');
          }
          agent.api = api;
          agent.base_url = `http://127.0.0.1:${fixture.port}/v1`;
          // The fixture's compat override only applies to the OpenAI adapters.
          agent.models = agent.models.map(({ compat: _compat, ...model }) => model);
        }),
      );
      const loaded = await loadConfig(configPath);
      const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
      const model = registry.models.getModel('agent', 'agent-model');
      if (model === undefined) {
        throw new Error('Expected the agent model to be registered');
      }
      const message: AssistantMessage = await registry.models.completeSimple(model, {
        messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
      });
      expect(message.errorMessage).toBeUndefined();
      expect(message.usage).toMatchObject(expected);
      // The provider saw 1,000 prompt tokens and generated 20: cached tokens
      // count once, whether the wire format nests them in the prompt total or not.
      expect(meteredTokens(message.usage)).toBe(1_020n);
    } finally {
      await stopFixtureServer(fixture.server);
    }
  });
});

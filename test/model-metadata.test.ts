import { describe, expect, test } from 'vitest';
import { type ModelsDevCatalog, resetModelsDevCatalogCache, loadModelsDevCatalog } from '../src/platform/models-dev.ts';
import {
  type ModelMetadataDraft,
  modelsDevProviderId,
  normalizeModelId,
  resolveModelDrafts,
} from '../src/platform/model-metadata.ts';
import {
  assertBaseUrl,
  fetchProviderModels,
  planModelsEndpoint,
  type DiscoveredProviderModel,
} from '../src/platform/provider-models.ts';
import { startFixtureServer, stopFixtureServer } from './helpers.ts';

/**
 * Synthetic catalogs and listings. Real provider payloads were inspected on
 * 2026-09-20; these fixtures keep only the fields the resolver reads, plus the
 * shapes that make it fail (null output limits, fuzzy ids).
 */
function catalog(): ModelsDevCatalog {
  const model = (overrides: Record<string, unknown>) =>
    ({
      id: 'x',
      name: 'X',
      reasoning: false,
      modalities: { input: ['text'], output: ['text'] },
      ...overrides,
    }) as ModelsDevCatalog[string]['models'][string];
  return {
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      models: {
        'deepseek/deepseek-v4-flash': model({
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
          interleaved: { field: 'reasoning_content' },
          limit: { context: 1048576, output: 384000 },
          cost: { input: 0.03612, output: 0.07224, cache_read: 0.007224 },
        }),
        'moonshotai/kimi-k2.6': model({
          id: 'moonshotai/kimi-k2.6',
          name: 'Kimi K2.6',
          reasoning: true,
          interleaved: { field: 'reasoning_details' },
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 262144, output: 235929 },
        }),
      },
    },
    vercel: {
      id: 'vercel',
      name: 'Vercel AI Gateway',
      models: {
        'anthropic/claude-sonnet-4.5': model({
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          reasoning: true,
          interleaved: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 1000000, output: 64000 },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        }),
      },
    },
    google: {
      id: 'google',
      name: 'Google',
      models: {
        'gemini-3.7-flash': model({
          id: 'gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1048576, output: 65536 },
          cost: { input: 0.3, output: 2.5, cache_read: 0.075, cache_write: 0.3 },
        }),
      },
    },
    togetherai: {
      id: 'togetherai',
      name: 'Together AI',
      models: {
        'deepseek-ai/DeepSeek-V3': model({
          id: 'deepseek-ai/DeepSeek-V3',
          name: 'DeepSeek V3',
          limit: { context: 128000, output: 8192 },
          cost: { input: 0.27, output: 1.1 },
        }),
      },
    },
  };
}

interface OpenRouterFixtureInput {
  readonly id: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly top_provider?: { readonly context_length?: number | null; readonly max_completion_tokens?: number | null };
  readonly architecture?: { readonly input_modalities?: string[] };
  readonly supported_parameters?: string[];
  readonly pricing?: Record<string, string>;
}

function openRouterModel(input: OpenRouterFixtureInput): DiscoveredProviderModel {
  return {
    id: input.id,
    name: input.name ?? null,
    extension: {
      format: 'openrouter',
      payload: {
        id: input.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.context_length === undefined ? {} : { context_length: input.context_length }),
        ...(input.top_provider === undefined ? {} : { top_provider: input.top_provider }),
        ...(input.architecture === undefined ? {} : { architecture: input.architecture }),
        ...(input.supported_parameters === undefined ? {} : { supported_parameters: input.supported_parameters }),
        ...(input.pricing === undefined ? {} : { pricing: input.pricing }),
      },
    },
  };
}

function draftOf(drafts: readonly ModelMetadataDraft[], id: string): ModelMetadataDraft {
  const found = drafts.find((draft) => draft.id === id);
  if (found === undefined) {
    throw new Error(`Draft ${id} is missing`);
  }
  return found;
}

describe('provider model listing', () => {
  test('plans the endpoint per API and keeps the Vercel gateway special case first', () => {
    expect(planModelsEndpoint({ baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' }).endpoint).toBe(
      'https://api.anthropic.com/v1/models',
    );
    expect(
      planModelsEndpoint({
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: 'https://ai-gateway.vercel.sh',
        api: 'anthropic-messages',
      }),
    ).toMatchObject({ endpoint: 'https://ai-gateway.vercel.sh/v1/models', auth: 'bearer', format: 'vercel' });
    expect(planModelsEndpoint({ baseUrl: 'https://ai-gateway.vercel.sh', api: 'openai-completions' })).toMatchObject({
      format: 'vercel',
      endpoint: 'https://ai-gateway.vercel.sh/v1/models',
    });
    expect(
      planModelsEndpoint({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' }),
    ).toMatchObject({
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
      auth: 'x-goog-api-key',
      paginated: true,
    });
    expect(planModelsEndpoint({ baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' })).toMatchObject({
      endpoint: 'https://openrouter.ai/api/v1/models',
      format: 'openrouter',
      auth: 'bearer',
    });
    expect(planModelsEndpoint({ baseUrl: 'https://example.test/v1', api: 'openai-responses' })).toMatchObject({
      endpoint: 'https://example.test/v1/models',
      format: 'openai',
      auth: 'bearer',
    });
    expect(() => assertBaseUrl('https://example.test/v1')).not.toThrow();
    expect(() => assertBaseUrl('not-a-url')).toThrow();
  });

  test('follows Gemini pagination and keeps only generateContent models', async () => {
    const pages: string[] = [];
    const server = await startFixtureServer((request) => {
      const url = new URL(request.url);
      pages.push(`${url.pathname}?${url.searchParams.toString()}`);
      const pageToken = url.searchParams.get('pageToken');
      if (pageToken === null) {
        return Response.json({
          models: [
            {
              name: 'models/gemini-3.7-flash',
              displayName: 'Gemini 3.7 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'page-2',
        });
      }
      return Response.json({
        models: [{ name: 'models/gemini-3.7-pro', thinking: true, supportedGenerationMethods: ['generateContent'] }],
      });
    });
    try {
      const listing = await fetchProviderModels({
        baseUrl: `http://127.0.0.1:${server.port}/v1beta`,
        api: 'google-generative-ai',
        apiKey: 'gemini-key',
      });
      expect(listing.models.map((model) => model.id)).toEqual(['gemini-3.7-flash', 'gemini-3.7-pro']);
      expect(pages).toEqual(['/v1beta/models?pageSize=1000', '/v1beta/models?pageSize=1000&pageToken=page-2']);
      const pro = listing.models.find((model) => model.id === 'gemini-3.7-pro');
      expect(pro?.extension).toMatchObject({ format: 'gemini', payload: { thinking: true } });
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  test('authenticates the Vercel gateway listing and drops non-language models', async () => {
    let authorization = '';
    let path = '';
    const server = await startFixtureServer((request) => {
      path = new URL(request.url).pathname;
      authorization = request.headers.get('authorization') ?? '';
      return Response.json({
        object: 'list',
        data: [
          { id: 'anthropic/claude-sonnet-4.5', type: 'language', context_window: 1000000 },
          { id: 'openai/text-embedding-3', type: 'embedding' },
        ],
      });
    });
    try {
      const listing = await fetchProviderModels({
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: `http://127.0.0.1:${server.port}`,
        api: 'anthropic-messages',
        apiKey: 'gateway-key',
      });
      expect(path).toBe('/v1/models');
      expect(authorization).toBe('Bearer gateway-key');
      expect(listing.models.map((model) => model.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  test('follows Anthropic pagination with the x-api-key header', async () => {
    const requests: string[] = [];
    const server = await startFixtureServer((request) => {
      const url = new URL(request.url);
      requests.push(`${url.searchParams.get('after_id') ?? '-'}|${request.headers.get('x-api-key') ?? ''}`);
      const after = url.searchParams.get('after_id');
      if (after === null) {
        return Response.json({
          data: [{ id: 'claude-a', display_name: 'Claude A' }],
          has_more: true,
          last_id: 'claude-a',
        });
      }
      return Response.json({ data: [{ id: 'claude-b' }], has_more: false, last_id: 'claude-b' });
    });
    try {
      const listing = await fetchProviderModels({
        baseUrl: `http://127.0.0.1:${server.port}`,
        api: 'anthropic-messages',
        apiKey: 'anthropic-key',
      });
      expect(requests).toEqual(['-|anthropic-key', 'claude-a|anthropic-key']);
      expect(listing.models).toEqual([
        { id: 'claude-a', name: 'Claude A', extension: { format: 'anthropic' } },
        { id: 'claude-b', name: null, extension: { format: 'anthropic' } },
      ]);
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  // OpenRouter's own listing was 737 KB on 2026-09-21 and grows with every model
  // it adds, so a megabyte-sized page must go through.
  test('reads a listing larger than one megabyte', async () => {
    const filler = 'd'.repeat(1_400);
    const server = await startFixtureServer(() =>
      Response.json({
        data: Array.from({ length: 1_000 }, (_, index) => ({
          id: `vendor/model-${String(index)}`,
          description: filler,
        })),
      }),
    );
    try {
      const listing = await fetchProviderModels({
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        api: 'openai-completions',
        apiKey: 'key',
      });
      expect(listing.models).toHaveLength(1_000);
    } finally {
      await stopFixtureServer(server.server);
    }
  });

  test('stops reading an oversized listing that declares no length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1_048_576));
    let produced = 0;
    const server = await startFixtureServer(
      () =>
        new Response(
          // No content-length: the cap only holds if the bytes are counted as
          // they arrive. The producer stops on its own so the test cannot hang.
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += 1;
              if (produced > 64) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    try {
      await expect(
        fetchProviderModels({
          baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
          api: 'openai-completions',
          apiKey: 'key',
        }),
      ).rejects.toThrow(/exceeds/);
      expect(produced).toBeLessThan(64);
    } finally {
      await stopFixtureServer(server.server);
    }
  });
});

describe('models.dev catalog cache', () => {
  test('caches the catalog and does not cache failures', async () => {
    resetModelsDevCatalogCache();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          openrouter: { id: 'openrouter', name: 'OpenRouter', models: { 'a/b': { id: 'a/b', name: 'AB' } } },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const first = await loadModelsDevCatalog({ fetchImpl, ttlMs: 60_000 });
    const second = await loadModelsDevCatalog({ fetchImpl, ttlMs: 60_000 });
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first.openrouter?.models['a/b']?.modalities.input).toEqual(['text']);

    resetModelsDevCatalogCache();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(loadModelsDevCatalog({ fetchImpl: failing })).rejects.toThrow('offline');
    await expect(loadModelsDevCatalog({ fetchImpl: failing })).rejects.toThrow('offline');
  });
});

describe('metadata resolution', () => {
  test('reads OpenRouter extended fields and converts per-token prices', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek: DeepSeek V4 Flash',
          context_length: 1310720,
          top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['reasoning', 'include_reasoning'],
          pricing: { prompt: '0.00000004', completion: '0.00000008', input_cache_read: '0.000000016' },
        }),
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'deepseek/deepseek-v4-flash');
    expect(draft.name).toBe('DeepSeek: DeepSeek V4 Flash');
    expect(draft.reasoning).toBe(true);
    expect(draft.input).toEqual(['text']);
    expect(draft.context_window).toBe(1310720);
    expect(draft.max_tokens).toBe(943718);
    expect(draft.cost).toEqual({ input: 0.04, output: 0.08, cache_read: 0.016, cache_write: 0 });
    expect(draft.sources.name).toBe('openrouter');
    expect(draft.sources.cost).toBe('openrouter');
    // models.dev records reasoning_content replay for this id.
    expect(draft.requires_reasoning_content).toBe(true);
    expect(draft.requires_reasoning_content_source).toBe('models.dev');
    // OpenRouter's listing says nothing about effort levels; models.dev does.
    expect(draft.thinking_levels).toEqual(['off', 'low', 'high', 'max']);
    expect(draft.sources.thinking_levels).toBe('models.dev');
    expect(draft.needs_confirmation).toEqual([]);
  });

  test('keeps thinking levels off a model the listing does not call a reasoning model', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek: DeepSeek V4 Flash',
          context_length: 1048576,
          top_provider: { max_completion_tokens: 384000 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['tools'],
          pricing: { prompt: '0.00000004', completion: '0.00000008' },
        }),
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'deepseek/deepseek-v4-flash');
    expect(draft.reasoning).toBe(false);
    // The configuration rejects levels on a model that does not reason, so the
    // catalog's levels are not carried over.
    expect(draft.thinking_levels).toBeNull();
    expect(draft.sources.thinking_levels).toBe('missing');
    expect(draft.needs_confirmation).toEqual([]);
  });

  test('flags a null completion limit as needing confirmation instead of defaulting it', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'rekaai/reka-edge',
          name: 'Reka Edge',
          context_length: 16000,
          top_provider: { max_completion_tokens: null },
          architecture: { input_modalities: ['text'] },
          supported_parameters: [],
          pricing: { prompt: '0.0000001', completion: '0.0000002' },
        }),
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'rekaai/reka-edge');
    expect(draft.max_tokens).toBeNull();
    expect(draft.sources.max_tokens).toBe('missing');
    expect(draft.needs_confirmation).toContain('max_tokens');
    expect(draft.cost).toEqual({ input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 });
  });

  test('fills Gemini metadata from the listing and the rest from models.dev', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        api: 'google-generative-ai',
      },
      [
        {
          id: 'gemini-3.7-flash',
          name: 'Gemini 3.7 Flash',
          extension: {
            format: 'gemini',
            payload: {
              name: 'models/gemini-3.7-flash',
              displayName: 'Gemini 3.7 Flash',
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ['generateContent'],
              thinking: true,
            },
          },
        },
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'gemini-3.7-flash');
    expect(draft.context_window).toBe(1048576);
    expect(draft.max_tokens).toBe(65536);
    expect(draft.reasoning).toBe(true);
    expect(draft.input).toEqual(['text', 'image']);
    expect(draft.sources.input).toBe('models.dev');
    expect(draft.sources.context_window).toBe('gemini');
    expect(draft.needs_confirmation).toEqual([]);
  });

  test('only maps the reasoning_content interleaved form', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [
        openRouterModel({
          id: 'moonshotai/kimi-k2.6',
          supported_parameters: ['reasoning'],
          pricing: { prompt: '0.000001' },
        }),
        openRouterModel({ id: 'deepseek/deepseek-v4-pro' }),
      ],
      catalog(),
    );
    // models.dev says `reasoning_details` for kimi-k2.6, which Pi does not model.
    const kimi = draftOf(drafts, 'moonshotai/kimi-k2.6');
    expect(kimi.requires_reasoning_content).toBe(false);
    // The catalog was read but filled nothing in, so no source may claim it.
    expect(kimi.requires_reasoning_content_source).toBe('missing');
    // No models.dev entry at all: stays on automatic detection.
    const pro = draftOf(drafts, 'deepseek/deepseek-v4-pro');
    expect(pro.requires_reasoning_content).toBe(false);
    expect(pro.requires_reasoning_content_source).toBe('missing');
  });

  test('treats the boolean interleaved form as automatic', () => {
    const drafts = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: 'https://ai-gateway.vercel.sh',
        api: 'anthropic-messages',
      },
      [
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          extension: {
            format: 'vercel',
            payload: {
              id: 'anthropic/claude-sonnet-4.5',
              name: 'Claude Sonnet 4.5',
              context_window: 1000000,
              max_tokens: 64000,
              type: 'language',
              tags: ['reasoning', 'vision'],
              modalities: { input: ['text', 'image', 'pdf'] },
              pricing: { input: '0.000003', output: '0.000015' },
            },
          },
        },
      ],
      catalog(),
    );
    const draft = draftOf(drafts, 'anthropic/claude-sonnet-4.5');
    expect(draft.input).toEqual(['text', 'image']);
    expect(draft.cost).toEqual({ input: 3, output: 15, cache_read: 0, cache_write: 0 });
    expect(draft.sources.cost).toBe('vercel');
    expect(draft.requires_reasoning_content).toBe(false);
    expect(draft.requires_reasoning_content_source).toBe('missing');
  });

  test('falls back to a fuzzy models.dev match and asks for confirmation', () => {
    const drafts = resolveModelDrafts(
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: '~deepseek-ai/DeepSeek-V3:free', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    const draft = draftOf(drafts, '~deepseek-ai/DeepSeek-V3:free');
    expect(draft.match).toEqual({
      provider: 'togetherai',
      model: 'deepseek-ai/DeepSeek-V3',
      confidence: 'fuzzy',
    });
    expect(draft.sources.name).toBe('models.dev-fuzzy');
    expect(draft.sources.cost).toBe('models.dev-fuzzy');
    // The display name is cosmetic, so a fuzzy match does not force the admin to
    // retype it; every field the registry depends on does.
    expect(draft.needs_confirmation).toEqual(['reasoning', 'input', 'context_window', 'max_tokens', 'cost']);
    expect(draft.candidates).toEqual([
      { provider: 'togetherai', model: 'deepseek-ai/DeepSeek-V3', confidence: 'fuzzy' },
    ]);
  });

  test('asks for confirmation when only another provider lists the same model id', () => {
    const drafts = resolveModelDrafts(
      // An unknown relay: the id is exact, but the catalog entry describes
      // OpenRouter's deployment, whose prices and limits need not be this one's.
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: 'deepseek/deepseek-v4-flash', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    const draft = draftOf(drafts, 'deepseek/deepseek-v4-flash');
    expect(draft.match).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      confidence: 'cross-provider',
    });
    expect(draft.context_window).toBe(1048576);
    expect(draft.sources.context_window).toBe('models.dev-cross-provider');
    // Levels are a property of the deployment too: OpenRouter and DeepSeek do
    // not offer the same ones for the same model.
    expect(draft.thinking_levels).toEqual(['off', 'low', 'high', 'max']);
    expect(draft.needs_confirmation).toEqual([
      'reasoning',
      'thinking_levels',
      'input',
      'context_window',
      'max_tokens',
      'cost',
    ]);
    // The same id under the provider the catalog knows is taken as it is.
    const exact = resolveModelDrafts(
      {
        kind: 'builtin',
        builtinProvider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
      },
      [{ id: 'deepseek/deepseek-v4-flash', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    expect(draftOf(exact, 'deepseek/deepseek-v4-flash').match).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      confidence: 'exact',
    });
    expect(draftOf(exact, 'deepseek/deepseek-v4-flash').needs_confirmation).toEqual([]);
  });

  test('reports every field as missing when no source matches', () => {
    const drafts = resolveModelDrafts(
      { kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' },
      [{ id: 'unknown-model', name: null, extension: { format: 'openai' } }],
      catalog(),
    );
    const draft = draftOf(drafts, 'unknown-model');
    expect(draft.name).toBeNull();
    expect(draft.match).toBeNull();
    // Missing levels leave the model on Pi's default, so they block nothing.
    expect(draft.thinking_levels).toBeNull();
    expect(draft.needs_confirmation).toEqual(['name', 'reasoning', 'input', 'context_window', 'max_tokens', 'cost']);
    expect(draft.sources.context_window).toBe('missing');
  });

  test('maps builtin provider ids onto models.dev provider ids', () => {
    expect(
      modelsDevProviderId({
        kind: 'builtin',
        builtinProvider: 'vercel-ai-gateway',
        baseUrl: 'x',
        api: 'anthropic-messages',
      }),
    ).toBe('vercel');
    expect(
      modelsDevProviderId({ kind: 'custom', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' }),
    ).toBe('openrouter');
    expect(
      modelsDevProviderId({ kind: 'custom', baseUrl: 'https://relay.example.test/v1', api: 'openai-completions' }),
    ).toBe(null);
  });

  test('normalizes relay ids for fuzzy matching', () => {
    expect(normalizeModelId('~deepseek-ai/DeepSeek-V3:free')).toBe('deepseek-v3');
    expect(normalizeModelId('DeepSeek-V3')).toBe('deepseek-v3');
  });
});

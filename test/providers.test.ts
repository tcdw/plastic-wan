import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Api, type Context, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import { findBuiltinProvider } from '../src/platform/builtin-providers.ts';
import { type FileConfig, type RawConfig, loadConfig } from '../src/platform/config.ts';
import { createModelRegistry, mapCompat, rebuildBuiltinProvider } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { supportedThinkingLevels, THINKING_LEVELS } from '../src/platform/thinking-levels.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function loadFixture(transform: (config: FileConfig) => void): Promise<RawConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-providers-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  return (await loadConfig(configPath)).config;
}

const BUILTIN_MODEL = {
  id: 'deepseek-chat',
  name: 'DeepSeek Chat',
  reasoning: false,
  input: ['text' as const],
  context_window: 128_000,
  max_tokens: 8_192,
  cost: { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
};

describe('model registry', () => {
  test('registers only the models a builtin provider lists in the configuration', async () => {
    const config = await loadFixture((draft) => {
      draft.providers.deepseek = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: 'builtin-secret',
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'deepseek';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const registry = await createModelRegistry(config, new SecretStore());
    const registered = registry.models.getModels('deepseek');
    expect(registered.map((model) => model.id)).toEqual(['deepseek-chat']);
    // Pi's catalog carries this id; the configuration does not enable it.
    expect(registry.models.getModel('deepseek', 'deepseek-reasoner')).toBeUndefined();
    expect(registered[0]).toMatchObject({
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  test('sends builtin requests under Pi’s own provider id', async () => {
    const config = await loadFixture((draft) => {
      draft.providers.mine = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: 'builtin-secret',
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'mine';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const registry = await createModelRegistry(config, new SecretStore());
    const provider = registry.models.getProvider('mine');
    const model = registry.models.getModel('mine', 'deepseek-chat');
    expect(provider).toBeDefined();
    expect(model).toBeDefined();
    if (provider === undefined || model === undefined) {
      throw new Error('Expected the builtin alias to be registered');
    }
    expect(provider.id).toBe('mine');
    expect(model.provider).toBe('mine');

    const source = findBuiltinProvider('deepseek');
    if (source === undefined) {
      throw new Error('Expected Pi to ship the deepseek provider');
    }
    const original = source.streamSimple;
    let observed: string | null = null;
    Object.assign(source, {
      streamSimple: (candidate: Model<Api>) => {
        observed = candidate.provider;
        throw new Error('stream-stop');
      },
    });
    try {
      expect(() => provider.streamSimple(model, {} as Context)).toThrow('stream-stop');
    } finally {
      Object.assign(source, { streamSimple: original });
    }
    // Automatic compat detection keys off the provider id, so the alias must not
    // reach the request.
    expect(observed).toBe('deepseek');
  });

  test('rebuilds a builtin provider without touching the registry auth', async () => {
    const config = await loadFixture((draft) => {
      draft.providers.deepseek = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: 'builtin-secret',
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'deepseek';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const registry = await createModelRegistry(config, new SecretStore());
    const before = registry.models.getProvider('deepseek');
    const rebuilt = rebuildBuiltinProvider(registry.models, 'deepseek', {
      ...config.providers.deepseek,
      models: [
        BUILTIN_MODEL,
        { ...BUILTIN_MODEL, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
      ],
    } as Extract<RawConfig['providers'][string], { kind: 'builtin' }>);
    expect(rebuilt.auth).toBe(before?.auth);
    expect(rebuilt.baseUrl).toBe('https://api.deepseek.com');
    expect(rebuilt.getModels().map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(rebuilt.getModels()[0]?.provider).toBe('deepseek');
  });

  test('maps the selected compat fields onto Pi’s camelCase names', () => {
    expect(
      mapCompat({
        supports_developer_role: false,
        thinking_format: 'openrouter',
        max_tokens_field: 'max_tokens',
        requires_reasoning_content: true,
        cache_control_format: 'anthropic',
      }),
    ).toEqual({
      supportsDeveloperRole: false,
      thinkingFormat: 'openrouter',
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      cacheControlFormat: 'anthropic',
    });
    expect(mapCompat({})).toBeUndefined();
  });

  test('hands Pi the same thinking levels the configuration validates against', async () => {
    const declared = [['off', 'low', 'high', 'max'], ['low', 'medium', 'xhigh'], ['high', 'off'], ['max']] as const;
    const config = await loadFixture((draft) => {
      const provider = draft.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected custom agent provider fixture');
      }
      const base = provider.models[0];
      if (base === undefined) {
        throw new Error('Expected an agent model fixture');
      }
      provider.models = [
        { ...base, id: 'undeclared' },
        { ...base, id: 'plain', reasoning: false },
        ...declared.map((levels, index) => ({ ...base, id: `declared-${index}`, thinking_levels: [...levels] })),
      ];
      draft.agent.model = 'undeclared';
    });
    const registry = await createModelRegistry(config, new SecretStore());
    const configured = config.providers.agent?.models ?? [];
    expect(configured).toHaveLength(2 + declared.length);
    for (const model of configured) {
      const registered = registry.models.getModel('agent', model.id);
      if (registered === undefined) {
        throw new Error(`Expected ${model.id} to be registered`);
      }
      expect(getSupportedThinkingLevels(registered)).toEqual(supportedThinkingLevels(model));
    }
    // Declared levels come back weakest first, whatever order the file uses.
    expect(supportedThinkingLevels({ reasoning: true, thinking_levels: ['high', 'off'] })).toEqual(['off', 'high']);
    // Supported levels other than xhigh / max keep the adapter's own wire value.
    expect(registry.models.getModel('agent', 'declared-0')?.thinkingLevelMap).toEqual({
      minimal: null,
      medium: null,
      xhigh: null,
      max: 'max',
    });
    expect(registry.models.getModel('agent', 'undeclared')?.thinkingLevelMap).toBeUndefined();
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('registers custom models with their compat overrides', async () => {
    const config = await loadFixture((draft) => {
      draft.providers.agent = {
        kind: 'custom',
        base_url: 'https://relay.example.test/v1/',
        api: 'openai-completions',
        api_key: 'custom-secret',
        models: [
          {
            id: 'agent-model',
            reasoning: true,
            compat: { requires_reasoning_content: true },
            input: ['text', 'image'],
            context_window: 200_000,
            max_tokens: 32_768,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          },
        ],
      };
    });
    const registry = await createModelRegistry(config, new SecretStore());
    const model = registry.models.getModel('agent', 'agent-model');
    expect(model).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://relay.example.test/v1',
      compat: { requiresReasoningContentOnAssistantMessages: true },
    });
  });
});

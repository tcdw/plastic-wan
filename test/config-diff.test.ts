import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { diffConfig, type ConfigChange } from '../src/platform/config-diff.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function loadBoth(
  transform?: (config: FileConfig) => void,
  fileTransform?: (config: FileConfig) => void,
): Promise<{
  active: Awaited<ReturnType<typeof loadConfig>>;
  file: Awaited<ReturnType<typeof loadConfig>>;
  activeJsonc: (next: (config: FileConfig) => void) => string;
  directory: string;
  configPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-diff-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const active = await loadConfig(configPath);
  const fileJsonc = testConfigJsonc(directory, (config) => {
    transform?.(config);
    fileTransform?.(config);
  });
  await writeTestConfig(directory, configPath, fileJsonc);
  const file = await loadConfig(configPath);
  return {
    active,
    file,
    directory,
    configPath,
    activeJsonc: (next) =>
      testConfigJsonc(directory, (config) => {
        transform?.(config);
        next(config);
      }),
  };
}

function paths(changes: readonly ConfigChange[], kind: ConfigChange['kind']): string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

type ProviderEntry = FileConfig['providers'][string];
type ModelEntry = Extract<ProviderEntry, { kind: 'custom' }>['models'][number];

function spareModel(): ModelEntry {
  return {
    id: 'spare',
    reasoning: false,
    input: ['text'],
    context_window: 64_000,
    max_tokens: 4_096,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  };
}

function customModels(config: FileConfig, alias: string): readonly ModelEntry[] {
  const provider = config.providers[alias];
  if (provider === undefined || provider.kind !== 'custom') {
    throw new Error(`Expected a custom provider fixture: ${alias}`);
  }
  return provider.models;
}

test('classifies hot, restart and outside-serve fields', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.agent.thinking_level = 'high';
    config.agent.send_max_text_length = 100;
    config.agent.rate_limits.turns_per_injection = 3;
    config.agent.context.idle_grace_seconds = 40;
    config.agent.daily_budget.max_tokens = 400_000;
    config.agent.max_concurrency = 8;
    config.agent.history_messages = 5;
    config.retention.online_days = 7;
    config.paths.backups = config.paths.backups.replace('backups', 'backups2');
    config.telegram.bucket_window_seconds = 30;
    config.vision.max_output_tokens = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.context.idle_grace_seconds',
    'agent.daily_budget.max_tokens',
    'agent.history_messages',
    'agent.max_concurrency',
    'agent.rate_limits.turns_per_injection',
    'agent.send_max_text_length',
    'agent.thinking_level',
  ]);
  expect(paths(diff.changes, 'outside_serve')).toEqual(['paths.backups', 'retention.online_days']);
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.bucket_window_seconds', 'vision.max_output_tokens']);
  // Hot and outside-serve values come from the file; restart-only values stay.
  expect(diff.candidate.file.agent.thinking_level).toBe('high');
  expect(diff.candidate.file.agent.history_messages).toBe(5);
  expect(diff.candidate.file.retention.online_days).toBe(7);
  expect(diff.candidate.file.telegram.bucket_window_seconds).toBe(15);
  expect(diff.candidate.file.vision.max_output_tokens).toBe(2048);
  expect(diff.candidate.raw.agent.thinking_level).toBe('high');
});

test('reports prompt content and path changes on the prompt field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-diff-prompt-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const active = await loadConfig(configPath);
  await writeTestConfig(directory, configPath, testConfigJsonc(directory), 'A different prompt.');
  const file = await loadConfig(configPath);
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.system_prompt_file']);
  expect(diff.candidate.raw.agent.system_prompt).toBe('A different prompt.');
});

test('aligns chats by id and keeps an active-only chat in the candidate', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats = [{ id: 111, instructions_file: 'chat-instructions.md' }];
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[111]', 'telegram.chats[123456789]']);
  // The removed chat waits for a restart, so it keeps the active instructions.
  expect(diff.candidate.file.telegram.chats.map((chat) => chat.id)).toEqual([123456789]);
  expect(diff.candidate.raw.telegram.chats.map((chat) => chat.instructions)).toEqual(['private']);
});

test('treats a chat field other than instructions as restart-only', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789].timezone']);
  expect(diff.candidate.file.telegram.chats[0]?.timezone).toBeUndefined();
});

test('adds, removes and edits provider models as hot changes in file order', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: 'spare-secret',
        models: [
          { ...spareModel(), id: 'spare-a' },
          { ...spareModel(), id: 'spare-b' },
        ],
      };
    },
    (config) => {
      const provider = config.providers.spare;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models = [
        { ...spareModel(), id: 'spare-b', context_window: 100_000 },
        { ...spareModel(), id: 'spare-c' },
      ];
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'providers.spare.models[spare-a]',
    'providers.spare.models[spare-b]',
    'providers.spare.models[spare-c]',
  ]);
  expect(customModels(diff.candidate.file, 'spare').map((model) => [model.id, model.context_window])).toEqual([
    ['spare-b', 100_000],
    ['spare-c', 64_000],
  ]);
});

test('keeps the definition of a model the candidate still uses', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.models[0]!.context_window = 100_000;
    // The vision model is in use too, and vision stays on the active value.
    const vision = config.providers.vision;
    if (vision?.kind !== 'custom') {
      throw new Error('Expected a custom vision provider fixture');
    }
    vision.models[0]!.max_tokens = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([
    'providers.agent.models[agent-model]',
    'providers.vision.models[vision-model]',
  ]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => model.context_window)).toEqual([200_000]);
  expect(customModels(diff.candidate.file, 'vision').map((model) => model.max_tokens)).toEqual([8_192]);
});

test('a model is hot once the agent points at another one', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.models = [
      { ...provider.models[0]!, context_window: 100_000 },
      { ...provider.models[0]!, id: 'agent-model-2' },
    ];
    config.agent.model = 'agent-model-2';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.model',
    'providers.agent.models[agent-model-2]',
    'providers.agent.models[agent-model]',
  ]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => [model.id, model.context_window])).toEqual([
    ['agent-model', 100_000],
    ['agent-model-2', 200_000],
  ]);
});

test('editing the model the agent switches to in the same change is hot', async () => {
  // The target is not in use yet, so its new definition applies together with
  // the switch instead of waiting for a restart.
  const { active, file } = await loadBoth(
    (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models = [provider.models[0]!, { ...provider.models[0]!, id: 'agent-model-2' }];
    },
    (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models[1]!.context_window = 100_000;
      config.agent.model = 'agent-model-2';
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.model', 'providers.agent.models[agent-model-2]']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => [model.id, model.context_window])).toEqual([
    ['agent-model', 200_000],
    ['agent-model-2', 100_000],
  ]);
});

test('an agent pointing at a new provider waits for a restart', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.providers.extra = {
      kind: 'custom',
      base_url: 'https://example.test/v1',
      api: 'openai-responses',
      api_key: 'extra-secret',
      models: [
        {
          id: 'extra-model',
          reasoning: false,
          input: ['text'],
          context_window: 64_000,
          max_tokens: 4_096,
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
        },
      ],
    };
    config.agent.provider = 'extra';
    config.agent.model = 'extra-model';
    config.agent.thinking_level = 'high';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['agent.model', 'agent.provider', 'providers.extra']);
  expect(paths(diff.changes, 'hot')).toEqual(['agent.thinking_level']);
  expect(diff.candidate.file.agent).toMatchObject({ provider: 'agent', model: 'agent-model' });
});

test('a provider connection change is restart-only and keeps the active provider', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.base_url = 'https://other.test/v1';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['providers.agent.base_url']);
  expect(diff.candidate.file.providers.agent).toMatchObject({ base_url: 'https://example.test/v1' });
});

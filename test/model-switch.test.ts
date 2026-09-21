import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface SwitcherFixture {
  readonly switcher: AgentModelSwitcher;
  readonly configStore: RuntimeConfigurationStore;
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
}

async function switcherWith(transform?: (config: FileConfig) => void): Promise<SwitcherFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-switch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  return { switcher: new AgentModelSwitcher(configStore), configStore, loaded };
}

function addImageOnlyModel(config: FileConfig): void {
  const provider = config.providers.agent;
  if (provider?.kind !== 'custom') {
    throw new Error('Expected custom agent provider fixture');
  }
  provider.models.push({
    id: 'vision-only',
    name: 'Vision Only',
    reasoning: false,
    input: ['image'],
    context_window: 64000,
    max_tokens: 4096,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  });
}

test('lists text-capable models of configured providers', async () => {
  const { switcher } = await switcherWith(addImageOnlyModel);
  const options = switcher.list();
  expect(options.map((option) => `${option.provider}/${option.model}`)).toEqual([
    'agent/agent-model',
    'vision/vision-model',
  ]);
  expect(options[0]).toMatchObject({ name: 'Agent Model', contextWindow: 200_000, maxTokens: 32_768 });
});

test('current and model default to the configured agent model', async () => {
  const { switcher } = await switcherWith();
  expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model', maxTokens: 32_768 });
  expect(switcher.model().id).toBe('agent-model');
  expect(switcher.model().provider).toBe('agent');
});

test('option validates a target without applying it', async () => {
  const { switcher } = await switcherWith();
  expect(switcher.option('vision', 'vision-model')).toMatchObject({
    provider: 'vision',
    model: 'vision-model',
    maxTokens: 8_192,
  });
  // Validating is not switching: the model in use comes from the configuration.
  expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
  expect(switcher.model().id).toBe('agent-model');
});

test('current and model follow the published configuration', async () => {
  const { switcher, configStore, loaded } = await switcherWith();
  configStore.publish({
    config: {
      ...loaded.config,
      agent: { ...loaded.config.agent, provider: 'vision', model: 'vision-model' },
    },
    hash: 'published',
    models: configStore.current().models,
    visionModel: configStore.current().visionModel,
  });
  expect(switcher.current()).toMatchObject({ provider: 'vision', model: 'vision-model' });
  expect(switcher.model().id).toBe('vision-model');
});

test('rejects unknown providers, unknown models and image-only models', async () => {
  const { switcher } = await switcherWith(addImageOnlyModel);
  // Message-based assertions keep the failure output explicit.
  expect(() => switcher.option('ghost', 'agent-model')).toThrowError('Provider ghost is not configured');
  expect(() => switcher.option('agent', 'ghost-model')).toThrowError('Model agent/ghost-model is not registered');
  expect(() => switcher.option('agent', 'vision-only')).toThrowError(
    'Model agent/vision-only does not accept text input',
  );
  expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
});

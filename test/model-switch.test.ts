import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { createModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function switcherWith(transform?: (config: FileConfig) => void): Promise<AgentModelSwitcher> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-switch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const registry = await createModelRegistry(loaded.config, new SecretStore());
  return new AgentModelSwitcher(loaded.config, registry.models);
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
  const switcher = await switcherWith(addImageOnlyModel);
  const options = switcher.list();
  expect(options.map((option) => `${option.provider}/${option.model}`)).toEqual([
    'agent/agent-model',
    'vision/vision-model',
  ]);
  expect(options[0]).toMatchObject({ name: 'Agent Model', contextWindow: 200_000, maxTokens: 32_768 });
});

test('current and model default to the configured agent model', async () => {
  const switcher = await switcherWith();
  expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model', maxTokens: 32_768 });
  expect(switcher.model().id).toBe('agent-model');
  expect(switcher.model().provider).toBe('agent');
});

test('switch applies to the next session and reset reverts to the config default', async () => {
  const switcher = await switcherWith();
  const switched = switcher.switch('vision', 'vision-model');
  expect(switched).toMatchObject({ provider: 'vision', model: 'vision-model', maxTokens: 8_192 });
  expect(switcher.current()).toMatchObject({ provider: 'vision', model: 'vision-model' });
  expect(switcher.model().id).toBe('vision-model');
  expect(switcher.reset()).toMatchObject({ provider: 'agent', model: 'agent-model' });
  expect(switcher.model().id).toBe('agent-model');
});

test('rejects unknown providers, unknown models and image-only models', async () => {
  const switcher = await switcherWith(addImageOnlyModel);
  // Message-based assertions: bun:test mis-evaluates instanceof against
  // classes imported from another module inside toThrowError predicates.
  expect(() => switcher.switch('ghost', 'agent-model')).toThrowError('Provider ghost is not configured');
  expect(() => switcher.switch('agent', 'ghost-model')).toThrowError('Model agent/ghost-model is not registered');
  expect(() => switcher.switch('agent', 'vision-only')).toThrowError(
    'Model agent/vision-only does not accept text input',
  );
  expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
});

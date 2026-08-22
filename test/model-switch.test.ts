import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { AgentModelSwitcher } from '../src/model-switch.ts';
import { createModelRegistry } from '../src/providers.ts';
import { SecretStore } from '../src/secrets.ts';
import { testConfigToml, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function switcherWith(transform: (toml: string) => string = (toml) => toml): Promise<AgentModelSwitcher> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-switch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.toml');
  await writeTestConfig(directory, configPath, transform(testConfigToml(directory)));
  const loaded = await loadConfig(configPath);
  const registry = await createModelRegistry(loaded.config, new SecretStore());
  return new AgentModelSwitcher(loaded.config, registry.models);
}

// A second agent-provider model that cannot serve as an agent model (no text input).
const IMAGE_ONLY_MODEL = `
[[providers.agent.models]]
id = "vision-only"
name = "Vision Only"
reasoning = false
input = ["image"]
context_window = 64000
max_tokens = 4096
cost = { input = 1, output = 2, cache_read = 0.1, cache_write = 1 }
`;

test('lists text-capable models of configured providers', async () => {
  const switcher = await switcherWith((toml) =>
    toml.replace('[providers.vision]', `${IMAGE_ONLY_MODEL}[providers.vision]`),
  );
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
  const switcher = await switcherWith((toml) =>
    toml.replace('[providers.vision]', `${IMAGE_ONLY_MODEL}[providers.vision]`),
  );
  // Message-based assertions: bun:test mis-evaluates instanceof against
  // classes imported from another module inside toThrowError predicates.
  expect(() => switcher.switch('ghost', 'agent-model')).toThrowError('Provider ghost is not configured');
  expect(() => switcher.switch('agent', 'ghost-model')).toThrowError('Model agent/ghost-model is not registered');
  expect(() => switcher.switch('agent', 'vision-only')).toThrowError(
    'Model agent/vision-only does not accept text input',
  );
  // A failed switch leaves the current model untouched.
  expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
});

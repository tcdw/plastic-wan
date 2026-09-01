import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/platform/config.ts';
import { backupDatabase, SqliteStore } from '../src/store/database.ts';
import { createModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  return { directory, configPath };
}

describe('configuration', () => {
  test('accepts the complete version 1 contract', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.max_sends).toBe(6);
    expect(loaded.config.telegram.bucket_window_seconds).toBe(15);
    const agentProvider = loaded.config.providers.agent;
    expect(agentProvider?.kind).toBe('custom');
    if (agentProvider?.kind !== 'custom') {
      throw new Error('Expected the custom agent provider');
    }
    expect(agentProvider.models[0]?.compat?.supports_developer_role).toBe(false);
    const registry = await createModelRegistry(loaded.config, new SecretStore());
    expect(registry.agentModel.compat).toMatchObject({ supportsDeveloperRole: false });
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects unknown fields', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config, { unknown: true })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts zero-second bucket windows and rejects values above three hundred seconds', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 0;
      }),
    );
    expect((await loadConfig(configPath)).config.telegram.bucket_window_seconds).toBe(0);
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 301;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts an agent model without image input', async () => {
    const { directory, configPath } = await fixture();
    const config = testConfigJsonc(directory, (fileConfig) => {
      const provider = fileConfig.providers.agent;
      if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
        throw new Error('Expected custom agent provider fixture');
      }
      provider.models[0].input = ['text'];
    });
    await Bun.write(configPath, config);
    const loaded = await loadConfig(configPath);
    const registry = await createModelRegistry(loaded.config, new SecretStore());
    expect(registry.agentModel.input).toEqual(['text']);
  });

  test('rejects a vision model without image input', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.vision;
        if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
          throw new Error('Expected custom vision provider fixture');
        }
        provider.models[0].input = ['text'];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('vision.model vision-model lacks image input capability');
  });

  test('rejects developer-role compatibility for an Anthropic adapter', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'anthropic-messages';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('supports_developer_role requires an OpenAI API adapter');
  });

  test('rejects a leftover max_output_tokens in the agent section', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config.agent, { max_output_tokens: 4096 })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts configured telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [42, 99];
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.telegram.admins).toEqual([42, 99]);
  });

  test('rejects invalid telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid Telegram admin user ID');
    await Bun.write(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [42, 42];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts JSONC comments and trailing commas', async () => {
    const { directory, configPath } = await fixture();
    const source = testConfigJsonc(directory)
      .replace('{', '{\n  // Operator-managed configuration')
      .replace('"version": 1,', '"version": 1, /* schema version */');
    await Bun.write(configPath, source.replace(/\n}\n$/, ',\n}\n'));
    expect((await loadConfig(configPath)).config.version).toBe(1);
  });

  test('rejects invalid JSONC syntax', async () => {
    const { configPath } = await fixture();
    await Bun.write(configPath, '{ "version": 1,, }');
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid JSONC');
  });
});

describe('secrets', () => {
  test('removes one trailing newline and redacts exact values', async () => {
    const store = new SecretStore();
    const value = await store.resolve({ command: [process.execPath, '-e', "process.stdout.write('secret-value\\n')"] });
    expect(value).toBe('secret-value');
    expect(store.redact('failed secret-value request')).toBe('failed [REDACTED] request');
  });
});

describe('database', () => {
  test('applies migrations and creates a consistent backup', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    const version = store.db
      .query<{ version: bigint }, []>('SELECT MAX(version) AS version FROM schema_migrations')
      .get();
    expect(version?.version).toBe(14n);
    store.close();

    const backupPath = await backupDatabase(config);
    expect(await Bun.file(backupPath).exists()).toBe(true);
  });
});

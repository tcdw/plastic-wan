import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/platform/config.ts';
import { createModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { backupDatabase, SqliteStore } from '../src/store/database.ts';
import { schemaMigrations } from '../src/store/schema.ts';
import { pathExists, testConfigJsonc, writeTestConfig } from './helpers.ts';

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
    expect(loaded.config.agent.context.idle_grace_seconds).toBe(0);
    expect(loaded.config.agent.rate_limits.sends_per_window).toBe(6);
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
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config, { unknown: true })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects the removed per-invocation limits', async () => {
    const { directory, configPath } = await fixture();
    for (const key of ['max_turns', 'max_sends', 'timeout_seconds'] as const) {
      await writeFile(
        configPath,
        testConfigJsonc(directory, (config) => Object.assign(config.agent, { [key]: 5 })),
      );
      // The error has to name the offending key, otherwise the operator is left diffing by hand.
      await expect(loadConfig(configPath)).rejects.toThrow(key);
    }
  });

  test('enforces the Conversation Context invariants', async () => {
    const { directory, configPath } = await fixture();
    const reload = async (transform: Parameters<typeof testConfigJsonc>[1]): Promise<unknown> => {
      await writeFile(configPath, testConfigJsonc(directory, transform));
      return loadConfig(configPath);
    };
    // A target that is not below the trigger threshold can never converge.
    await expect(
      reload((config) => {
        config.agent.context.retained_sends_target = config.agent.context.retained_sends_max;
      }),
    ).rejects.toThrow('retained_sends_target must be smaller');
    // GC has to run before the closing mode takes over.
    await expect(
      reload((config) => {
        config.agent.context.hard_token_ratio = 0.9;
      }),
    ).rejects.toThrow('hard_token_ratio');
    // A grace shorter than one bucket window would look enabled while every run
    // ends before the next bucket is due.
    await expect(
      reload((config) => {
        config.telegram.bucket_window_seconds = 15;
        config.agent.context.idle_grace_seconds = 5;
      }),
    ).rejects.toThrow('idle_grace_seconds must be 0');
    // 0 is the supported way to turn long-lived invocations off.
    await expect(
      reload((config) => {
        config.agent.context.idle_grace_seconds = 0;
      }),
    ).resolves.toBeDefined();
    await expect(
      reload((config) => {
        config.agent.context.idle_grace_seconds = 15;
      }),
    ).resolves.toBeDefined();
    await expect(
      reload((config) => {
        config.agent.context.idle_grace_seconds = 15;
        config.agent.context.max_wall_clock_seconds = 15;
      }),
    ).rejects.toThrow('max_wall_clock_seconds must exceed');
  });

  test('accepts zero-second bucket windows and rejects values above three hundred seconds', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 0;
      }),
    );
    expect((await loadConfig(configPath)).config.telegram.bucket_window_seconds).toBe(0);
    await writeFile(
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
    await writeFile(configPath, config);
    const loaded = await loadConfig(configPath);
    const registry = await createModelRegistry(loaded.config, new SecretStore());
    expect(registry.agentModel.input).toEqual(['text']);
  });

  test('rejects a vision model without image input', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
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
    await writeFile(
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
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config.agent, { max_output_tokens: 4096 })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts chat-scoped ignored Telegram user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [42, 99];
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.telegram.chats[0]?.ignored_user_ids).toEqual([42, 99]);
  });

  test('rejects invalid chat-scoped ignored Telegram user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [42, 42];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid ignored Telegram user ID in chat 123456789');
  });

  test('accepts configured telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
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
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid Telegram admin user ID');
    await writeFile(
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
    await writeFile(configPath, source.replace(/\n}\n$/, ',\n}\n'));
    expect((await loadConfig(configPath)).config.version).toBe(1);
  });

  test('rejects invalid JSONC syntax', async () => {
    const { configPath } = await fixture();
    await writeFile(configPath, '{ "version": 1,, }');
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid JSONC');
  });

  test('strips HTML comments from prompt files', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      '# Persona\n<!-- Why this rule exists: operators read the file too -->\nStay kind.\n',
      'private<!-- and keep quiet -->',
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.system_prompt).toBe('# Persona\nStay kind.\n');
    expect(loaded.config.telegram.chats[0]?.instructions).toBe('private');
  });

  test('ignores template expressions inside prompt annotations', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      'You run as {{ agent.model }}.<!-- {{ agent.api_key }} is an annotation, not a template -->',
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.system_prompt).toBe('You run as {{ agent.model }}.');
  });

  test('a comment-only prompt edit still changes the config hash', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '# Persona\nStay kind.\n');
    const plain = await loadConfig(configPath);
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '# Persona\n<!-- note -->\nStay kind.\n');
    const annotated = await loadConfig(configPath);
    expect(annotated.config.agent.system_prompt).toBe(plain.config.agent.system_prompt);
    expect(annotated.hash).not.toBe(plain.hash);
  });

  test('rejects a system prompt that holds nothing but annotations', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '<!-- TODO: write the persona -->\n');
    await expect(loadConfig(configPath)).rejects.toThrow('is empty or contains only HTML comments');
  });

  test('rejects a prompt file containing a NUL character', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), 'Persona\u0000here');
    await expect(loadConfig(configPath)).rejects.toThrow('contains a NUL character');
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
  test('closing the store invalidates prepared ORM queries and releases the file', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      const prepared = store.orm.select().from(schemaMigrations).prepare();
      expect(prepared.all()).toHaveLength(17);
      store.close();
      expect(() => prepared.all()).toThrow();
      await unlink(config.paths.database);
      expect(await pathExists(config.paths.database)).toBe(false);
    } finally {
      store.db.close(true);
    }
  });

  test('applies migrations, creates a consistent backup, and releases the source file', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    const version = store.db
      .query<{ version: bigint }, []>('SELECT MAX(version) AS version FROM schema_migrations')
      .get();
    expect(version?.version).toBe(17n);
    store.close();

    const backupPath = await backupDatabase(config);
    expect(await pathExists(backupPath)).toBe(true);
    await unlink(config.paths.database);
    expect(await pathExists(config.paths.database)).toBe(false);
  });

  test('a failed backup releases the source file after running ORM queries', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      store.db.exec('DROP TABLE telegram_updates');
    } finally {
      store.close();
    }

    await expect(backupDatabase(config)).rejects.toThrow('telegram_updates');
    await unlink(config.paths.database);
    expect(await pathExists(config.paths.database)).toBe(false);
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFileIfPresent } from '../src/platform/load-env.ts';

const directories: string[] = [];
const envKeys: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const key of envKeys.splice(0)) {
    delete process.env[key];
  }
});

describe('environment file loading', () => {
  test('is a no-op when the file is missing', () => {
    const missing = join(tmpdir(), 'plasticwan-env-absent');
    expect(() => loadEnvFileIfPresent(missing)).not.toThrow();
  });

  test('loads variables from an existing file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-'));
    directories.push(directory);
    envKeys.push('PLASTICWAN_TEST_ENV_LOADED');
    await writeFile(join(directory, '.env'), 'PLASTICWAN_TEST_ENV_LOADED=yes\n');
    loadEnvFileIfPresent(join(directory, '.env'));
    expect(process.env.PLASTICWAN_TEST_ENV_LOADED).toBe('yes');
  });

  test('never overrides variables already present in the environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plasticwan-'));
    directories.push(directory);
    process.env.PLASTICWAN_TEST_ENV_PRECEDENCE = 'from-process';
    envKeys.push('PLASTICWAN_TEST_ENV_PRECEDENCE');
    await writeFile(join(directory, '.env'), 'PLASTICWAN_TEST_ENV_PRECEDENCE=from-file\n');
    loadEnvFileIfPresent(join(directory, '.env'));
    expect(process.env.PLASTICWAN_TEST_ENV_PRECEDENCE).toBe('from-process');
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles } from '../src/platform/load-env.ts';

const directories: string[] = [];
const envKeys: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
  for (const key of envKeys.splice(0)) {
    delete process.env[key];
  }
});

async function workingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-env-'));
  directories.push(directory);
  process.chdir(directory);
  return directory;
}

describe('environment file loading', () => {
  test('is a no-op when no env files exist', async () => {
    await workingDirectory();
    expect(() => loadEnvFiles(['.env.local', '.env'])).not.toThrow();
  });

  test('loads variables from .env.local and .env', async () => {
    const directory = await workingDirectory();
    envKeys.push('PLASTICWAN_TEST_ENV_LOCAL', 'PLASTICWAN_TEST_ENV_FILE');
    await writeFile(join(directory, '.env.local'), 'PLASTICWAN_TEST_ENV_LOCAL=from-local\n');
    await writeFile(join(directory, '.env'), 'PLASTICWAN_TEST_ENV_FILE=from-file\n');
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.PLASTICWAN_TEST_ENV_LOCAL).toBe('from-local');
    expect(process.env.PLASTICWAN_TEST_ENV_FILE).toBe('from-file');
  });

  test('keeps the real environment and .env.local ahead of .env', async () => {
    const directory = await workingDirectory();
    process.env.PLASTICWAN_TEST_ENV_PRECEDENCE = 'from-process';
    envKeys.push('PLASTICWAN_TEST_ENV_PRECEDENCE', 'PLASTICWAN_TEST_ENV_LOCALITY');
    await writeFile(
      join(directory, '.env.local'),
      'PLASTICWAN_TEST_ENV_PRECEDENCE=from-local\nPLASTICWAN_TEST_ENV_LOCALITY=from-local\n',
    );
    await writeFile(
      join(directory, '.env'),
      'PLASTICWAN_TEST_ENV_PRECEDENCE=from-file\nPLASTICWAN_TEST_ENV_LOCALITY=from-file\n',
    );
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.PLASTICWAN_TEST_ENV_PRECEDENCE).toBe('from-process');
    expect(process.env.PLASTICWAN_TEST_ENV_LOCALITY).toBe('from-local');
  });

  test('tolerates a UTF-8 BOM on the first line', async () => {
    const directory = await workingDirectory();
    envKeys.push('PLASTICWAN_TEST_ENV_BOM');
    // PowerShell 5 and legacy Notepad write this BOM; without stripping it the
    // first key silently becomes "\uFEFFKEY" and the variable stays unset.
    await writeFile(join(directory, '.env.local'), '\uFEFFPLASTICWAN_TEST_ENV_BOM=yes\n');
    loadEnvFiles(['.env.local', '.env']);
    expect(process.env.PLASTICWAN_TEST_ENV_BOM).toBe('yes');
  });
});

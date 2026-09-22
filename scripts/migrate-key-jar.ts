import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type ParseError, parse } from 'jsonc-parser';
import { plaintextSecrets } from '../src/platform/config.ts';
import { secretEdit, writeConfigEdits } from '../src/platform/config-file.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';

/**
 * One-off: moves the plaintext secrets of a configuration written before the key
 * jar existed into `key.json` next to it, leaving `{ "jar": "<name>" }`
 * references in their place. Nothing else in the repository uses this file;
 * delete it once every environment has been migrated.
 *
 *   node scripts/migrate-key-jar.ts --config dev-data/config.jsonc
 *
 * `check-config` on the old file lists the fields this will move. The write
 * goes through `writeConfigEdits`, so the file must already be mode 0600 in a
 * 0700 directory; comments and formatting are kept, the result is validated
 * before it replaces the file, and only field paths are printed, never a value.
 * Running it again on a migrated file changes nothing.
 *
 * The Docker image does not ship `scripts/`: run it from a checkout against the
 * host's `./config/config.jsonc` before starting a new image, which refuses
 * plaintext secrets.
 */
function parseConfigPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || argv[1] === undefined || argv[1].length === 0) {
    throw new Error('Usage: node scripts/migrate-key-jar.ts --config <path>');
  }
  return resolve(argv[1]);
}

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const source = await readFile(configPath, 'utf8');
  const errors: ParseError[] = [];
  const parsed = parse(source.replace(/^﻿/, ''), errors, { allowTrailingComma: true }) as unknown;
  if (parsed === undefined || errors.length > 0) {
    throw new Error(`Config is not valid JSONC: ${configPath}`);
  }
  const secrets = plaintextSecrets(parsed);
  if (secrets.length > 0) {
    await writeConfigEdits(
      configPath,
      secrets.map((secret) => secretEdit(secret.path, secret.value)),
    );
  }
  console.log(
    JSON.stringify({
      status: 'ok',
      config: configPath,
      key_jar: keyJarPath(configPath),
      moved: secrets.map((secret) => secret.path.join('.')),
    }),
  );
}

main().catch((error: unknown) => {
  // A failed write reports paths and validation messages, never the file text.
  console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

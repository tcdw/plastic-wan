import { Database } from 'bun:sqlite';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ServeLock } from '../src/database.ts';
import { scrubModelRequestAuditJson } from '../src/model-request-audit.ts';

interface RequestRow {
  readonly id: bigint;
  readonly request_json: string;
}

interface Options {
  readonly database: string;
  readonly backup: boolean;
}

const BATCH_SIZE = 100;

function parseOptions(argv: readonly string[]): Options {
  let database: string | undefined;
  let backup = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database') {
      database = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--no-backup') {
      backup = false;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }
  if (database === undefined || database.length === 0) {
    throw new Error(
      'Usage: bun run scripts/scrub-model-request-images.ts --database <path> [--no-backup]',
    );
  }
  return { database: resolve(database), backup };
}

function timestampForFile(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

function assertIntegrity(database: Database, phase: string): void {
  const rows = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw new Error(`${phase} integrity_check failed: ${JSON.stringify(rows)}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseFile = Bun.file(options.database);
  if (!(await databaseFile.exists())) {
    throw new Error(`Database does not exist: ${options.database}`);
  }

  const dataDir = dirname(options.database);
  const lock = await ServeLock.acquire(dataDir);
  let database: Database | undefined;
  try {
    const beforeBytes = (await stat(options.database)).size;
    database = new Database(options.database, { create: false, strict: true, safeIntegers: true });
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = FULL;');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    assertIntegrity(database, 'before migration');

    const table = database
      .query<{ present: bigint }, []>(
        "SELECT 1 AS present FROM pragma_table_info('model_calls') WHERE name = 'request_json'",
      )
      .get();
    if (table === null) {
      throw new Error('model_calls.request_json does not exist');
    }

    let backupPath: string | null = null;
    if (options.backup) {
      database.close();
      database = undefined;
      const backupDir = join(dataDir, 'backups');
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      backupPath = join(
        backupDir,
        `before-request-image-scrub-${timestampForFile()}-${basename(options.database)}`,
      );
      await copyFile(options.database, backupPath);
      database = new Database(options.database, { create: false, strict: true, safeIntegers: true });
      database.exec('PRAGMA journal_mode = WAL;');
      database.exec('PRAGMA synchronous = FULL;');
      database.exec('PRAGMA foreign_keys = ON;');
      database.exec('PRAGMA busy_timeout = 5000;');
    }

    let lastId = 0n;
    let rowsUpdated = 0;
    let imagesRemoved = 0;
    let removedCharacters = 0;
    let decodedBytes = 0;
    while (true) {
      const rows = database
        .query<RequestRow, [bigint, bigint]>(
          `SELECT id, request_json
           FROM model_calls
           WHERE id > ?
             AND request_json IS NOT NULL
           ORDER BY id
           LIMIT ?`,
        )
        .all(lastId, BigInt(BATCH_SIZE));
      if (rows.length === 0) {
        break;
      }
      database
        .transaction(() => {
          const update = database?.query(
            'UPDATE model_calls SET request_json = ? WHERE id = ? AND request_json = ?',
          );
          if (update === undefined) {
            throw new Error('Database closed during migration');
          }
          for (const row of rows) {
            const scrubbed = scrubModelRequestAuditJson(row.request_json);
            if (scrubbed.replacements === 0) {
              continue;
            }
            const result = update.run(scrubbed.json, row.id, row.request_json);
            if (result.changes !== 1) {
              throw new Error(`Concurrent modification detected for model_calls.id=${row.id}`);
            }
            rowsUpdated += 1;
            imagesRemoved += scrubbed.replacements;
            removedCharacters += scrubbed.removedCharacters;
            decodedBytes += scrubbed.decodedBytes;
          }
        })
        .immediate();
      const finalRow = rows.at(-1);
      if (finalRow === undefined) {
        throw new Error('Unexpected empty migration batch');
      }
      lastId = finalRow.id;
    }

    const remaining = database
      .query<{ count: bigint }, []>(
        `SELECT COUNT(*) AS count
         FROM model_calls
         WHERE request_json IS NOT NULL
           AND lower(request_json) LIKE '%data:image/%;base64,%'`,
      )
      .get();
    if (remaining === null || remaining.count !== 0n) {
      throw new Error(`Inline image data remains in ${remaining?.count.toString() ?? 'unknown'} rows`);
    }

    assertIntegrity(database, 'after scrub');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    database.exec('VACUUM;');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    assertIntegrity(database, 'after vacuum');
    database.close();
    database = undefined;

    const afterBytes = (await stat(options.database)).size;
    console.log(
      JSON.stringify({
        status: 'ok',
        database: options.database,
        backup: backupPath,
        rows_updated: rowsUpdated,
        images_removed: imagesRemoved,
        decoded_image_bytes_removed: decodedBytes,
        json_characters_removed: removedCharacters,
        before_bytes: beforeBytes,
        after_bytes: afterBytes,
        reclaimed_bytes: beforeBytes - afterBytes,
      }),
    );
  } finally {
    database?.close();
    await lock.release();
  }
}

await main();

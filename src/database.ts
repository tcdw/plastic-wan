import { Database } from 'bun:sqlite';
import { chmod, type FileHandle, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { RawConfig } from './config.ts';
import * as schema from './schema.ts';
import { chatMigrations, chatPause, toolCalls } from './schema.ts';

/** Typed query layer over the raw Bun SQLite connection. */
export type Orm = BunSQLiteDatabase<typeof schema>;

/**
 * The bun-sqlite drizzle driver types `.run()` as `void`, but at runtime it
 * returns the native result with `changes`. Use this whenever a write needs
 * its affected-row count.
 */
export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export function asRunResult(result: unknown): SqliteRunResult {
  return result as SqliteRunResult;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class ServeLock {
  readonly #path: string;
  readonly #handle: FileHandle;

  private constructor(path: string, handle: FileHandle) {
    this.#path = path;
    this.#handle = handle;
  }

  static async acquire(dataDir: string): Promise<ServeLock> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, 'serve.lock');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, { encoding: 'utf8' });
        return new ServeLock(path, handle);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'EEXIST' || attempt > 0) {
          throw new Error(`Another serve process holds ${path}`);
        }
        const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
        if (Number.isInteger(pid) && isProcessAlive(pid)) {
          throw new Error(`Another serve process holds ${path} with PID ${pid}`);
        }
        await unlink(path);
      }
    }
    throw new Error(`Unable to acquire serve lock: ${path}`);
  }

  async release(): Promise<void> {
    await this.#handle.close();
    await unlink(this.#path).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

export class SqliteStore {
  readonly db: Database;
  /** Drizzle query layer. Use sync methods (`.all()`, `.get()`, `.run()`, `.values()`) so statements execute inside `transaction()`. */
  readonly orm: Orm;
  readonly path: string;

  private constructor(path: string, database: Database, orm: Orm) {
    this.path = path;
    this.db = database;
    this.orm = orm;
  }

  static async open(config: RawConfig, migrate = true): Promise<SqliteStore> {
    const path = config.paths.database;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existed = await Bun.file(path).exists();
    const database = new Database(path, { create: true, strict: true, safeIntegers: true });
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = FULL;');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 5000;');
    const store = new SqliteStore(path, database, drizzle(database, { schema }));
    try {
      if (migrate) {
        await store.migrate(config, existed);
      }
      if (process.platform !== 'win32') {
        await chmod(path, 0o600);
      }
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  private async migrate(config: RawConfig, databaseExisted: boolean): Promise<void> {
    const migrations = await loadMigrations();
    const applied = this.hasTable('schema_migrations')
      ? new Set(
          this.db
            .query<{ version: bigint }, []>('SELECT version FROM schema_migrations ORDER BY version')
            .all()
            .map((row) => Number(row.version)),
        )
      : new Set<number>();
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length === 0) {
      return;
    }
    if (databaseExisted) {
      await createBackupFile(
        this.db,
        config.paths.backups,
        `pre-migration-${timestampForFile()}-${crypto.randomUUID()}.sqlite`,
      );
    }
    for (const migration of pending) {
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .query('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(BigInt(migration.version), new Date().toISOString());
      });
    }
  }

  private hasTable(name: string): boolean {
    return this.db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  }
}

export async function backupDatabase(config: RawConfig): Promise<string> {
  await mkdir(config.paths.backups, { recursive: true, mode: 0o700 });
  const source = new Database(config.paths.database, {
    create: false,
    strict: true,
    safeIntegers: true,
  });
  try {
    source.exec('PRAGMA journal_mode = WAL;');
    source.exec('PRAGMA synchronous = FULL;');
    source.exec('PRAGMA foreign_keys = ON;');
    source.exec('PRAGMA busy_timeout = 5000;');
    const sourceOrm = drizzle(source, { schema });
    purgeExpiredData(sourceOrm, config);
    const path = await createBackupFile(
      source,
      config.paths.backups,
      `plasticwan-${timestampForFile()}-${crypto.randomUUID()}.sqlite`,
    );
    await rotateBackups(config.paths.backups, config.retention.backup_copies);
    return path;
  } finally {
    source.close();
  }
}

export function purgeExpiredData(orm: Orm, config: RawConfig, now = new Date()): void {
  const cutoff = new Date(now.getTime() - config.retention.online_days * 86_400_000).toISOString();
  orm.transaction(
    () => {
      orm.run(sql`DELETE FROM memories WHERE expires_at <= ${now.toISOString()}`);
      orm.run(sql`DELETE FROM telegram_updates WHERE received_at < ${cutoff}`);
      orm.run(sql`
      DELETE FROM telegram_sends
      WHERE tool_call_id IN (
        SELECT tc.id
        FROM tool_calls tc
        JOIN invocations i ON i.id = tc.invocation_id
        WHERE i.state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')
          AND COALESCE(i.finished_at, i.created_at) < ${cutoff}
      )
    `);
      orm.run(sql`
      DELETE FROM internal_contexts
      WHERE invocation_id IN (
        SELECT id
        FROM invocations
        WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')
          AND COALESCE(finished_at, created_at) < ${cutoff}
      )
         OR source_agent_message_id IN (
           SELECT am.id
           FROM agent_messages am
           JOIN invocations i ON i.id = am.invocation_id
           WHERE i.state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')
             AND COALESCE(i.finished_at, i.created_at) < ${cutoff}
         )
         OR created_at < ${cutoff}
    `);
      orm.run(sql`
      DELETE FROM invocations
      WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')
        AND COALESCE(finished_at, created_at) < ${cutoff}
    `);
      orm.run(sql`
      UPDATE buckets
      SET merged_into_bucket_id = NULL
      WHERE merged_into_bucket_id IN (
        SELECT id FROM buckets
        WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')
          AND COALESCE(finished_at, updated_at) < ${cutoff}
      )
    `);
      orm.run(sql`
      DELETE FROM buckets
      WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')
        AND COALESCE(finished_at, updated_at) < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM invocations i WHERE i.bucket_id = buckets.id)
    `);
      orm.run(sql`
      DELETE FROM media
      WHERE revision_id IN (
        SELECT r.id FROM message_revisions r
        JOIN messages m ON m.id = r.message_id
        WHERE m.received_at < ${cutoff}
      )
    `);
      orm.run(sql`
      UPDATE messages
      SET current_revision_id = NULL
      WHERE received_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM invocation_messages im WHERE im.message_id = messages.id)
        AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = messages.id)
    `);
      orm.run(sql`
      DELETE FROM messages
      WHERE received_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM invocation_messages im WHERE im.message_id = messages.id)
        AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = messages.id)
    `);
      orm.run(sql`
      UPDATE message_revisions
      SET sender_id = NULL,
          text = NULL,
          caption = NULL,
          reply_snapshot_json = NULL,
          forward_origin_json = NULL,
          service_json = NULL,
          raw_fragment_json = '{}'
      WHERE message_id IN (SELECT id FROM messages WHERE received_at < ${cutoff})
    `);
      orm.run(
        sql`DELETE FROM senders WHERE NOT EXISTS (SELECT 1 FROM message_revisions r WHERE r.sender_id = senders.id)`,
      );
      orm.run(sql`DELETE FROM media_analyses WHERE kind = 'image' AND updated_at < ${cutoff}`);
      orm.run(
        sql`DELETE FROM model_calls WHERE invocation_id IS NULL AND state <> 'pending' AND created_at < ${cutoff}`,
      );
      orm.run(
        sql`DELETE FROM alarms WHERE state IN ('fired', 'cancelled') AND COALESCE(fired_at, cancelled_at, updated_at) < ${cutoff}`,
      );
      orm.run(sql`DELETE FROM daily_usage WHERE utc_date < ${cutoff.slice(0, 10)}`);
    },
    { behavior: 'immediate' },
  );
}

export function resolveChatConfig(
  config: RawConfig,
  orm: Orm,
  chatId: bigint,
): RawConfig['telegram']['chats'][number] | undefined {
  const direct = config.telegram.chats.find((chat) => BigInt(chat.id) === chatId);
  if (direct !== undefined) {
    return direct;
  }
  const migration = orm
    .select({ oldChatId: chatMigrations.oldChatId })
    .from(chatMigrations)
    .where(eq(chatMigrations.newChatId, chatId))
    .get();
  if (migration === undefined) {
    return undefined;
  }
  return config.telegram.chats.find((chat) => BigInt(chat.id) === migration.oldChatId);
}

export function isChatPaused(orm: Orm, chatId: bigint): boolean {
  return (
    orm.select({ chatId: chatPause.chatId }).from(chatPause).where(eq(chatPause.chatId, chatId)).get() !== undefined
  );
}

export type ToolCallFinishState = 'success' | 'error' | 'outcome_unknown';

/** Inserts the pending audit row for a starting tool call and returns its rowid. */
export function startToolCall(
  orm: Orm,
  invocationId: bigint,
  toolCallId: string,
  toolName: string,
  argumentsJson: string,
  sideEffect: boolean,
  now = new Date(),
): bigint {
  const created = orm
    .insert(toolCalls)
    .values({
      invocationId,
      toolCallId,
      toolName,
      argumentsJson,
      state: 'pending',
      sideEffect,
      createdAt: now.toISOString(),
    })
    .returning({ id: toolCalls.id })
    .get();
  if (created === undefined) {
    throw new Error('tool_calls insert returned no row');
  }
  return created.id;
}

/** Inserts the already-failed audit row for a call rejected before execution started. */
export function rejectToolCall(
  orm: Orm,
  invocationId: bigint,
  toolCallId: string,
  toolName: string,
  argumentsJson: string,
  sideEffect: boolean,
  errorCode: string,
  now = new Date(),
): void {
  const at = now.toISOString();
  orm
    .insert(toolCalls)
    .values({
      invocationId,
      toolCallId,
      toolName,
      argumentsJson,
      state: 'error',
      sideEffect,
      errorCode,
      createdAt: at,
      finishedAt: at,
    })
    .run();
}

/**
 * Marks a pending tool_calls row finished. Pass startedAt (a performance.now() timestamp)
 * to also record duration_ms; pendingOnly keeps rows that were already closed untouched.
 */
export function finishToolCall(
  orm: Orm,
  auditId: bigint,
  state: ToolCallFinishState,
  resultText: string | null,
  errorCode: string | null,
  options: { startedAt?: number; pendingOnly?: boolean; now?: Date } = {},
): void {
  const finishedAt = (options.now ?? new Date()).toISOString();
  const durationMs =
    options.startedAt !== undefined
      ? BigInt(Math.max(0, Math.round(performance.now() - options.startedAt)))
      : undefined;
  const pending = options.pendingOnly === true;
  orm
    .update(toolCalls)
    .set({ state, resultText, errorCode, durationMs, finishedAt })
    .where(pending ? and(eq(toolCalls.id, auditId), eq(toolCalls.state, 'pending')) : eq(toolCalls.id, auditId))
    .run();
}

async function createBackupFile(database: Database, backupDir: string, filename: string): Promise<string> {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const finalPath = join(backupDir, filename);
  const temporaryPath = `${finalPath}.tmp-${crypto.randomUUID()}`;
  database.query('VACUUM INTO ?').run(temporaryPath);
  if (process.platform !== 'win32') {
    await chmod(temporaryPath, 0o600);
  }
  await rename(temporaryPath, finalPath);
  return finalPath;
}
async function rotateBackups(backupDir: string, keep: number): Promise<void> {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
    .map((entry) => ({
      path: join(backupDir, entry.name),
      modified: Bun.file(join(backupDir, entry.name)).lastModified,
    }))
    .sort((left, right) => right.modified - left.modified);
  await Promise.all(files.slice(keep).map((file) => unlink(file.path)));
}

async function loadMigrations(): Promise<Migration[]> {
  const directory = join(import.meta.dir, 'migrations');
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    const version = Number.parseInt(name.slice(0, 3), 10);
    migrations.push({ version, name, sql: await Bun.file(join(directory, name)).text() });
  }
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.version >= current.version) {
      throw new Error(`Migration versions are not strictly increasing near ${current.name}`);
    }
  }
  return migrations;
}

function timestampForFile(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 'EPERM';
  }
}

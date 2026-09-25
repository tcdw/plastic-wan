import Database from 'better-sqlite3';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ServeLock } from '../src/store/database.ts';

// One-off repair for dev databases that ran the retired migration 018, which
// rebuilt `model_tokens` / `vision_tokens` as input + output only. The rollup is
// re-derived from `model_calls` (the source of truth) with the current
// definition, `meteredTokens` in src/store/sleep.ts: input + output + cache read
// + cache write. Keys and day boundaries mirror the runtime writers: UTC date of
// `finished_at`, chat rows keyed by `telegram_chat_id`.
//
// Each daily_usage row is only rewritten when it equals the cache-excluded sum
// of its audit rows, which proves the audit still covers that day completely.
// Anything else (retention purged part of the day, no audit rows) is reported
// and left alone rather than guessed at. A reconciled row equals the
// cache-inclusive sum, so re-running is a no-op.

export type ReconciliationStatus = 'reconcile' | 'already_reconciled' | 'unreconcilable';

export interface ReconciliationRow {
  readonly utcDate: string;
  readonly scope: string;
  readonly resource: string;
  readonly metric: string;
  readonly status: ReconciliationStatus;
  readonly reason: string | null;
  /** Current daily_usage amount; null when the row does not exist. */
  readonly oldTotal: bigint | null;
  readonly recalculatedTotal: bigint;
  readonly delta: bigint;
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly modelCalls: bigint;
}

interface AuditTotalRow {
  readonly utc_date: string;
  readonly scope: string;
  readonly resource: string;
  readonly metric: string;
  readonly input_output: bigint;
  readonly cache_read: bigint;
  readonly cache_write: bigint;
  readonly calls: bigint;
}

interface DailyUsageRow {
  readonly utc_date: string;
  readonly scope: string;
  readonly resource: string;
  readonly metric: string;
  readonly amount: bigint;
}

const AUDIT_TOTALS_SQL = `
  SELECT substr(COALESCE(mc.finished_at, mc.created_at), 1, 10) AS utc_date,
         'chat' AS scope,
         CAST(ch.telegram_chat_id AS TEXT) AS resource,
         'model_tokens' AS metric,
         SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0)) AS input_output,
         SUM(COALESCE(mc.cache_read_tokens, 0)) AS cache_read,
         SUM(COALESCE(mc.cache_write_tokens, 0)) AS cache_write,
         COUNT(*) AS calls
    FROM model_calls mc
    JOIN invocations i ON i.id = mc.invocation_id
    JOIN conversations c ON c.id = i.conversation_id
    JOIN chats ch ON ch.id = c.chat_id
   WHERE mc.role IN ('agent', 'vision_chat')
   GROUP BY 1, 3
  UNION ALL
  SELECT substr(COALESCE(finished_at, created_at), 1, 10),
         'system',
         'sticker_index',
         'vision_tokens',
         SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)),
         SUM(COALESCE(cache_read_tokens, 0)),
         SUM(COALESCE(cache_write_tokens, 0)),
         COUNT(*)
    FROM model_calls
   WHERE role = 'vision_sticker'
   GROUP BY 1`;

function key(row: { utc_date: string; scope: string; resource: string; metric: string }): string {
  return `${row.utc_date}|${row.scope}|${row.resource}|${row.metric}`;
}

function planRows(database: Database.Database): ReconciliationRow[] {
  const audit = new Map(
    database
      .prepare<[], AuditTotalRow>(AUDIT_TOTALS_SQL)
      .all()
      .map((row) => [key(row), row]),
  );
  const usage = new Map(
    database
      .prepare<[], DailyUsageRow>(
        "SELECT utc_date, scope, resource, metric, amount FROM daily_usage WHERE metric IN ('model_tokens', 'vision_tokens')",
      )
      .all()
      .map((row) => [key(row), row]),
  );
  const keys = [...new Set([...audit.keys(), ...usage.keys()])].sort();
  return keys.map((rowKey) => {
    const source = audit.get(rowKey);
    const current = usage.get(rowKey);
    const identity = source ?? current;
    if (identity === undefined) {
      throw new Error(`Unreachable reconciliation key ${rowKey}`);
    }
    const inputOutput = source?.input_output ?? 0n;
    const cacheRead = source?.cache_read ?? 0n;
    const cacheWrite = source?.cache_write ?? 0n;
    const recalculated = inputOutput + cacheRead + cacheWrite;
    const oldTotal = current?.amount ?? null;
    const base = {
      utcDate: identity.utc_date,
      scope: identity.scope,
      resource: identity.resource,
      metric: identity.metric,
      oldTotal,
      recalculatedTotal: recalculated,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      modelCalls: source?.calls ?? 0n,
    };
    if ((oldTotal ?? 0n) === recalculated) {
      return { ...base, status: 'already_reconciled', reason: null, delta: 0n };
    }
    if ((oldTotal ?? 0n) === inputOutput) {
      return { ...base, status: 'reconcile', reason: null, delta: recalculated - (oldTotal ?? 0n) };
    }
    const reason =
      source === undefined
        ? 'no model_calls rows for this day; the audit was purged by retention or predates it'
        : `daily total matches neither input+output (${inputOutput}) nor the full sum (${recalculated}) of its model_calls; the audit no longer covers the whole day`;
    return { ...base, status: 'unreconcilable', reason, delta: 0n };
  });
}

/**
 * Plans the reconciliation and, with `apply`, rewrites every `reconcile` row
 * in the same immediate transaction the plan was read in.
 */
export function reconcileDailyTokenUsage(
  database: Database.Database,
  options: { readonly apply: boolean; readonly now?: Date },
): ReconciliationRow[] {
  const run = database.transaction(() => {
    const rows = planRows(database);
    if (!options.apply) {
      return rows;
    }
    const updatedAt = (options.now ?? new Date()).toISOString();
    const update = database.prepare(
      'UPDATE daily_usage SET amount = ?, updated_at = ? WHERE utc_date = ? AND scope = ? AND resource = ? AND metric = ? AND amount = ?',
    );
    const insert = database.prepare(
      'INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of rows) {
      if (row.status !== 'reconcile') {
        continue;
      }
      const result =
        row.oldTotal === null
          ? insert.run(row.utcDate, row.scope, row.resource, row.metric, row.recalculatedTotal, updatedAt)
          : update.run(
              row.recalculatedTotal,
              updatedAt,
              row.utcDate,
              row.scope,
              row.resource,
              row.metric,
              row.oldTotal,
            );
      if (result.changes !== 1) {
        throw new Error(`Concurrent modification of daily_usage ${row.utcDate} ${row.scope}/${row.resource}`);
      }
    }
    return rows;
  });
  return options.apply ? run.immediate() : run.deferred();
}

interface Options {
  readonly database: string;
  readonly apply: boolean;
  readonly backup: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let database: string | undefined;
  let apply = false;
  let backup = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database') {
      database = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--no-backup') {
      backup = false;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }
  if (database === undefined || database.length === 0) {
    throw new Error('Usage: node scripts/reconcile-daily-token-usage.ts --database <path> [--apply] [--no-backup]');
  }
  return { database: resolve(database), apply, backup };
}

function printReport(rows: readonly ReconciliationRow[], applied: boolean, backup: string | null): void {
  const shown = rows.filter((row) => row.status !== 'already_reconciled');
  if (shown.length > 0) {
    console.table(
      shown.map((row) => ({
        day: row.utcDate,
        resource: `${row.scope}/${row.resource}`,
        metric: row.metric,
        status: row.status,
        old_total: row.oldTotal?.toString() ?? '(none)',
        recalculated: row.recalculatedTotal.toString(),
        delta: row.delta.toString(),
        cache_read: row.cacheReadTokens.toString(),
        cache_write: row.cacheWriteTokens.toString(),
      })),
    );
  }
  for (const row of rows) {
    if (row.status === 'unreconcilable') {
      console.log(`unreconcilable ${row.utcDate} ${row.scope}/${row.resource} ${row.metric}: ${row.reason ?? ''}`);
    }
  }
  const reconciled = rows.filter((row) => row.status === 'reconcile');
  console.log(
    JSON.stringify({
      mode: applied ? 'apply' : 'dry-run',
      backup,
      rows: rows.length,
      reconcile: reconciled.length,
      already_reconciled: rows.filter((row) => row.status === 'already_reconciled').length,
      unreconcilable: rows.filter((row) => row.status === 'unreconcilable').length,
      affected_days: [...new Set(reconciled.map((row) => row.utcDate))],
      total_delta: reconciled.reduce((sum, row) => sum + row.delta, 0n).toString(),
    }),
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await access(options.database).catch(() => {
    throw new Error(`Database does not exist: ${options.database}`);
  });
  // Applying needs the runtime stopped: an old serve would keep adding
  // cache-excluded amounts, and a new one races the guarded UPDATE.
  const lock = options.apply ? await ServeLock.acquire(dirname(options.database)) : null;
  const database = new Database(options.database, { fileMustExist: true, readonly: !options.apply });
  try {
    database.defaultSafeIntegers(true);
    database.exec('PRAGMA busy_timeout = 5000;');
    let backup: string | null = null;
    if (options.apply && options.backup) {
      const backupDir = join(dirname(options.database), 'backups');
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      backup = join(
        backupDir,
        `before-token-usage-reconcile-${new Date().toISOString().replaceAll(':', '-')}-${basename(options.database)}`,
      );
      database.prepare('VACUUM INTO ?').run(backup);
    }
    printReport(reconcileDailyTokenUsage(database, { apply: options.apply }), options.apply, backup);
  } finally {
    database.close();
    await lock?.release();
  }
}

if (import.meta.main) {
  await main();
}

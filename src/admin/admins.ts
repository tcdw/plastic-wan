import type { Database } from 'bun:sqlite';
import { AdminQueryError } from './audit.ts';

export interface BotAdminItem {
  readonly telegram_user_id: string;
  readonly display_name: string;
  readonly added_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BotAdminRow {
  readonly telegram_user_id: bigint;
  readonly display_name: string;
  readonly added_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const SELECT = 'SELECT telegram_user_id, display_name, added_by, created_at, updated_at FROM bot_admins';

export function listBotAdmins(db: Database): readonly BotAdminItem[] {
  return db
    .query<BotAdminRow, []>(`${SELECT} ORDER BY created_at, telegram_user_id`)
    .all()
    .map((row) => ({ ...row, telegram_user_id: row.telegram_user_id.toString() }));
}

export function isBotAdmin(db: Database, telegramUserId: bigint): boolean {
  return (
    db
      .query<{ present: bigint }, [bigint]>('SELECT 1 AS present FROM bot_admins WHERE telegram_user_id = ?')
      .get(telegramUserId) !== null
  );
}

export function addBotAdmin(db: Database, telegramUserId: bigint, addedBy: string, now = new Date()): BotAdminItem {
  const timestamp = now.toISOString();
  const row = db
    .query<BotAdminRow, [bigint, string, string, string]>(
      `INSERT INTO bot_admins(telegram_user_id, display_name, added_by, created_at, updated_at) VALUES (?, '', ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET added_by = excluded.added_by, updated_at = excluded.updated_at
       RETURNING telegram_user_id, display_name, added_by, created_at, updated_at`,
    )
    .get(telegramUserId, addedBy, timestamp, timestamp);
  if (row === null) {
    throw new Error('Bot admin row is missing after upsert');
  }
  return { ...row, telegram_user_id: row.telegram_user_id.toString() };
}

export function removeBotAdmin(db: Database, telegramUserId: bigint): boolean {
  return db.query('DELETE FROM bot_admins WHERE telegram_user_id = ?').run(telegramUserId).changes > 0;
}

// Config-seeded admins guarantee the operator can always recover control; the
// panel remains the runtime source of truth, so seeds never remove entries.
export function seedConfigAdmins(db: Database, adminIds: readonly number[], now = new Date()): void {
  if (adminIds.length === 0) {
    return;
  }
  const timestamp = now.toISOString();
  db.transaction(() => {
    for (const adminId of adminIds) {
      db.query(
        "INSERT INTO bot_admins(telegram_user_id, display_name, added_by, created_at, updated_at) VALUES (?, '', 'config', ?, ?) ON CONFLICT(telegram_user_id) DO NOTHING",
      ).run(BigInt(adminId), timestamp, timestamp);
    }
  }).immediate();
}

export function parseAdminUserId(value: unknown, label = 'telegram_user_id'): bigint {
  const id =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,19}$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must be a positive integer`);
  }
  return BigInt(id);
}

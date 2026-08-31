import { eq } from 'drizzle-orm';
import { type Orm, asRunResult } from '../database.ts';
import { botAdmins } from '../schema.ts';
import { AdminQueryError } from './audit.ts';

export interface BotAdminItem {
  readonly telegram_user_id: string;
  readonly display_name: string;
  readonly added_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function listBotAdmins(orm: Orm): readonly BotAdminItem[] {
  return orm
    .select({
      telegramUserId: botAdmins.telegramUserId,
      displayName: botAdmins.displayName,
      addedBy: botAdmins.addedBy,
      createdAt: botAdmins.createdAt,
      updatedAt: botAdmins.updatedAt,
    })
    .from(botAdmins)
    .orderBy(botAdmins.createdAt, botAdmins.telegramUserId)
    .all()
    .map((row) => ({
      telegram_user_id: row.telegramUserId.toString(),
      display_name: row.displayName,
      added_by: row.addedBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    }));
}

export function isBotAdmin(orm: Orm, telegramUserId: bigint): boolean {
  return (
    orm
      .select({ telegramUserId: botAdmins.telegramUserId })
      .from(botAdmins)
      .where(eq(botAdmins.telegramUserId, telegramUserId))
      .get() !== undefined
  );
}

export function addBotAdmin(orm: Orm, telegramUserId: bigint, addedBy: string, now = new Date()): BotAdminItem {
  const timestamp = now.toISOString();
  const row = orm
    .insert(botAdmins)
    .values({
      telegramUserId,
      displayName: '',
      addedBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: botAdmins.telegramUserId,
      set: { addedBy, updatedAt: timestamp },
    })
    .returning({
      telegramUserId: botAdmins.telegramUserId,
      displayName: botAdmins.displayName,
      addedBy: botAdmins.addedBy,
      createdAt: botAdmins.createdAt,
      updatedAt: botAdmins.updatedAt,
    })
    .get();
  if (row === undefined) {
    throw new Error('Bot admin row is missing after upsert');
  }
  return {
    telegram_user_id: row.telegramUserId.toString(),
    display_name: row.displayName,
    added_by: row.addedBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function removeBotAdmin(orm: Orm, telegramUserId: bigint): boolean {
  return asRunResult(orm.delete(botAdmins).where(eq(botAdmins.telegramUserId, telegramUserId)).run()).changes > 0;
}

// Config-seeded admins guarantee the operator can always recover control; the
// panel remains the runtime source of truth, so seeds never remove entries.
export function seedConfigAdmins(orm: Orm, adminIds: readonly number[], now = new Date()): void {
  if (adminIds.length === 0) {
    return;
  }
  const timestamp = now.toISOString();
  orm.transaction(
    () => {
      for (const adminId of adminIds) {
        orm
          .insert(botAdmins)
          .values({
            telegramUserId: BigInt(adminId),
            displayName: '',
            addedBy: 'config',
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing({ target: botAdmins.telegramUserId })
          .run();
      }
    },
    { behavior: 'immediate' },
  );
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

import { customType, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { GenerationSnapshot, SafeError } from './contracts.ts';

/**
 * SQLite INTEGER column that maps to TypeScript `number`.
 *
 * The host connection runs `defaultSafeIntegers(true)` so every INTEGER column
 * arrives as `bigint`; image-domain values are counters and dimensions that must
 * stay plain numbers (they round-trip through JSON snapshots and API payloads,
 * where BigInt serialization would throw). `fromDriver` coerces both bigint and
 * number driver values back to `number`, keeping the core correct regardless of
 * the connection's safeIntegers mode. Values are always within the safe range.
 */
export const safeInteger = customType<{ data: number; driverData: number | bigint }>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => Number(value),
});

/**
 * Drizzle table definitions for the image domain. The authoritative DDL lives in
 * the host's numbered migrations; these definitions only describe the shape for
 * typed queries and must stay in sync. Tables are prefixed with `image_` so they
 * can live in the shared host database without colliding with host tables.
 */

export const prompts = sqliteTable(
  'image_prompts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [index('image_prompts_deleted_idx').on(table.deletedAt)],
);

export const images = sqliteTable(
  'image_assets',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    width: safeInteger('width').notNull(),
    height: safeInteger('height').notNull(),
    bytes: safeInteger('bytes').notNull(),
    sha256: text('sha256').notNull(),
    fileName: text('file_name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default(''),
    source: text('source').$type<'upload' | 'generation'>().notNull(),
    generationId: text('generation_id'),
    outputIndex: safeInteger('output_index'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    index('image_assets_deleted_idx').on(table.deletedAt),
    index('image_assets_generation_idx').on(table.generationId),
  ],
);

export const generations = sqliteTable(
  'image_generations',
  {
    id: text('id').primaryKey(),
    status: text('status').$type<'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted'>().notNull(),
    source: text('source').$type<string>().notNull(),
    actorKind: text('actor_kind').$type<string>().notNull(),
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    snapshot: text('snapshot', { mode: 'json' }).$type<GenerationSnapshot>().notNull(),
    configVersion: text('config_version').notNull(),
    round: safeInteger('round').notNull().default(1),
    error: text('error', { mode: 'json' }).$type<SafeError | null>(),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('image_generations_created_idx').on(table.createdAt),
    index('image_generations_status_idx').on(table.status),
  ],
);

export const generationAttempts = sqliteTable(
  'image_generation_attempts',
  {
    id: text('id').primaryKey(),
    generationId: text('generation_id').notNull(),
    round: safeInteger('round').notNull(),
    itemIndex: safeInteger('item_index').notNull(),
    status: text('status').$type<'running' | 'succeeded' | 'failed' | 'interrupted'>().notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    error: text('error', { mode: 'json' }).$type<SafeError | null>(),
    providerRequestId: text('provider_request_id'),
    usage: text('usage', { mode: 'json' }).$type<Record<string, number> | null>(),
    outputAssetId: text('output_asset_id'),
  },
  (table) => [
    uniqueIndex('image_attempts_round_item_idx').on(table.generationId, table.round, table.itemIndex),
    index('image_attempts_generation_idx').on(table.generationId),
  ],
);

export const idempotencyKeys = sqliteTable(
  'image_idempotency_keys',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    generationId: text('generation_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('image_idempotency_actor_operation_key_idx').on(table.actorId, table.operation, table.key)],
);

export const imageSchema = {
  prompts,
  images,
  generations,
  generationAttempts,
  idempotencyKeys,
};

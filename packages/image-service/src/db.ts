import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { imageSchema } from './schema.ts';

/**
 * Drizzle database view over the image domain tables. The host owns the SQLite
 * connection and its lifecycle; the core only receives this typed handle.
 */
export type ImageDatabase = BetterSQLite3Database<typeof imageSchema>;

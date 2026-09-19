/**
 * Pure memory-form helpers shared by the Memories page forms and list.
 * The bounds mirror the backend (`src/context/memory.ts` and
 * `src/ingress/admin/memory-admin.ts`): content is capped at 150 characters
 * and TTL days are 1..1825 (the backend stores seconds, minimum 60; the panel
 * edits at day granularity like the old frontend).
 */

export const DAY_SECONDS = 86_400;
export const MEMORY_MAX_CONTENT_LENGTH = 150;
export const TTL_MIN_DAYS = 1;
export const TTL_MAX_DAYS = 1_825;

/** Converts a TTL in days to seconds; `null`/`undefined` stays `undefined` (edit keeps current expiry). */
export function daysToTtlSeconds(days: number | null | undefined): number | undefined {
  if (days === null || days === undefined) {
    return undefined;
  }
  return days * DAY_SECONDS;
}

export function isTtlDaysValid(days: number | null | undefined): boolean {
  return days !== null && days !== undefined && Number.isInteger(days) && days >= TTL_MIN_DAYS && days <= TTL_MAX_DAYS;
}

/** Human-readable TTL: whole days when exact, else rounded hours (>= 1h), else raw seconds. */
export function formatTtl(seconds: number): string {
  if (seconds % DAY_SECONDS === 0) {
    return `${seconds / DAY_SECONDS} d`;
  }
  if (seconds >= 3_600) {
    return `${Math.round(seconds / 3_600)} h`;
  }
  return `${seconds} s`;
}

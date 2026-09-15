import { describe, expect, test } from 'bun:test';
import {
  DAY_SECONDS,
  MEMORY_MAX_CONTENT_LENGTH,
  TTL_MAX_DAYS,
  TTL_MIN_DAYS,
  daysToTtlSeconds,
  formatTtl,
  isTtlDaysValid,
} from './memory-ttl.ts';

describe('memory-ttl', () => {
  test('day-exact TTLs format as whole days', () => {
    expect(formatTtl(DAY_SECONDS)).toBe('1 d');
    expect(formatTtl(7 * DAY_SECONDS)).toBe('7 d');
    expect(formatTtl(TTL_MAX_DAYS * DAY_SECONDS)).toBe('1825 d');
  });

  test('non-day TTLs fall back to hours or seconds', () => {
    expect(formatTtl(3_600)).toBe('1 h');
    expect(formatTtl(3 * 3_600 + 1_800)).toBe('4 h');
    expect(formatTtl(45)).toBe('45 s');
    // Zero is an exact multiple of a day in the formatter, matching the old
    // panel; real rows never carry 0 (backend minimum TTL is 60 s).
    expect(formatTtl(0)).toBe('0 d');
  });

  test('daysToTtlSeconds converts valid days and preserves undefined', () => {
    expect(daysToTtlSeconds(1)).toBe(DAY_SECONDS);
    expect(daysToTtlSeconds(7)).toBe(604_800);
    expect(daysToTtlSeconds(TTL_MAX_DAYS)).toBe(157_680_000);
    expect(daysToTtlSeconds(undefined)).toBeUndefined();
    expect(daysToTtlSeconds(null)).toBeUndefined();
  });

  test('TTL day bounds match the backend range', () => {
    expect(isTtlDaysValid(1)).toBe(true);
    expect(isTtlDaysValid(365)).toBe(true);
    expect(isTtlDaysValid(TTL_MAX_DAYS)).toBe(true);
    expect(isTtlDaysValid(0)).toBe(false);
    expect(isTtlDaysValid(TTL_MAX_DAYS + 1)).toBe(false);
    expect(isTtlDaysValid(1.5)).toBe(false);
    expect(isTtlDaysValid(-7)).toBe(false);
    expect(isTtlDaysValid(null)).toBe(false);
    expect(isTtlDaysValid(undefined)).toBe(false);
  });

  test('shared constants track the backend limits', () => {
    expect(MEMORY_MAX_CONTENT_LENGTH).toBe(150);
    expect(TTL_MIN_DAYS).toBe(1);
    expect(TTL_MAX_DAYS).toBe(1_825);
  });
});

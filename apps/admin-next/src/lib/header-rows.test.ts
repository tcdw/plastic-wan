import { describe, expect, test } from 'vitest';
import { headerPayload, headerRowsFromNames, removedHeaderNames } from './header-rows.ts';

describe('header rows', () => {
  test('rows keep a stable identity that does not depend on the editable name', () => {
    const [row] = headerRowsFromNames(['x-api-key']);
    if (row === undefined) {
      throw new Error('Expected a row');
    }
    const renamed = { ...row, name: 'x-api-ke' };
    expect(renamed.id).toBe(row.id);
    const [other] = headerRowsFromNames(['x-api-key']);
    expect(other?.id).not.toBe(row.id);
  });

  test('re-adding a deleted header sends its new value instead of a deletion', () => {
    const rows = [{ id: 'new', name: 'x-api-key', value: 'replacement', existing: false }];
    const removed = removedHeaderNames(['x-api-key'], rows);
    expect(removed).toEqual([]);
    expect(headerPayload(rows, removed)).toEqual({ headers: { 'x-api-key': 'replacement' }, error: null });
  });

  test('a removal still wins over nothing and never over a value for the same name', () => {
    expect(headerPayload([], ['x-old'])).toEqual({ headers: { 'x-old': null }, error: null });
    const rows = [{ id: 'new', name: 'x-old', value: 'v', existing: false }];
    expect(headerPayload(rows, ['x-old'])).toEqual({ headers: { 'x-old': 'v' }, error: null });
  });
});

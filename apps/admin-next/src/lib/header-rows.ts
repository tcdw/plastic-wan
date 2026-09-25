/**
 * Pure header-row logic behind `HeaderFields`, kept out of the component so it
 * can be unit tested without the UI.
 */
export interface HeaderRow {
  /** Stable React key: the name is editable, so it cannot identify the row. */
  readonly id: string;
  readonly name: string;
  readonly value: string;
  /** Saved headers cannot be renamed; renaming is delete + add. */
  readonly existing: boolean;
}

let nextRowId = 0;

export function newRowId(): string {
  nextRowId += 1;
  return `header-row-${String(nextRowId)}`;
}

export function headerRowsFromNames(names: readonly string[]): readonly HeaderRow[] {
  return names.map((name) => ({ id: newRowId(), name, value: '', existing: true }));
}

/** Turns the rows into the `headers` object of a write request: saved rows keep
 * their value when left blank, new rows must carry both a name and a value, and
 * rows the admin removed become `null` (delete).
 */
export function headerPayload(
  rows: readonly HeaderRow[],
  removedNames: readonly string[],
): { readonly headers: Readonly<Record<string, string | null>> | undefined; readonly error: string | null } {
  const headers: Record<string, string | null> = {};
  // Deletions first, so a row that re-adds a removed name keeps its new value.
  for (const name of removedNames) {
    headers[name] = null;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length === 0) {
      if (!row.existing) {
        return { headers: undefined, error: 'Every header needs a name' };
      }
      continue;
    }
    if (seen.has(name)) {
      return { headers: undefined, error: `Header ${name} is listed twice` };
    }
    seen.add(name);
    if (row.value.length === 0) {
      if (!row.existing) {
        return { headers: undefined, error: `Header ${name} needs a value` };
      }
      continue;
    }
    headers[name] = row.value;
  }
  return { headers: Object.keys(headers).length === 0 ? undefined : headers, error: null };
}

/** The same rows for a request that only sends values (discovery, new provider). */
export function headerValues(rows: readonly HeaderRow[]): {
  readonly values: Readonly<Record<string, string>> | undefined;
  readonly error: string | null;
} {
  const payload = headerPayload(rows, []);
  if (payload.error !== null || payload.headers === undefined) {
    return { values: undefined, error: payload.error };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload.headers)) {
    if (value !== null) {
      values[name] = value;
    }
  }
  return { values, error: null };
}

/**
 * Saved header names that are no longer in the edited rows. A name that a new
 * row adds back is a replacement, not a deletion.
 */
export function removedHeaderNames(original: readonly string[], rows: readonly HeaderRow[]): readonly string[] {
  const kept = new Set(rows.map((row) => (row.existing ? row.name : row.name.trim())));
  return original.filter((name) => !kept.has(name));
}

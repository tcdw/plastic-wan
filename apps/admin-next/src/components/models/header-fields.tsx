import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Header editing for a custom provider. Values are write-only — the API returns
 * names only — so a saved header keeps its value unless the admin types a new
 * one, and a row can never reveal what is stored.
 */
export interface HeaderRow {
  readonly name: string;
  readonly value: string;
  /** Saved headers cannot be renamed; renaming is delete + add. */
  readonly existing: boolean;
}

export function headerRowsFromNames(names: readonly string[]): readonly HeaderRow[] {
  return names.map((name) => ({ name, value: '', existing: true }));
}

export function HeaderFields({
  rows,
  onChange,
  valuesRequired,
  idPrefix,
}: {
  readonly rows: readonly HeaderRow[];
  readonly onChange: (rows: readonly HeaderRow[]) => void;
  /** `base_url` edits make every saved header value mandatory again. */
  readonly valuesRequired: boolean;
  readonly idPrefix: string;
}): React.ReactElement {
  const update = (index: number, patch: Partial<HeaderRow>): void => {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${row.name}-${String(index)}`} className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1">
            <label className="text-muted-foreground text-xs" htmlFor={`${idPrefix}-header-name-${String(index)}`}>
              Header
            </label>
            <Input
              id={`${idPrefix}-header-name-${String(index)}`}
              value={row.name}
              disabled={row.existing}
              placeholder="x-api-key"
              onChange={(event) => update(index, { name: event.target.value })}
            />
          </div>
          <div className="min-w-48 flex-1 space-y-1">
            <label className="text-muted-foreground text-xs" htmlFor={`${idPrefix}-header-value-${String(index)}`}>
              Value
            </label>
            <Input
              id={`${idPrefix}-header-value-${String(index)}`}
              type="password"
              autoComplete="new-password"
              value={row.value}
              placeholder={row.existing ? '已设置，留空以保持当前设置' : ''}
              onChange={(event) => update(index, { value: event.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={row.existing ? `Delete header ${row.name}` : 'Remove header row'}
            onClick={() => onChange(rows.filter((_, position) => position !== index))}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {valuesRequired && rows.some((row) => row.existing && row.value.length === 0) ? (
        <p className="text-warning text-xs">修改 base_url 需要重新填写全部 Header 值</p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { name: '', value: '', existing: false }])}
      >
        <Plus className="size-4" />
        Add header
      </Button>
    </div>
  );
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
  for (const name of removedNames) {
    headers[name] = null;
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

/** Saved header names that are no longer in the edited rows. */
export function removedHeaderNames(original: readonly string[], rows: readonly HeaderRow[]): readonly string[] {
  const kept = new Set(rows.filter((row) => row.existing).map((row) => row.name));
  return original.filter((name) => !kept.has(name));
}

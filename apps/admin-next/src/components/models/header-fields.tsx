import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type HeaderRow, newRowId } from '@/lib/header-rows.ts';

/**
 * Header editing for a custom provider. Values are write-only — the API returns
 * names only — so a saved header keeps its value unless the admin types a new
 * one, and a row can never reveal what is stored.
 */
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
        <div key={row.id} className="flex flex-wrap items-end gap-2">
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
              placeholder={row.existing ? 'Set - leave empty to keep' : ''}
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
        <p className="text-warning text-xs">Changing base_url requires every header value again</p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { id: newRowId(), name: '', value: '', existing: false }])}
      >
        <Plus className="size-4" />
        Add header
      </Button>
    </div>
  );
}

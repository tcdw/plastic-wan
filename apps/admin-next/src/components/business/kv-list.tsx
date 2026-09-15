import type React from 'react';
import { cn } from '@/lib/utils';

/**
 * Key/value detail list for detail-page diagnostic fields. Null or empty
 * values should use `TextValue` so they render as a placeholder instead of
 * disappearing.
 */

export interface KvItem {
  readonly label: string;
  readonly value: React.ReactNode;
}

export function KvList({
  items,
  className,
}: {
  readonly items: readonly KvItem[];
  readonly className?: string;
}): React.ReactElement {
  return (
    <dl className={cn('grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className="mt-0.5 text-sm break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Nullable text with a muted placeholder; never renders empty. */
export function TextValue({
  value,
  className,
}: {
  readonly value: string | null;
  readonly className?: string;
}): React.ReactElement {
  if (value === null || value.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span className={cn('break-words', className)}>{value}</span>;
}

/** Nullable monospace ID text (bigint-string fields stay strings). */
export function MonoValue({
  value,
  className,
}: {
  readonly value: string | null;
  readonly className?: string;
}): React.ReactElement {
  if (value === null || value.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-xs break-all', className)}>{value}</code>;
}

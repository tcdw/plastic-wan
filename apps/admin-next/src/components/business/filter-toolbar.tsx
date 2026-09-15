import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import type React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Filter toolbar building blocks. Semantics match the previous panel per field
 * type: text filters are explicit (type → press Search / Enter, or the X to
 * clear the *applied* filter), select filters apply immediately on change.
 * Layout wraps automatically on narrow screens.
 */

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function FilterToolbar({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export interface TextFilterProps {
  /** The currently applied filter (undefined = not filtered). */
  readonly value: string | undefined;
  readonly placeholder: string;
  /** Called with the trimmed draft when the user submits (Enter or search button). */
  readonly onCommit: (value: string) => void;
  /** Called when the user clears the filter; resets pagination via the page's filters state. */
  readonly onClear: () => void;
  readonly className?: string;
  readonly widthClassName?: string;
}

export function TextFilter({
  value,
  placeholder,
  onCommit,
  onClear,
  className,
  widthClassName = 'w-56',
}: TextFilterProps): React.ReactElement {
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  const commit = (): void => {
    onCommit(draft.trim());
  };
  const clear = (): void => {
    setDraft('');
    onClear();
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Input
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn('h-8', widthClassName)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
        }}
      />
      <Button type="button" size="icon-sm" variant="outline" onClick={commit} aria-label="Apply filter">
        <Search />
      </Button>
      {draft.length > 0 ? (
        <Button type="button" size="icon-sm" variant="ghost" onClick={clear} aria-label="Clear filter">
          <X />
        </Button>
      ) : null}
    </div>
  );
}

const ALL_OPTION_VALUE = '__all__';

export interface SelectFilterProps<T extends string> {
  readonly value: T | undefined;
  readonly placeholder: string;
  /** Called immediately when the selection changes; undefined clears the filter. */
  readonly onChange: (value: T | undefined) => void;
  readonly options: readonly FilterOption[];
  readonly className?: string;
}

export function SelectFilter<T extends string>({
  value,
  placeholder,
  onChange,
  options,
  className,
}: SelectFilterProps<T>): React.ReactElement {
  return (
    <Select
      value={value ?? ALL_OPTION_VALUE}
      onValueChange={(next) => onChange(next === ALL_OPTION_VALUE ? undefined : (next as T))}
    >
      <SelectTrigger className={cn('h-8 w-44', className)} aria-label={placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_OPTION_VALUE}>All</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Table shell on top of the shadcn table primitives: horizontal scroll is
 * built into the `Table` wrapper, rows can expand inline (chevron column) and
 * an empty state renders inside the table body. No pagination, no sorting —
 * the API contract is keyset cursors only.
 */

/** Standalone list-page table: a card surface whose cell insets match the card edge. */
export const LIST_TABLE_CLASS =
  'bg-card rounded-xl shadow-xs [&_td:first-child]:ps-4 [&_td:last-child]:pe-4 [&_th]:text-muted-foreground [&_th:first-child]:ps-4 [&_th:last-child]:pe-4';

export interface ColumnSpec<T> {
  readonly key: string;
  readonly title: string;
  readonly align?: 'left' | 'right';
  readonly width?: number | string;
  readonly className?: string;
  readonly render: (row: T) => React.ReactNode;
}

export interface TableShellProps<T> {
  readonly columns: readonly ColumnSpec<T>[];
  readonly data: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly expandedRender?: (row: T) => React.ReactNode;
  readonly isExpandable?: (row: T) => boolean;
  readonly emptyText?: React.ReactNode;
  readonly className?: string;
}

export function TableShell<T>({
  columns,
  data,
  rowKey,
  expandedRender,
  isExpandable,
  emptyText = 'No records',
  className,
}: TableShellProps<T>): React.ReactElement {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());

  const toggleRow = (key: string): void => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const hasExpand = expandedRender !== undefined;
  const columnCount = columns.length + (hasExpand ? 1 : 0);

  return (
    <div className={cn('rounded-lg border', className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {hasExpand ? <TableHead className="w-9" aria-label="Row details" /> : null}
            {columns.map((column) => (
              <TableHead
                key={column.key}
                {...(column.width !== undefined ? { style: { width: column.width } } : {})}
                className={cn(column.align === 'right' && 'text-right', column.className)}
              >
                {column.title}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="text-muted-foreground h-16 text-center">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            data.map((row) => {
              const key = rowKey(row);
              const expandable = hasExpand && (isExpandable?.(row) ?? true);
              const open = expandable && expandedKeys.has(key);
              return (
                <Fragment key={key}>
                  <TableRow data-state={open ? 'selected' : undefined}>
                    {hasExpand ? (
                      <TableCell className="w-9">
                        {expandable ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-expanded={open}
                            aria-label="Toggle row details"
                            onClick={() => toggleRow(key)}
                          >
                            {open ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(column.align === 'right' ? 'text-right' : '', column.className)}
                      >
                        {column.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {open ? (
                    <TableRow>
                      <TableCell colSpan={columnCount} className="bg-muted/30 p-4 align-top">
                        {expandedRender?.(row)}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

import {
  useInfiniteQuery,
  type InfiniteData,
  type QueryKey,
  type UndefinedInitialDataInfiniteOptions,
} from '@tanstack/react-query';
import type React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type ListFilters, type Page } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Cursor list container shared by every list page. It owns the infinite query
 * lifecycle (page size is fixed by `lib/queries.ts`'s PAGE_SIZE = 25, cursors
 * come from the API), and renders loading skeleton / error / empty / Load more
 * states. Pages only supply the query factory, the filter values and a
 * renderer for the loaded items.
 *
 * Contract rules:
 * - Never expose jump-to-page, total-page counts, or client-side sorting over
 *   the full dataset: the API is keyset-cursor only.
 * - Changing `filters` changes the query key, which resets accumulated pages.
 * - "Load more" appears only while `next_cursor` is non-null.
 */
export type CursorQueryOptions<T, TQueryKey extends QueryKey = QueryKey> = UndefinedInitialDataInfiniteOptions<
  Page<T>,
  Error,
  InfiniteData<Page<T>>,
  TQueryKey,
  string | null
>;

export type CursorQueryFactory<T> = (filters: ListFilters) => CursorQueryOptions<T>;

export function flatPages<T>(
  data: { readonly pages: ReadonlyArray<{ readonly items: readonly T[] }> } | undefined,
): T[] {
  return data === undefined ? [] : data.pages.flatMap((page) => [...page.items]);
}

export interface CursorListProps<T, TQueryKey extends QueryKey = QueryKey> {
  readonly factory: (filters: ListFilters) => CursorQueryOptions<T, TQueryKey>;
  readonly filters: ListFilters;
  readonly renderItems: (items: readonly T[]) => React.ReactNode;
  readonly empty?: React.ReactNode;
  readonly errorTitle?: string;
  readonly skeletonRows?: number;
  readonly loadMoreLabel?: string;
  readonly className?: string;
}

function CursorListSkeleton({ rows }: { readonly rows: number }): React.ReactElement {
  const keys = Array.from({ length: rows }, (_, index) => `row-${index}`);
  return (
    <div className="space-y-2">
      {keys.map((key) => (
        <Skeleton key={key} className="h-9 w-full rounded-md" />
      ))}
    </div>
  );
}

function CursorListError({ error, title }: { readonly error: unknown; readonly title: string }): React.ReactElement {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Admin request failed';
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function CursorList<T, TQueryKey extends QueryKey = QueryKey>({
  factory,
  filters,
  renderItems,
  empty,
  errorTitle = 'Request failed',
  skeletonRows = 6,
  loadMoreLabel = 'Load more',
  className,
}: CursorListProps<T, TQueryKey>): React.ReactNode {
  const query = useInfiniteQuery(factory(filters));
  const items = flatPages(query.data);

  if (query.isPending) {
    return <CursorListSkeleton rows={skeletonRows} />;
  }
  if (query.isError) {
    return <CursorListError error={query.error} title={errorTitle} />;
  }
  if (items.length === 0) {
    return (
      empty ?? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No records</EmptyTitle>
            <EmptyDescription>No records match the current filters.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    );
  }
  return (
    <div className={cn('space-y-3', className)}>
      {renderItems(items)}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading more…' : loadMoreLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

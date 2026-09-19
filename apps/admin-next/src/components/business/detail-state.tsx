import { Link } from '@tanstack/react-router';
import type React from 'react';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shared detail-page state contract. The three detail pages
 * (invocation-detail, context-detail, message-detail) share the loading
 * skeleton and error state from here; the third state (data) stays with each
 * page, which renders its own fields once the query resolves.
 *
 * The state machine each detail page keeps using is unchanged:
 *
 *   isPending  -> <DetailSkeleton />
 *   isError    -> <DetailError error={error} ... />
 *   data is undefined -> <DetailError error={new Error('... data is missing')} ... />
 *   else       -> page content
 */

export function DetailSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}

export interface DetailErrorProps {
  readonly error: unknown;
  readonly notFoundTitle: string;
  readonly failedTitle: string;
  readonly backTo: string;
  readonly backLabel: string;
}

export function DetailError({
  error,
  notFoundTitle,
  failedTitle,
  backTo,
  backLabel,
}: DetailErrorProps): React.ReactElement {
  const apiError = error instanceof ApiError ? error : null;
  const notFound = apiError?.status === 404;
  return (
    <div className="space-y-2 p-6 text-center">
      <p className="text-destructive font-medium">{notFound ? notFoundTitle : failedTitle}</p>
      <p className="text-muted-foreground text-sm break-words">{errorMessage(error)}</p>
      <Link to={backTo} className="text-primary inline-block text-sm underline-offset-4 hover:underline">
        {backLabel}
      </Link>
    </div>
  );
}

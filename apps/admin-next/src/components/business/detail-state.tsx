import { Link } from '@tanstack/react-router';
import type React from 'react';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shared detail-page state contract (M5a). The three detail pages
 * (invocation-detail, context-detail, message-detail) previously each carried
 * their own ~30-line copy of the loading skeleton and error state; this module
 * is the single place for those two states. The third state (data) stays with
 * each page, which renders its own fields once the query resolves.
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
  /** Title shown when the API answered 404 (the record does not exist). */
  readonly notFoundTitle: string;
  /** Title shown for every other failure (network, 5xx, missing data…). */
  readonly failedTitle: string;
  /** List route the back link points to (e.g. "/invocations"). */
  readonly backTo: string;
  /** Back link label (e.g. "Back to tool sessions"). */
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

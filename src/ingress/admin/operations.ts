import { sql } from 'drizzle-orm';
import { type Orm, asRunResult } from '../../store/database.ts';

export interface CancelPendingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
}

export function cancelPendingSessions(orm: Orm, now = new Date()): CancelPendingResult {
  const timestamp = now.toISOString();
  let bucketResult: { changes: number } | undefined;
  let invocationResult: { changes: number } | undefined;

  orm.transaction(
    () => {
      bucketResult = asRunResult(
        orm.run(sql`UPDATE buckets
       SET state = 'expired', error_code = 'admin_cancel', finished_at = ${timestamp}, updated_at = ${timestamp}
       WHERE state IN ('collecting', 'queued')`),
      );

      invocationResult = asRunResult(
        orm.run(sql`UPDATE invocations
       SET state = 'aborted', completion_reason = 'admin_cancel', finished_at = ${timestamp}
       WHERE state = 'queued'`),
      );
    },
    { behavior: 'immediate' },
  );

  return {
    canceled_buckets: bucketResult?.changes ?? 0,
    canceled_invocations: invocationResult?.changes ?? 0,
  };
}

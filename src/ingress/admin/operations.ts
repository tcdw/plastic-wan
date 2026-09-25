import { sql } from 'drizzle-orm';
import { type Orm, asRunResult } from '../../store/database.ts';

export interface CancelOngoingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
}

// Closes the database side of every in-flight session. Running invocations are
// interrupted separately through the scheduler; this only makes sure nothing is
// left behind to start again once they stop.
export function cancelOngoingSessions(orm: Orm, now = new Date()): CancelOngoingResult {
  const timestamp = now.toISOString();
  let bucketResult: { changes: number } | undefined;
  let invocationResult: { changes: number } | undefined;

  orm.transaction(
    () => {
      // A batch attached to a running invocation but not yet injected would be
      // re-queued as a fresh invocation when the aborted run releases it.
      bucketResult = asRunResult(
        orm.run(sql`UPDATE buckets
       SET state = 'expired', error_code = 'admin_cancel', finished_at = ${timestamp}, updated_at = ${timestamp}
       WHERE state IN ('collecting', 'queued')
          OR (state = 'running' AND id IN (
            SELECT ib.bucket_id FROM invocation_buckets ib
            JOIN invocations i ON i.id = ib.invocation_id
            WHERE i.state = 'running' AND ib.injected_at IS NULL AND ib.bucket_id <> i.bucket_id
          ))`),
      );

      // A claimed alarm whose queued invocation is being aborted must close
      // instead of staying `firing` until a later restart.
      orm.run(sql`UPDATE alarms
       SET state = 'cancelled', cancelled_at = ${timestamp}, cancel_reason = 'admin_cancel', admin_cancelled = 1, updated_at = ${timestamp}
       WHERE state = 'firing' AND invocation_id IN (SELECT id FROM invocations WHERE state = 'queued')`);

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

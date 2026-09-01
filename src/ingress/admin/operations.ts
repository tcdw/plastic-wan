import { sql } from 'drizzle-orm';
import { type Orm, asRunResult } from '../../store/database.ts';

export interface CancelPendingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
  readonly refunded_invocations: number;
}

interface RefundRow {
  readonly telegram_chat_id: bigint;
  readonly utc_date: string;
  readonly count: bigint;
}

export function cancelPendingSessions(orm: Orm, now = new Date()): CancelPendingResult {
  const timestamp = now.toISOString();
  let bucketResult: { changes: number } | undefined;
  let invocationResult: { changes: number } | undefined;
  let refundRows: readonly RefundRow[] = [];

  orm.transaction(
    () => {
      refundRows =
        orm.all<RefundRow>(sql`SELECT c.telegram_chat_id, substr(i.created_at, 1, 10) AS utc_date, COUNT(*) AS count
       FROM invocations i
       JOIN conversations v ON v.id = i.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE i.state = 'queued'
       GROUP BY c.telegram_chat_id, utc_date`);

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

      for (const refund of refundRows) {
        orm.run(sql`UPDATE daily_usage
         SET amount = MAX(0, amount - ${refund.count}), updated_at = ${timestamp}
         WHERE utc_date = ${refund.utc_date} AND scope = 'chat' AND resource = ${refund.telegram_chat_id.toString()} AND metric = 'agent_invocations'`);
      }
    },
    { behavior: 'immediate' },
  );

  return {
    canceled_buckets: bucketResult?.changes ?? 0,
    canceled_invocations: invocationResult?.changes ?? 0,
    refunded_invocations: Number(refundRows.reduce((sum, row) => sum + row.count, 0n)),
  };
}

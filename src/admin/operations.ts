import type { Database } from 'bun:sqlite';

export interface CancelPendingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
  readonly refunded_invocations: number;
}

export function cancelPendingSessions(database: Database, now = new Date()): CancelPendingResult {
  const timestamp = now.toISOString();
  let bucketResult: { changes: number } | undefined;
  let invocationResult: { changes: number } | undefined;
  let refundRows: readonly { readonly telegram_chat_id: bigint; readonly utc_date: string; readonly count: bigint }[] =
    [];

  database
    .transaction(() => {
      refundRows = database
        .query<{ telegram_chat_id: bigint; utc_date: string; count: bigint }, []>(
          `SELECT c.telegram_chat_id, substr(i.created_at, 1, 10) AS utc_date, COUNT(*) AS count
       FROM invocations i
       JOIN conversations v ON v.id = i.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE i.state = 'queued'
       GROUP BY c.telegram_chat_id, utc_date`,
        )
        .all();

      bucketResult = database
        .query(
          `UPDATE buckets
       SET state = 'expired', error_code = 'admin_cancel', finished_at = ?, updated_at = ?
       WHERE state IN ('collecting', 'queued')`,
        )
        .run(timestamp, timestamp);

      invocationResult = database
        .query(
          `UPDATE invocations
       SET state = 'aborted', completion_reason = 'admin_cancel', finished_at = ?
       WHERE state = 'queued'`,
        )
        .run(timestamp);

      for (const refund of refundRows) {
        database
          .query(
            `UPDATE daily_usage
         SET amount = MAX(0, amount - ?), updated_at = ?
         WHERE utc_date = ? AND scope = 'chat' AND resource = ? AND metric = 'agent_invocations'`,
          )
          .run(refund.count, timestamp, refund.utc_date, refund.telegram_chat_id.toString());
      }
    })
    .immediate();

  return {
    canceled_buckets: bucketResult?.changes ?? 0,
    canceled_invocations: invocationResult?.changes ?? 0,
    refunded_invocations: Number(refundRows.reduce((sum, row) => sum + row.count, 0n)),
  };
}

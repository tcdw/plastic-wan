import { eq, sql } from 'drizzle-orm';
import type { SqliteStore } from './database.ts';
import { invocationMessages, media } from './schema.ts';

export interface MessageSnapshotRow {
  readonly message_id: bigint;
  readonly conversation_id: bigint;
  readonly message_thread_id: bigint;
  readonly revision_id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly sent_by_bot: bigint;
  readonly revision_no: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly sender_telegram_id: bigint | null;
  readonly sender_display_name: string | null;
  readonly sender_username: string | null;
  readonly source_bucket_id: bigint | null;
}

/**
 * Freezes one invocation's model input: history (bounded by the per-chat
 * context cutoff) plus the bucket's current messages, each rendered as a
 * versioned JSON snapshot so later edits never mutate a running invocation.
 */
export function snapshotInvocation(
  store: SqliteStore,
  historyMessages: number,
  invocationId: bigint,
  bucketId: bigint,
  conversationId: bigint,
  includeHistory: boolean,
): void {
  // History stops at the per-chat context cutoff (`/cut_topic`), if one
  // exists: messages at or below the cutoff Telegram message ID never enter
  // a new invocation snapshot. Live bucket messages are unaffected.
  const history = includeHistory
    ? store.orm
        .all<MessageSnapshotRow>(
          sql`SELECT m.id AS message_id, m.conversation_id, v.message_thread_id,
                r.id AS revision_id, m.telegram_message_id, m.telegram_date, m.sent_by_bot,
                r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
                r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
                s.display_name AS sender_display_name, s.username AS sender_username, NULL AS source_bucket_id
         FROM messages m
         JOIN conversations v ON v.id = m.conversation_id
         JOIN message_revisions r ON r.id = m.current_revision_id
         LEFT JOIN senders s ON s.id = r.sender_id
         WHERE m.conversation_id = ${conversationId} AND m.visible = 1
           AND (v.chat_id NOT IN (SELECT chat_id FROM chat_context_cutoffs)
                OR m.telegram_message_id > (SELECT telegram_message_id FROM chat_context_cutoffs WHERE chat_id = v.chat_id))
           AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.bucket_id = ${bucketId} AND bm.message_id = m.id)
         ORDER BY m.telegram_date DESC, m.telegram_message_id DESC
         LIMIT ${BigInt(historyMessages)}`,
        )
        .reverse()
    : [];
  const current = store.orm.all<MessageSnapshotRow>(
    sql`SELECT m.id AS message_id, m.conversation_id, v.message_thread_id,
            r.id AS revision_id, m.telegram_message_id, m.telegram_date, m.sent_by_bot,
            r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
            r.forward_origin_json, r.media_group_id, s.telegram_id AS sender_telegram_id,
            s.display_name AS sender_display_name, s.username AS sender_username, bm.source_bucket_id
       FROM bucket_messages bm
       JOIN messages m ON m.id = bm.message_id
       JOIN conversations v ON v.id = m.conversation_id
       JOIN message_revisions r ON r.id = m.current_revision_id
       LEFT JOIN senders s ON s.id = r.sender_id
       WHERE bm.bucket_id = ${bucketId} ORDER BY bm.sequence_no`,
  );
  let sequence = 1n;
  for (const message of history) {
    insertSnapshot(store, invocationId, message, 'history', sequence);
    sequence += 1n;
  }
  for (const message of current) {
    insertSnapshot(store, invocationId, message, 'new', sequence);
    sequence += 1n;
  }
}

function insertSnapshot(
  store: SqliteStore,
  invocationId: bigint,
  message: MessageSnapshotRow,
  section: 'history' | 'new',
  sequence: bigint,
): void {
  const mediaRows = store.orm
    .select({
      id: media.id,
      kind: media.kind,
      fileUniqueId: media.fileUniqueId,
      mimeType: media.mimeType,
      width: media.width,
      height: media.height,
    })
    .from(media)
    .where(eq(media.revisionId, message.revision_id))
    .orderBy(media.id)
    .all()
    .map((entry) => ({
      id: entry.id.toString(),
      kind: entry.kind,
      file_unique_id: entry.fileUniqueId,
      mime_type: entry.mimeType,
      width: entry.width?.toString() ?? null,
      height: entry.height?.toString() ?? null,
    }));
  const snapshot = JSON.stringify({
    message_id: message.telegram_message_id.toString(),
    message_thread_id: message.message_thread_id.toString(),
    telegram_date: message.telegram_date,
    sent_by_bot: message.sent_by_bot === 1n,
    revision: message.revision_no.toString(),
    sender: {
      id: message.sender_telegram_id?.toString() ?? null,
      name: message.sender_display_name,
      username: message.sender_username,
    },
    kind: message.kind,
    text: message.text,
    caption: message.caption,
    reply_to_message_id: message.reply_to_message_id?.toString() ?? null,
    reply_snapshot: message.reply_snapshot_json === null ? null : JSON.parse(message.reply_snapshot_json),
    forward_origin: message.forward_origin_json === null ? null : JSON.parse(message.forward_origin_json),
    media_group_id: message.media_group_id,
    media: mediaRows,
  });
  store.orm
    .insert(invocationMessages)
    .values({
      invocationId,
      messageId: message.message_id,
      revisionId: message.revision_id,
      section,
      sequenceNo: sequence,
      sourceBucketId: message.source_bucket_id,
      snapshotJson: snapshot,
    })
    .run();
}

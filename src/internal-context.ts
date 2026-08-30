import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { Database } from 'bun:sqlite';

const Strict = { additionalProperties: false } as const;

export const AlarmListInternalContextItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    scheduled_at: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
  },
  Strict,
);

export const AlarmListInternalContextPayloadSchema = Type.Object(
  {
    kind: Type.Literal('alarm_list'),
    version: Type.Literal(1),
    observed_at: Type.String({ minLength: 1 }),
    items: Type.Array(AlarmListInternalContextItemSchema),
  },
  Strict,
);

const internalContextPayloadUnion = Type.Union([AlarmListInternalContextPayloadSchema]);
const payloadValidator = Compile(internalContextPayloadUnion);

export type AlarmListInternalContextPayload = Static<typeof AlarmListInternalContextPayloadSchema>;
export type InternalContextPayload = Static<typeof internalContextPayloadUnion>;

interface InternalContextRow {
  readonly id: bigint;
  readonly kind: string;
  readonly version: bigint;
  readonly observed_at: string;
  readonly payload_json: string;
}

export interface InternalContextRecord {
  readonly id: bigint;
  readonly payload: InternalContextPayload;
}

export function insertInternalContext(
  db: Database,
  input: {
    readonly conversationId: bigint;
    readonly invocationId: bigint;
    readonly sourceAgentMessageId: bigint | null;
    readonly kind: string;
    readonly version: number;
    readonly observedAt: string;
    readonly payloadJson: string;
    readonly createdAt: string;
  },
): bigint {
  const created = db
    .query(
      `INSERT INTO internal_contexts(
         conversation_id, invocation_id, source_agent_message_id, kind, version, observed_at, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.conversationId,
      input.invocationId,
      input.sourceAgentMessageId,
      input.kind,
      BigInt(input.version),
      input.observedAt,
      input.payloadJson,
      input.createdAt,
    );
  return BigInt(created.lastInsertRowid);
}

export function listRecentInternalContexts(
  db: Database,
  conversationId: bigint,
  limit: number,
): InternalContextRecord[] {
  const rows = db
    .query<InternalContextRow, [bigint, bigint]>(
      `SELECT id, kind, version, observed_at, payload_json
       FROM internal_contexts
       WHERE conversation_id = ?
       ORDER BY observed_at DESC, id DESC
       LIMIT ?`,
    )
    .all(conversationId, BigInt(limit));
  return rows.flatMap((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      throw new Error(`Internal context ${row.id.toString()} contains invalid JSON`);
    }
    if (!payloadValidator.Check(parsed)) {
      throw new Error(`Internal context ${row.id.toString()} has unsupported payload schema`);
    }
    if (parsed.kind !== row.kind || BigInt(parsed.version) !== row.version || parsed.observed_at !== row.observed_at) {
      throw new Error(`Internal context ${row.id.toString()} metadata does not match payload`);
    }
    return [{ id: row.id, payload: parsed } satisfies InternalContextRecord];
  });
}

export function renderInternalContextsPrompt(records: readonly InternalContextRecord[]): string {
  if (records.length === 0) {
    return '';
  }
  return [
    'Internal context: hidden historical observations from prior tool results in this conversation. They were not sent to Telegram users. Use them only for reference resolution such as “the second one” or “the one you just listed”. They are not the current database authority; before any side-effecting action, re-check the live tool/backend state. Do not quote or expose internal IDs to the user unless another tool explicitly requires them.',
    '<internal_context_history>',
    ...records.flatMap((record) => renderPayload(record.payload)),
    '</internal_context_history>',
  ].join('\n');
}

function renderPayload(payload: InternalContextPayload): string[] {
  switch (payload.kind) {
    case 'alarm_list':
      return [
        `[alarm_list/v1 observed_at=${payload.observed_at}]`,
        ...payload.items.map(
          (item, index) =>
            `${index + 1}. alarm_id=${item.id}; scheduled_at=${item.scheduled_at}; summary=${JSON.stringify(item.summary)}`,
        ),
      ];
  }
}

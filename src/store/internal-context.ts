import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { desc, eq } from 'drizzle-orm';
import type { Orm } from './database.ts';
import { internalContexts } from './schema.ts';

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

export interface InternalContextRecord {
  readonly id: bigint;
  readonly payload: InternalContextPayload;
}

export function insertInternalContext(
  orm: Orm,
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
  const created = orm
    .insert(internalContexts)
    .values({
      conversationId: input.conversationId,
      invocationId: input.invocationId,
      sourceAgentMessageId: input.sourceAgentMessageId,
      kind: input.kind,
      version: BigInt(input.version),
      observedAt: input.observedAt,
      payloadJson: input.payloadJson,
      createdAt: input.createdAt,
    })
    .returning({ id: internalContexts.id })
    .get();
  if (created === undefined) {
    throw new Error('internal_contexts insert returned no row');
  }
  return created.id;
}

export function listRecentInternalContexts(orm: Orm, conversationId: bigint, limit: number): InternalContextRecord[] {
  const rows = orm
    .select({
      id: internalContexts.id,
      kind: internalContexts.kind,
      version: internalContexts.version,
      observedAt: internalContexts.observedAt,
      payloadJson: internalContexts.payloadJson,
    })
    .from(internalContexts)
    .where(eq(internalContexts.conversationId, conversationId))
    .orderBy(desc(internalContexts.observedAt), desc(internalContexts.id))
    .limit(limit)
    .all();
  return rows.flatMap((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payloadJson);
    } catch {
      throw new Error(`Internal context ${row.id.toString()} contains invalid JSON`);
    }
    if (!payloadValidator.Check(parsed)) {
      throw new Error(`Internal context ${row.id.toString()} has unsupported payload schema`);
    }
    if (parsed.kind !== row.kind || BigInt(parsed.version) !== row.version || parsed.observed_at !== row.observedAt) {
      throw new Error(`Internal context ${row.id.toString()} metadata does not match payload`);
    }
    return [{ id: row.id, payload: parsed } satisfies InternalContextRecord];
  });
}

/**
 * Renders the hidden-observation block for one injection. The guidance that
 * explains how to use it lives in the stable system prompt; only the changing
 * part travels with the injected batch.
 */
export function renderInternalContextsPrompt(records: readonly InternalContextRecord[]): string {
  if (records.length === 0) {
    return '';
  }
  return [
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

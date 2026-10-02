import { and, asc, eq, or, sql } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type {
  CompletionContext,
  DeliveryPolicy,
  InvocationContext,
  JsonValue,
} from '../platform/invocation-context.ts';
import type { Orm } from './database.ts';
import { longTasks, taskReceipts } from './schema.ts';

const JsonValueSchema = Type.Union(
  [
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref('JsonValue')),
    Type.Record(Type.String(), Type.Ref('JsonValue')),
  ],
  { $id: 'JsonValue' },
);
const jsonValidator = Compile(JsonValueSchema);
const DeliverySchema = Type.Object(
  {
    bypassDailyBudget: Type.Boolean(),
    mentionUser: Type.Optional(
      Type.Object(
        {
          userId: Type.String({ pattern: '^[1-9][0-9]*$' }),
          displayName: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const deliveryValidator = Compile(DeliverySchema);
const MAX_JSON = 16_384;
const MAX_ERROR = 8_192;
const MAX_DELIVERY = 4_096;
const MAX_INT64 = 9_223_372_036_854_775_807n;

type StoredDelivery = Static<typeof DeliverySchema>;

export class TaskQuotaError extends Error {
  constructor() {
    super('Task quota exceeded for this invocation');
    this.name = 'TaskQuotaError';
  }
}

export interface ListedTask {
  readonly id: bigint;
  readonly payload: JsonValue;
  readonly state: 'waiting' | 'completed' | 'failed' | 'cancelled';
  readonly scheduledAt: string | null;
  readonly createdAt: string;
}

export interface CreateTaskInput {
  readonly payload: unknown;
  readonly delivery?: DeliveryPolicy;
  readonly scheduledAt?: string;
  readonly timerResult?: unknown;
  readonly maxPerInvocation?: number;
}

export interface CancelOptions {
  readonly cancelledBy?: string;
  readonly adminCancelled?: boolean;
  readonly reason?: string;
}

export interface CompletionOptions {
  readonly notify?: boolean;
}

export interface PluginTaskScope {
  create(input: CreateTaskInput, now?: Date): { readonly taskId: bigint; readonly scheduledAt: string | null };
  get(taskId: bigint): ListedTask | undefined;
  list(): readonly ListedTask[];
  complete(taskId: bigint, result?: unknown, options?: CompletionOptions, now?: Date): boolean;
  fail(taskId: bigint, error?: unknown, options?: CompletionOptions, now?: Date): boolean;
  cancel(taskId: bigint, options?: CancelOptions, now?: Date): boolean;
}

function jsonText(value: unknown, limit: number, field: string): string {
  validateJsonStructure(value, new Set<object>());
  if (!jsonValidator.Check(value)) {
    throw new Error(`${field} must be a JSON value`);
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new Error(`${field} exceeds ${limit} bytes`);
  }
  return text;
}

function validateJsonStructure(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('JSON number must be finite');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error('value is not JSON serializable');
  }
  if (ancestors.has(value)) {
    throw new Error('JSON value must not contain cycles');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      validateJsonArray(value, ancestors);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('JSON value must be a plain object');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new Error('JSON object must not contain symbol keys');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('JSON object must contain only enumerable data properties');
      }
      validateJsonStructure(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateJsonArray(value: readonly unknown[], ancestors: Set<object>): void {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === 'symbol') {
      throw new Error('JSON array must not contain symbol keys');
    }
    if (key === 'length') {
      continue;
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
      throw new Error('JSON array must not contain non-index properties');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('JSON array must contain only enumerable data properties');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error('JSON array must not be sparse or contain accessors');
    }
    validateJsonStructure(descriptor.value, ancestors);
  }
}

function parseJson(text: string, field: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${field} in database`);
  }
  if (!jsonValidator.Check(value)) {
    throw new Error(`Invalid ${field} in database`);
  }
  return toJsonValue(value);
}

function toJsonValue(value: Static<typeof JsonValueSchema>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => toJsonValue(child as Static<typeof JsonValueSchema>));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toJsonValue(child as Static<typeof JsonValueSchema>)]),
  );
}

function canonicalIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error('scheduledAt must be canonical UTC ISO-8601');
  }
  return value;
}

function deliveryText(policy: DeliveryPolicy | undefined): string {
  const value: Record<string, unknown> = { bypassDailyBudget: policy?.bypassDailyBudget ?? false };
  if (policy?.mentionUser !== undefined) {
    value.mentionUser = {
      userId: positiveInt64(policy.mentionUser.userId).toString(),
      displayName: policy.mentionUser.displayName,
    };
  }
  if (!deliveryValidator.Check(value)) {
    throw new Error('delivery policy is invalid');
  }
  return jsonText(value, MAX_DELIVERY, 'delivery');
}

function readDelivery(text: string): DeliveryPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid delivery in database');
  }
  if (!deliveryValidator.Check(value)) {
    throw new Error('Invalid delivery in database');
  }
  return fromStoredDelivery(value);
}

function fromStoredDelivery(value: StoredDelivery): DeliveryPolicy {
  if (value.mentionUser === undefined) {
    return { bypassDailyBudget: value.bypassDailyBudget };
  }
  return {
    bypassDailyBudget: value.bypassDailyBudget,
    mentionUser: {
      userId: BigInt(value.mentionUser.userId),
      displayName: value.mentionUser.displayName,
    },
  };
}

function positiveInt64(id: bigint): bigint {
  if (id <= 0n || id > MAX_INT64) {
    throw new Error('ID must be a positive int64');
  }
  return id;
}

function listed(row: {
  id: bigint;
  payloadJson: string;
  state: string;
  scheduledAt: string | null;
  createdAt: string;
}): ListedTask {
  if (row.state !== 'waiting' && row.state !== 'completed' && row.state !== 'failed' && row.state !== 'cancelled') {
    throw new Error('Invalid task state in database');
  }
  return {
    id: row.id,
    payload: parseJson(row.payloadJson, 'task payload'),
    state: row.state,
    scheduledAt: row.scheduledAt,
    createdAt: row.createdAt,
  };
}

export class LongTaskService {
  readonly #orm: Orm;
  readonly #wake: (() => void) | undefined;

  constructor(orm: Orm, wake?: () => void) {
    this.#orm = orm;
    this.#wake = wake;
  }

  /**
   * Scope bound to a fixed invocation id, for creators acting outside a live
   * invocation (completion bridges): quota accounting still attributes the task
   * to the invocation that submitted the work.
   */
  taskScope(pluginId: string, conversationId: bigint, invocationId: bigint | null): PluginTaskScope {
    return this.#scope(
      pluginId,
      conversationId,
      () => invocationId,
      () => null,
      false,
    );
  }

  scoped(pluginId: string, conversationId: bigint): PluginTaskScope {
    return this.#scope(
      pluginId,
      conversationId,
      () => null,
      () => null,
      false,
    );
  }

  invocationScope(pluginId: string, liveContext: InvocationContext): PluginTaskScope {
    return this.#scope(
      pluginId,
      liveContext.conversationId,
      () => liveContext.invocationId,
      () => liveContext.callerUserId,
      true,
    );
  }

  #scope(
    pluginId: string,
    conversationId: bigint,
    invocation: () => bigint | null,
    caller: () => bigint | null,
    restricted: boolean,
  ): PluginTaskScope {
    return {
      create: (input, now) => this.#create(pluginId, conversationId, invocation(), caller(), input, now),
      get: (taskId) => this.#get(pluginId, conversationId, taskId, caller(), restricted),
      list: () => this.#list(pluginId, conversationId, caller(), restricted),
      complete: (taskId, result, options, now) =>
        this.#finish(pluginId, conversationId, taskId, 'completed', result, options, now),
      fail: (taskId, error, options, now) =>
        this.#finish(pluginId, conversationId, taskId, 'failed', error, options, now),
      cancel: (taskId, options, now) =>
        this.#cancel(pluginId, conversationId, taskId, caller(), restricted, options, now),
    };
  }

  #create(
    pluginId: string,
    conversationId: bigint,
    invocationId: bigint | null,
    callerId: bigint | null,
    input: CreateTaskInput,
    now = new Date(),
  ): { taskId: bigint; scheduledAt: string | null } {
    const payloadJson = jsonText(input.payload, MAX_JSON, 'payload');
    const scheduledAt = input.scheduledAt === undefined ? null : canonicalIso(input.scheduledAt);
    const timerResultJson =
      scheduledAt === null
        ? input.timerResult === undefined
          ? null
          : (() => {
              throw new Error('timerResult requires scheduledAt');
            })()
        : jsonText(input.timerResult === undefined ? input.payload : input.timerResult, MAX_JSON, 'timerResult');
    if (
      input.maxPerInvocation !== undefined &&
      (!Number.isSafeInteger(input.maxPerInvocation) || input.maxPerInvocation < 1)
    ) {
      throw new Error('maxPerInvocation must be a safe integer >= 1');
    }
    if (input.maxPerInvocation !== undefined && invocationId === null) {
      throw new Error('maxPerInvocation requires an invocation');
    }
    const deliveryJson = deliveryText(input.delivery);
    const at = now.toISOString();
    const created = this.#orm.transaction(
      () => {
        if (input.maxPerInvocation !== undefined && invocationId !== null) {
          const count =
            this.#orm
              .select({ count: sql<bigint>`count(*)` })
              .from(longTasks)
              .where(and(eq(longTasks.pluginId, pluginId), eq(longTasks.createdByInvocationId, invocationId)))
              .get()?.count ?? 0n;
          if (count >= BigInt(input.maxPerInvocation)) {
            throw new TaskQuotaError();
          }
        }
        const row = this.#orm
          .insert(longTasks)
          .values({
            pluginId,
            conversationId,
            createdByInvocationId: invocationId,
            createdByUserId: callerId,
            payloadJson,
            state: 'waiting',
            scheduledAt,
            timerResultJson,
            deliveryJson,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: longTasks.id, scheduledAt: longTasks.scheduledAt })
          .get();
        if (row === undefined) {
          throw new Error('Task creation returned no row');
        }
        return row;
      },
      { behavior: 'immediate' },
    );
    this.#wake?.();
    return { taskId: created.id, scheduledAt: created.scheduledAt };
  }

  #get(
    pluginId: string,
    conversationId: bigint,
    taskId: bigint,
    callerId: bigint | null,
    restricted: boolean,
  ): ListedTask | undefined {
    if (restricted && callerId === null) {
      return undefined;
    }
    const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
    const row = this.#orm
      .select({
        id: longTasks.id,
        payloadJson: longTasks.payloadJson,
        state: longTasks.state,
        scheduledAt: longTasks.scheduledAt,
        createdAt: longTasks.createdAt,
      })
      .from(longTasks)
      .where(
        and(
          eq(longTasks.id, taskId),
          eq(longTasks.pluginId, pluginId),
          eq(longTasks.conversationId, conversationId),
          owner,
        ),
      )
      .get();
    return row === undefined ? undefined : listed(row);
  }

  #list(pluginId: string, conversationId: bigint, callerId: bigint | null, restricted: boolean): ListedTask[] {
    if (restricted && callerId === null) {
      return [];
    }
    const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
    const visible = restricted ? or(eq(longTasks.state, 'waiting'), eq(taskReceipts.state, 'pending')) : undefined;
    return this.#orm
      .select({
        id: longTasks.id,
        payloadJson: longTasks.payloadJson,
        state: longTasks.state,
        scheduledAt: longTasks.scheduledAt,
        createdAt: longTasks.createdAt,
      })
      .from(longTasks)
      .leftJoin(taskReceipts, eq(taskReceipts.taskId, longTasks.id))
      .where(and(eq(longTasks.pluginId, pluginId), eq(longTasks.conversationId, conversationId), owner, visible))
      .orderBy(asc(longTasks.scheduledAt), asc(longTasks.id))
      .all()
      .map(listed);
  }

  #finish(
    pluginId: string,
    conversationId: bigint,
    taskId: bigint,
    status: 'completed' | 'failed',
    value: unknown | undefined,
    options: CompletionOptions | undefined,
    now = new Date(),
  ): boolean {
    const json =
      value === undefined
        ? null
        : jsonText(value, status === 'completed' ? MAX_JSON : MAX_ERROR, status === 'completed' ? 'result' : 'error');
    const at = now.toISOString();
    const changed = this.#orm.transaction(
      () => {
        const update = this.#orm
          .update(longTasks)
          .set({ state: status, finishedAt: at, updatedAt: at })
          .where(
            and(
              eq(longTasks.id, taskId),
              eq(longTasks.pluginId, pluginId),
              eq(longTasks.conversationId, conversationId),
              eq(longTasks.state, 'waiting'),
            ),
          )
          .run();
        if (update.changes === 0) {
          return false;
        }
        this.#orm
          .insert(taskReceipts)
          .values({
            taskId,
            status,
            resultJson: status === 'completed' ? json : null,
            errorJson: status === 'failed' ? json : null,
            state: options?.notify === false ? 'suppressed' : 'pending',
            createdAt: at,
            updatedAt: at,
          })
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
    if (changed) {
      this.#wake?.();
    }
    return changed;
  }

  #cancel(
    pluginId: string,
    conversationId: bigint,
    taskId: bigint,
    callerId: bigint | null,
    restricted: boolean,
    options: CancelOptions | undefined,
    now = new Date(),
  ): boolean {
    if (restricted && callerId === null) {
      return false;
    }
    const at = now.toISOString();
    const changed = this.#orm.transaction(
      () => {
        const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
        const identity = and(
          eq(longTasks.id, taskId),
          eq(longTasks.pluginId, pluginId),
          eq(longTasks.conversationId, conversationId),
          owner,
        );
        const waiting = this.#orm
          .update(longTasks)
          .set({ state: 'cancelled', finishedAt: at, updatedAt: at })
          .where(and(identity, eq(longTasks.state, 'waiting')))
          .run();
        if (waiting.changes > 0) {
          this.#orm
            .insert(taskReceipts)
            .values({
              taskId,
              status: 'cancelled',
              state: 'suppressed',
              createdAt: at,
              updatedAt: at,
              cancelledAt: at,
              cancelledBy: options?.cancelledBy ?? null,
              adminCancelled: options?.adminCancelled ?? false,
              cancelReason: options?.reason ?? null,
            })
            .run();
          return true;
        }
        const pending = this.#orm
          .update(taskReceipts)
          .set({
            state: 'suppressed',
            updatedAt: at,
            cancelledAt: at,
            cancelledBy: options?.cancelledBy ?? null,
            adminCancelled: options?.adminCancelled ?? false,
            cancelReason: options?.reason ?? null,
          })
          .where(
            and(
              eq(taskReceipts.taskId, taskId),
              eq(taskReceipts.state, 'pending'),
              sql`EXISTS (SELECT 1 FROM long_tasks lt WHERE lt.id = ${taskReceipts.taskId} AND lt.plugin_id = ${pluginId} AND lt.conversation_id = ${conversationId}${restricted && callerId !== null ? sql` AND lt.created_by_user_id = ${callerId}` : sql``})`,
            ),
          )
          .run();
        return pending.changes > 0;
      },
      { behavior: 'immediate' },
    );
    if (changed) {
      this.#wake?.();
    }
    return changed;
  }

  processDue(now: Date): void {
    const at = now.toISOString();
    const changed = this.#orm.transaction(
      () => {
        const due = this.#orm
          .select({ id: longTasks.id, timerResultJson: longTasks.timerResultJson })
          .from(longTasks)
          .where(and(eq(longTasks.state, 'waiting'), sql`${longTasks.scheduledAt} <= ${at}`))
          .orderBy(asc(longTasks.scheduledAt), asc(longTasks.id))
          .all();
        let count = 0;
        for (const task of due) {
          if (task.timerResultJson === null) {
            throw new Error('Timer task has no timer result');
          }
          const update = this.#orm
            .update(longTasks)
            .set({ state: 'completed', finishedAt: at, updatedAt: at })
            .where(and(eq(longTasks.id, task.id), eq(longTasks.state, 'waiting')))
            .run();
          if (update.changes === 0) {
            continue;
          }
          this.#orm
            .insert(taskReceipts)
            .values({
              taskId: task.id,
              status: 'completed',
              resultJson: task.timerResultJson,
              state: 'pending',
              createdAt: at,
              updatedAt: at,
            })
            .run();
          count += 1;
        }
        return count;
      },
      { behavior: 'immediate' },
    );
    if (changed > 0) {
      this.#wake?.();
    }
  }

  nextDeadline(): string | undefined {
    return (
      this.#orm
        .select({ scheduledAt: longTasks.scheduledAt })
        .from(longTasks)
        .where(and(eq(longTasks.state, 'waiting'), sql`${longTasks.scheduledAt} IS NOT NULL`))
        .orderBy(asc(longTasks.scheduledAt), asc(longTasks.id))
        .get()?.scheduledAt ?? undefined
    );
  }

  getCompletion(invocationId: bigint, bucketId: bigint): CompletionContext | undefined {
    const row = this.#orm
      .select({
        taskId: taskReceipts.taskId,
        pluginId: longTasks.pluginId,
        payloadJson: longTasks.payloadJson,
        status: taskReceipts.status,
        resultJson: taskReceipts.resultJson,
        errorJson: taskReceipts.errorJson,
        deliveryJson: longTasks.deliveryJson,
      })
      .from(taskReceipts)
      .innerJoin(longTasks, eq(taskReceipts.taskId, longTasks.id))
      .where(and(eq(taskReceipts.invocationId, invocationId), eq(taskReceipts.bucketId, bucketId)))
      .get();
    if (row === undefined) {
      return undefined;
    }
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled') {
      throw new Error('Invalid receipt status in database');
    }
    return {
      taskId: row.taskId,
      pluginId: row.pluginId,
      payload: parseJson(row.payloadJson, 'task payload'),
      status: row.status,
      delivery: readDelivery(row.deliveryJson),
      ...(row.resultJson === null ? {} : { resultJson: parseJson(row.resultJson, 'receipt result') }),
      ...(row.errorJson === null ? {} : { errorJson: parseJson(row.errorJson, 'receipt error') }),
    };
  }
}

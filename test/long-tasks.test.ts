import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/platform/config.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import { definePlugin, type InvocationScope, loadPlugins } from '../src/plugins/plugin.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService, TaskQuotaError } from '../src/store/long-tasks.ts';
import { longTasks, taskReceipts } from '../src/store/schema.ts';
import { writeTestConfig } from './helpers.ts';

const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of directories.splice(0)) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function initDb(): Promise<{ store: SqliteStore; conversationId: bigint }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-lt-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const { config } = await loadConfig(configPath);
  const store = await SqliteStore.open(config);
  stores.push(store);

  const chatId = 1n;
  store.db
    .prepare(
      `INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at)
     VALUES (?, 123, 123, 'private', '2025-01-01T00:00:00.000Z')`,
    )
    .run(chatId);
  const conversationId = 200n;
  store.db
    .prepare(
      `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
     VALUES (?, ?, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    )
    .run(conversationId, chatId);

  return { store, conversationId };
}

function seedInvocation(store: SqliteStore, invId: bigint, convId: bigint): void {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
     VALUES (?, ?, 'completed', 'realtime', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    )
    .run(invId, convId);
  store.db
    .prepare(
      `INSERT OR IGNORE INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
     VALUES (?, ?, ?, 'completed', 'h', 1, '2025-01-01T00:00:00.000Z')`,
    )
    .run(invId, invId, convId);
}

function ctx(convId: bigint, overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    ...previewContext(),
    invocationId: 100n,
    conversationId: convId,
    callerUserId: 42n,
    ...overrides,
  };
}

describe('LongTaskService', () => {
  test('loadPlugins binds task service without a sidecar context writer', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    let captured: InvocationScope | undefined;
    const loaded = loadPlugins([
      definePlugin({
        id: 'capture',
        capabilities: (scope) => {
          captured = scope;
          return [];
        },
      }),
    ]);
    loaded.capabilities(
      store,
      (await loadConfig(join(directories.at(-1)!, 'config.jsonc'))).config,
      ctx(conversationId),
      Date.now(),
    );
    const created = captured!.tasks.create({ payload: { ok: true } });
    expect(store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get()!.pluginId).toBe('capture');
    expect(captured).not.toHaveProperty('recordHiddenContext');
    expect(store.db.prepare('SELECT id FROM agent_messages').all()).toEqual([]);
  });

  test('creates a waiting task via invocationScope', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({
      payload: { key: 'value' },
      delivery: { bypassDailyBudget: false },
    });
    expect(typeof created.taskId).toBe('bigint');
    const row = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(row).toBeDefined();
    expect(row!.state).toBe('waiting');
    expect(row!.pluginId).toBe('test-plugin');
    expect(row!.createdByUserId).toBe(42n);
    expect(JSON.parse(row!.deliveryJson)).toEqual({ bypassDailyBudget: false });
  });

  test('creates a timer task with scheduled_at', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const scheduled = new Date(Date.now() + 86_400_000).toISOString();
    const created = scope.create({
      payload: { task: 'reminder' },
      delivery: { bypassDailyBudget: true, mentionUser: { userId: 99n, displayName: 'Target' } },
      scheduledAt: scheduled,
    });
    expect(created.scheduledAt).toBe(scheduled);
    const row = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(row!.scheduledAt).toBe(scheduled);
    const delivery = JSON.parse(row!.deliveryJson);
    expect(delivery.bypassDailyBudget).toBe(true);
    expect(delivery.mentionUser.userId).toBe('99');
  });

  test('creates a null-owned task but does not expose it through user scope', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId, { callerUserId: null }));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope.get(created.taskId)).toBeUndefined();
    expect(scope.list()).toEqual([]);
    expect(scope.cancel(created.taskId)).toBe(false);
  });

  test('enforces maxPerInvocation quota', async () => {
    const { store, conversationId } = await initDb();
    const invId = 300n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId, { invocationId: invId }));
    scope.create({ payload: { n: 1 }, delivery: { bypassDailyBudget: false }, maxPerInvocation: 2 });
    scope.create({ payload: { n: 2 }, delivery: { bypassDailyBudget: false }, maxPerInvocation: 2 });
    expect(() =>
      scope.create({ payload: { n: 3 }, delivery: { bypassDailyBudget: false }, maxPerInvocation: 2 }),
    ).toThrow(TaskQuotaError);
  });

  test('quota is per plugin, not shared', async () => {
    const { store, conversationId } = await initDb();
    const invId = 301n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const a = tasks.invocationScope('plugin-a', ctx(conversationId, { invocationId: invId }));
    const b = tasks.invocationScope('plugin-b', ctx(conversationId, { invocationId: invId }));
    a.create({ payload: 1, delivery: { bypassDailyBudget: false }, maxPerInvocation: 1 });
    const created = b.create({ payload: 2, delivery: { bypassDailyBudget: false }, maxPerInvocation: 1 });
    expect(typeof created.taskId).toBe('bigint');
  });

  test('scoped complete writes receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });

    const handle = tasks.scoped('test-plugin', conversationId);
    const ok = handle.complete(created.taskId, { result: 'done' });
    expect(ok).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('completed');
    expect(task!.finishedAt).toBeDefined();

    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt).toBeDefined();
    expect(receipt!.status).toBe('completed');
    expect(receipt!.state).toBe('pending');
    expect(JSON.parse(receipt!.resultJson!)).toEqual({ result: 'done' });
  });

  test('scoped complete is idempotent (CAS)', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const handle = tasks.scoped('test-plugin', conversationId);
    expect(handle.complete(created.taskId)).toBe(true);
    expect(handle.complete(created.taskId)).toBe(false);
  });

  test('scoped fail writes error receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const ok = tasks.scoped('test-plugin', conversationId).fail(created.taskId, { code: 'E_TIMEOUT' });
    expect(ok).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('failed');
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.status).toBe('failed');
    expect(JSON.parse(receipt!.errorJson!)).toEqual({ code: 'E_TIMEOUT' });
  });

  test('scoped works cross-plugin isolated', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('plugin-x', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('plugin-y', conversationId).complete(created.taskId)).toBe(false);
  });

  test('scoped works cross-conversation isolated after creator invocation is deleted', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('plugin-x', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    store.db.prepare('DELETE FROM invocations WHERE id = 100').run();
    expect(tasks.scoped('plugin-x', 999n).complete(created.taskId)).toBe(false);
    expect(tasks.scoped('plugin-x', conversationId).complete(created.taskId, { late: true })).toBe(true);
  });

  test("invocationScope list returns caller's waiting tasks", async () => {
    const { store, conversationId } = await initDb();
    const invId = 400n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId }));
    scope.create({ payload: { summary: 'a' }, delivery: { bypassDailyBudget: false } });
    scope.create({ payload: { summary: 'b' }, delivery: { bypassDailyBudget: false } });
    expect(scope.list()).toHaveLength(2);
  });

  test('invocationScope list returns empty for null caller', async () => {
    const { store, conversationId } = await initDb();
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId, { callerUserId: null }));
    expect(scope.list()).toEqual([]);
  });

  test('invocationScope list filters by caller', async () => {
    const { store, conversationId } = await initDb();
    const invId = 500n;
    seedInvocation(store, invId, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope42 = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId, callerUserId: 42n }));
    scope42.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const scope99 = tasks.invocationScope('alarm', ctx(conversationId, { invocationId: invId, callerUserId: 99n }));
    scope99.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope42.list()).toHaveLength(1);
    expect(scope99.list()).toHaveLength(1);
  });

  test('invocationScope cancel suppresses receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(scope.cancel(created.taskId)).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('cancelled');
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.status).toBe('cancelled');
    expect(receipt!.state).toBe('suppressed');
  });

  test('pending receipt cancellation is isolated by plugin, conversation, and live caller', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    let caller: bigint | null = 42n;
    const live = {
      ...ctx(conversationId),
      get callerUserId() {
        return caller;
      },
    };
    const ownerScope = tasks.invocationScope('alarm', live);
    const created = ownerScope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(true);

    caller = 99n;
    expect(ownerScope.cancel(created.taskId)).toBe(false);
    expect(tasks.invocationScope('other-plugin', ctx(conversationId)).cancel(created.taskId)).toBe(false);
    expect(tasks.invocationScope('alarm', ctx(999n)).cancel(created.taskId)).toBe(false);

    caller = 42n;
    expect(ownerScope.cancel(created.taskId)).toBe(true);
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.state).toBe('suppressed');
  });

  test('processDue completes timer tasks and calls wake', async () => {
    let woken = false;
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm, () => {
      woken = true;
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({
      payload: { summary: 'timer' },
      delivery: { bypassDailyBudget: true },
      scheduledAt: past,
    });

    tasks.processDue(new Date());
    expect(woken).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('completed');
    expect(task!.timerResultJson).toBeDefined();

    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt).toBeDefined();
    expect(receipt!.state).toBe('pending');
  });

  test('processDue skips future timers', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({
      payload: {},
      delivery: { bypassDailyBudget: false },
      scheduledAt: future,
    });
    tasks.processDue(new Date());
    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('waiting');
  });

  test('nextDeadline returns earliest waiting timer', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const t1 = new Date(Date.now() + 7200_000).toISOString();
    const t0 = new Date(Date.now() + 3600_000).toISOString();
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    scope.create({ payload: {}, delivery: { bypassDailyBudget: false }, scheduledAt: t1 });
    scope.create({ payload: {}, delivery: { bypassDailyBudget: false }, scheduledAt: t0 });
    expect(tasks.nextDeadline()).toBe(t0);
  });

  test('nextDeadline returns undefined when no timers', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.nextDeadline()).toBeUndefined();
  });

  test('getCompletion returns receipt bound to invocation', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: { data: 'x' }, delivery: { bypassDailyBudget: false } });
    tasks.scoped('test-plugin', conversationId).complete(created.taskId);

    // Seed an invocation for the receipt's FK.
    seedInvocation(store, 500n, conversationId);
    store.orm
      .update(taskReceipts)
      .set({
        state: 'claimed',
        invocationId: 500n,
        bucketId: 500n,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(taskReceipts.taskId, created.taskId))
      .run();

    const completion = tasks.getCompletion(500n, 500n);
    expect(tasks.getCompletion(500n, 100n)).toBeUndefined();
    expect(tasks.getCompletion(100n, 500n)).toBeUndefined();
    expect(completion).toBeDefined();
    expect(completion!.taskId).toBe(created.taskId);
    expect(completion!.pluginId).toBe('test-plugin');
    expect(completion!.payload).toEqual({ data: 'x' });
    expect(completion!.status).toBe('completed');
  });

  test('getCompletion returns undefined for non-receipt invocation', async () => {
    const { store } = await initDb();
    const tasks = new LongTaskService(store.orm);
    expect(tasks.getCompletion(999999n, 999999n)).toBeUndefined();
  });

  test('JSON payload rejects non-JSON structures without invoking accessors', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const scope = new LongTaskService(store.orm).invocationScope('test-plugin', ctx(conversationId));
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse = Array<unknown>(1);
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    const symbol = { ok: true };
    Object.defineProperty(symbol, Symbol('hidden'), { value: 1, enumerable: true });
    const arrayProperty: unknown[] = [];
    Object.defineProperty(arrayProperty, 'extra', { value: true, enumerable: true });

    for (const payload of [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      cycle,
      new Date(),
      sparse,
      getter,
      symbol,
      arrayProperty,
    ]) {
      expect(() => scope.create({ payload, delivery: { bypassDailyBudget: false } })).toThrow();
    }
  });

  test('JSON payload round-trips own __proto__ and constructor keys', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const scope = new LongTaskService(store.orm).invocationScope('test-plugin', ctx(conversationId));
    const payload = JSON.parse('{"nested":{"__proto__":{"polluted":true},"constructor":{"name":"kept"}}}') as unknown;

    const created = scope.create({ payload, delivery: { bypassDailyBudget: false } });
    const restored = scope.get(created.taskId)!.payload as Record<string, Record<string, unknown>>;
    expect(Object.hasOwn(restored.nested!, '__proto__')).toBe(true);
    expect(Object.hasOwn(restored.nested!, 'constructor')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(restored.nested!, '__proto__')?.value).toEqual({ polluted: true });
    expect(restored.nested!.constructor).toEqual({ name: 'kept' });
  });

  test('JSON byte limits count UTF-8 bytes', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    expect(() => scope.create({ payload: '猫'.repeat(6_000), delivery: { bypassDailyBudget: false } })).toThrow(
      'exceeds',
    );

    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(() =>
      tasks.scoped('test-plugin', conversationId).complete(created.taskId, { big: 'x'.repeat(17_000) }),
    ).toThrow('exceeds');
  });

  test('cancel via scoped works', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('test-plugin', conversationId).cancel(created.taskId)).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('cancelled');
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.state).toBe('suppressed');
  });

  test('complete, fail, and cancel race writes one terminal receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const handle = tasks.scoped('alarm', conversationId);
    expect(handle.fail(created.taskId, { code: 'first' })).toBe(true);
    expect(handle.complete(created.taskId, { value: 'late' })).toBe(false);
    expect(handle.cancel(created.taskId)).toBe(true);
    expect(store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).all()).toHaveLength(1);
    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('failed');
  });

  test('wake occurs only after successful state changes', async () => {
    let wakes = 0;
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm, () => {
      wakes += 1;
    });
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(wakes).toBe(1);
    expect(tasks.scoped('other', conversationId).complete(created.taskId)).toBe(false);
    expect(wakes).toBe(1);
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(true);
    expect(wakes).toBe(2);
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(false);
    expect(wakes).toBe(2);
  });
});

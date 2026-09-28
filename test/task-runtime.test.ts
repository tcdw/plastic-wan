import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { cancelOngoingSessions } from '../src/ingress/admin/operations.ts';
import { InvocationQueueService } from '../src/orchestration/invocation-queue.ts';
import type { InvocationHandler } from '../src/orchestration/scheduler.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { FileConfig, LoadedConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/store/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { enterSleep } from '../src/store/sleep.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const stores: SqliteStore[] = [];
const directories: string[] = [];

interface SetupResult {
  readonly directory: string;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly store: SqliteStore;
  readonly scheduler: BucketScheduler;
  readonly tasks: LongTaskService;
  readonly conversationId: bigint;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(
  transform?: (config: FileConfig) => void,
  handler: InvocationHandler = async () => ({ state: 'completed', reason: 'test' }),
): Promise<SetupResult> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-task-runtime-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  addConversation(store, 1n, 1n, 123456789n, 0n, 'private');
  const tasks = new LongTaskService(store.orm);
  return {
    directory,
    loaded,
    configStore,
    store,
    tasks,
    conversationId: 1n,
    scheduler: new BucketScheduler(store, configStore, handler, undefined, tasks),
  };
}

function addConversation(
  store: SqliteStore,
  chatId: bigint,
  conversationId: bigint,
  telegramChatId: bigint,
  threadId: bigint,
  type = 'private',
): void {
  const at = '2026-01-01T00:00:00.000Z';
  store.db
    .prepare(
      'INSERT OR IGNORE INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(chatId, telegramChatId, telegramChatId, type, at);
  store.db
    .prepare('INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, chatId, threadId, at, at);
}

function insertInvocation(
  store: SqliteStore,
  id: bigint,
  conversationId: bigint,
  state: 'queued' | 'running' | 'completed',
  kind = 'realtime',
): bigint {
  const at = new Date(Date.now() - 1_000).toISOString();
  store.db
    .prepare(
      'INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, conversationId, state === 'completed' ? 'completed' : state, kind, at, at, at, at);
  store.db
    .prepare(
      "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at, started_at) VALUES (?, ?, ?, ?, 'h', 1, ?, ?)",
    )
    .run(id, id, conversationId, state, at, state === 'running' ? at : null);
  store.db
    .prepare('INSERT INTO invocation_buckets(invocation_id, bucket_id, attached_at, injected_at) VALUES (?, ?, ?, ?)')
    .run(id, id, at, at);
  return id;
}

function taskState(store: SqliteStore, taskId: bigint): { state: string; invocation_id: bigint | null } | undefined {
  return store.db
    .prepare<[bigint], { state: string; invocation_id: bigint | null }>(
      'SELECT state, invocation_id FROM task_receipts WHERE task_id = ?',
    )
    .get(taskId);
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('active conversations attach multiple independent receipts even mid-round and reassign only unconsumed work', async () => {
  const { store, tasks, configStore, conversationId } = await setup();
  const running = insertInvocation(store, 10n, conversationId, 'running');
  const injections: { bucketId: bigint; kind: string | undefined }[] = [];
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => false,
      isRoundInProgress: () => true,
      queueInjection: (conversation, bucketId, kind) => {
        expect(conversation).toBe(conversationId);
        injections.push({ bucketId, kind });
      },
    },
    tasks,
  );
  const scope = tasks.scoped('test', conversationId);
  const first = scope.create({ payload: { index: 1 } });
  const second = scope.create({ payload: { index: 2 } });
  scope.complete(first.taskId);
  scope.complete(second.taskId);
  expect(queue.processTasksDue()).toEqual([]);
  expect(injections).toHaveLength(2);
  expect(injections.every((injection) => injection.kind === 'completion')).toBe(true);
  const firstBucket = injections[0]!.bucketId;
  const secondBucket = injections[1]!.bucketId;
  expect(firstBucket).not.toBe(secondBucket);
  expect(tasks.getCompletion(running, firstBucket)?.taskId).toBe(first.taskId);
  expect(tasks.getCompletion(running, secondBucket)?.taskId).toBe(second.taskId);
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM bucket_messages').get()).toEqual({ count: 0n });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
  store.db
    .prepare('UPDATE invocation_buckets SET injected_at = ? WHERE bucket_id = ?')
    .run(new Date().toISOString(), firstBucket);
  queue.releaseUninjectedBuckets(running, new Date());
  expect(taskState(store, first.taskId)).toEqual({ state: 'claimed', invocation_id: running });
  const reassigned = taskState(store, second.taskId)!;
  expect(reassigned.state).toBe('claimed');
  expect(reassigned.invocation_id).not.toBe(running);
  expect(tasks.getCompletion(running, secondBucket)).toBeUndefined();
  expect(tasks.getCompletion(reassigned.invocation_id!, secondBucket)?.taskId).toBe(second.taskId);
  // The old scheduler's finally must no longer settle the transferred receipt.
  store.db
    .prepare("UPDATE task_receipts SET state = 'handled' WHERE invocation_id = ? AND state = 'claimed'")
    .run(running);
  expect(taskState(store, second.taskId)?.state).toBe('claimed');
  queue.releaseUninjectedBuckets(running, new Date());
  expect(taskState(store, second.taskId)).toEqual(reassigned);
});

test('closing conversations keep receipts pending until a fresh invocation can wake', async () => {
  const { store, tasks, configStore, conversationId } = await setup();
  const running = insertInvocation(store, 10n, conversationId, 'running');
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => true,
      isRoundInProgress: () => false,
      queueInjection: () => {
        throw new Error('Closing run must not accept injection');
      },
    },
    tasks,
  );
  const scope = tasks.scoped('test', conversationId);
  const created = scope.create({ payload: {} });
  scope.complete(created.taskId);
  expect(queue.processTasksDue()).toEqual([]);
  expect(taskState(store, created.taskId)?.state).toBe('pending');
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(running);
  const [next] = queue.processTasksDue();
  expect(next).toBeDefined();
  expect(taskState(store, created.taskId)).toEqual({ state: 'claimed', invocation_id: next });
});

test.each(['admin_cancel', 'chat_paused'])('expired receipt buckets do not resurrect after %s', async (reason) => {
  const { store, tasks, configStore, conversationId } = await setup();
  const running = insertInvocation(store, 10n, conversationId, 'running');
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: () => {},
    },
    tasks,
  );
  const scope = tasks.scoped('test', conversationId);
  const created = scope.create({ payload: {} });
  scope.complete(created.taskId);
  queue.processTasksDue();
  store.db
    .prepare(
      "UPDATE buckets SET state = 'expired', error_code = ? WHERE id IN (SELECT bucket_id FROM task_receipts WHERE task_id = ?)",
    )
    .run(reason, created.taskId);
  queue.releaseUninjectedBuckets(running, new Date());
  expect(
    store.db
      .prepare('SELECT state, cancel_reason, admin_cancelled FROM task_receipts WHERE task_id = ?')
      .get(created.taskId),
  ).toEqual({
    state: 'suppressed',
    cancel_reason: reason,
    admin_cancelled: reason === 'admin_cancel' ? 1n : 0n,
  });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM invocations').get()).toEqual({ count: 1n });
  expect(queue.processTasksDue()).toEqual([]);
});

test('admin cancellation preserves completed receipts that have not been claimed yet', async () => {
  const { store, tasks, scheduler, conversationId } = await setup();
  const ordinary = insertInvocation(store, 10n, conversationId, 'queued');
  const scope = tasks.scoped('test', conversationId);
  const created = scope.create({ payload: { result: 'ready before cancellation' } });
  expect(scope.complete(created.taskId)).toBe(true);
  expect(taskState(store, created.taskId)).toEqual({ state: 'pending', invocation_id: null });

  expect(cancelOngoingSessions(store.orm)).toEqual({ canceled_buckets: 1, canceled_invocations: 1 });
  expect(store.db.prepare('SELECT state, completion_reason FROM invocations WHERE id = ?').get(ordinary)).toEqual({
    state: 'aborted',
    completion_reason: 'admin_cancel',
  });
  expect(
    store.db
      .prepare(
        'SELECT state, invocation_id, bucket_id, cancel_reason, admin_cancelled FROM task_receipts WHERE task_id = ?',
      )
      .get(created.taskId),
  ).toEqual({ state: 'pending', invocation_id: null, bucket_id: null, cancel_reason: null, admin_cancelled: 0n });
  expect(store.db.prepare('SELECT state FROM long_tasks WHERE id = ?').get(created.taskId)).toEqual({
    state: 'completed',
  });

  const [next] = scheduler.processTasksDue();
  expect(next).toBeDefined();
  expect(next).not.toBe(ordinary);
  expect(taskState(store, created.taskId)).toEqual({ state: 'claimed', invocation_id: next });
  expect(
    store.db
      .prepare(
        'SELECT i.state, b.state AS bucket_state FROM invocations i JOIN buckets b ON b.id = i.bucket_id WHERE i.id = ?',
      )
      .get(next!),
  ).toEqual({ state: 'queued', bucket_state: 'queued' });
});

test('a different topic stays pending while same-topic receipts attach', async () => {
  const { store, tasks, configStore } = await setup((config) => {
    config.telegram.chats[0] = { id: 123456789, topic_ids: [10, 20] };
  });
  store.db.prepare('UPDATE conversations SET message_thread_id = 10 WHERE id = 1').run();
  addConversation(store, 1n, 2n, 123456789n, 20n, 'supergroup');
  insertInvocation(store, 10n, 1n, 'running');
  const conversations: bigint[] = [];
  const queue = new InvocationQueueService(
    store,
    configStore,
    {
      isClosing: () => false,
      isRoundInProgress: () => false,
      queueInjection: (conversation) => {
        conversations.push(conversation);
      },
    },
    tasks,
  );
  const other = tasks.scoped('test', 2n).create({ payload: {} });
  tasks.scoped('test', 2n).complete(other.taskId);
  const same = tasks.scoped('test', 1n).create({ payload: {} });
  tasks.scoped('test', 1n).complete(same.taskId);
  expect(queue.processTasksDue()).toEqual([]);
  expect(conversations).toEqual([1n]);
  expect(taskState(store, other.taskId)?.state).toBe('pending');
  expect(taskState(store, same.taskId)).toEqual({ state: 'claimed', invocation_id: 10n });
});

test('a pending receipt survives reopening the store and remains deliverable', async () => {
  const first = await setup();
  const created = first.tasks
    .scoped('external-plugin', first.conversationId)
    .create({ payload: { job: 'after restart' } });
  expect(first.tasks.scoped('external-plugin', first.conversationId).complete(created.taskId)).toBe(true);
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);

  const reopened = await SqliteStore.open(first.loaded.config);
  stores.push(reopened);
  const scheduler = new BucketScheduler(reopened, first.configStore, async () => ({
    state: 'completed',
    reason: 'test',
  }));
  scheduler.recover(new Date());
  expect(taskState(reopened, created.taskId)?.state).toBe('pending');
  expect(scheduler.processTasksDue(new Date())).toHaveLength(1);
  expect(taskState(reopened, created.taskId)?.state).toBe('claimed');
});

test('recovery closes every claimed receipt shape once and aborts queued receipt buckets', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  const variants = ['queued', 'running-clean', 'running-send', 'terminal', 'null'] as const;
  const ids = new Map<(typeof variants)[number], bigint>();
  for (const [index, variant] of variants.entries()) {
    const created = tasks.scoped('external-plugin', conversationId).create({ payload: { variant } });
    tasks.scoped('external-plugin', conversationId).complete(created.taskId);
    ids.set(variant, created.taskId);
    if (variant !== 'null') {
      const invocationId = 100n + BigInt(index);
      const variantConversationId = BigInt(index + 1);
      if (variantConversationId !== conversationId) {
        addConversation(store, BigInt(index + 1), variantConversationId, 123456789n + BigInt(index), 0n);
      }
      const state = variant === 'terminal' ? 'completed' : variant === 'queued' ? 'queued' : 'running';
      insertInvocation(store, invocationId, variantConversationId, state);
      store.db
        .prepare(
          "UPDATE task_receipts SET state = 'claimed', invocation_id = ?, claimed_at = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(invocationId, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', created.taskId);
      if (variant === 'queued') {
        const attached = 200n;
        const at = '2026-01-02T00:00:00.000Z';
        store.db
          .prepare(
            "INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (?, ?, 'queued', 'realtime', ?, ?, ?, ?)",
          )
          .run(attached, variantConversationId, at, at, at, at);
        store.db
          .prepare('INSERT INTO invocation_buckets(invocation_id, bucket_id, attached_at) VALUES (?, ?, ?)')
          .run(invocationId, attached, at);
      }
      if (variant === 'running-send') {
        store.db.prepare('UPDATE invocations SET side_effect_started = 1 WHERE id = ?').run(invocationId);
        store.db
          .prepare(
            "INSERT INTO tool_calls(id, invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at) VALUES (1, ?, 'send-call', 'send', '{}', 'pending', 1, ?)",
          )
          .run(invocationId, '2026-01-02T00:00:00.000Z');
        store.db
          .prepare(
            "INSERT INTO telegram_sends(tool_call_id, conversation_id, kind, request_json, state, created_at) VALUES (1, ?, 'text', '{}', 'pending', ?)",
          )
          .run(conversationId, '2026-01-02T00:00:00.000Z');
      }
    } else {
      store.db
        .prepare("UPDATE task_receipts SET state = 'claimed', claimed_at = ?, updated_at = ? WHERE task_id = ?")
        .run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', created.taskId);
    }
  }

  const recoveredAt = new Date('2026-01-03T00:00:00.000Z');
  scheduler.recover(recoveredAt);
  for (const taskId of ids.values()) {
    expect(
      store.db
        .prepare<
          [bigint],
          {
            state: string;
            invocation_outcome: string | null;
            completion_reason: string | null;
            handled_at: string | null;
            updated_at: string;
          }
        >(
          'SELECT state, invocation_outcome, completion_reason, handled_at, updated_at FROM task_receipts WHERE task_id = ?',
        )
        .get(taskId),
    ).toEqual({
      state: 'handled',
      invocation_outcome: 'outcome_unknown',
      completion_reason: 'outcome_unknown',
      handled_at: recoveredAt.toISOString(),
      updated_at: recoveredAt.toISOString(),
    });
  }
  expect(store.db.prepare('SELECT state, completion_reason FROM invocations WHERE id = 100').get()).toEqual({
    state: 'aborted',
    completion_reason: 'process_restart',
  });
  expect(
    store.db.prepare('SELECT id, state, error_code FROM buckets WHERE id IN (100, 200) ORDER BY id').all(),
  ).toEqual([
    { id: 100n, state: 'aborted', error_code: 'process_restart' },
    { id: 200n, state: 'aborted', error_code: 'process_restart' },
  ]);
  expect(store.db.prepare('SELECT state FROM invocations WHERE id = 101').get()).toEqual({ state: 'aborted' });
  expect(store.db.prepare('SELECT state FROM invocations WHERE id = 102').get()).toEqual({ state: 'outcome_unknown' });
  expect(store.db.prepare('SELECT state FROM telegram_sends WHERE tool_call_id = 1').get()).toEqual({
    state: 'pending',
  });
  expect(store.db.prepare('SELECT state FROM invocations WHERE id = 103').get()).toEqual({ state: 'completed' });

  const before = store.db.prepare('SELECT task_id, handled_at, updated_at FROM task_receipts ORDER BY task_id').all();
  scheduler.recover(new Date('2026-01-04T00:00:00.000Z'));
  expect(store.db.prepare('SELECT task_id, handled_at, updated_at FROM task_receipts ORDER BY task_id').all()).toEqual(
    before,
  );
});

test('receipt invocations outrank ordinary work, serialize topics of one chat, and run across chats', async () => {
  const starts: bigint[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const { store, scheduler, tasks } = await setup(
    (config) => {
      config.telegram.chats[0] = { id: 123456789, topic_ids: [10, 20] };
      config.telegram.chats.push({ id: 987654321 }, { id: 777777777 }, { id: 888888888 });
      config.agent.max_concurrency = 2;
    },
    async (invocationId) => {
      starts.push(invocationId);
      const gate = gates.get(invocationId.toString());
      if (gate !== undefined) {
        await gate.promise;
      }
      return { state: 'completed', reason: 'done' };
    },
  );
  store.db.prepare('UPDATE conversations SET message_thread_id = 10 WHERE id = 1').run();
  addConversation(store, 1n, 2n, 123456789n, 20n, 'supergroup');
  addConversation(store, 2n, 3n, 987654321n, 0n);
  addConversation(store, 3n, 4n, 777777777n, 0n);
  addConversation(store, 4n, 5n, 888888888n, 0n);
  const blockerA = insertInvocation(store, 8n, 4n, 'queued');
  const blockerB = insertInvocation(store, 9n, 5n, 'queued');
  gates.set(blockerA.toString(), deferred());
  gates.set(blockerB.toString(), deferred());

  try {
    scheduler.start();
    await eventually(() => starts.length === 2, 'initial concurrency blockers');

    const ordinarySameChat = insertInvocation(store, 10n, 2n, 'queued');
    const ordinaryOtherChat = insertInvocation(store, 11n, 3n, 'queued');
    gates.set(ordinaryOtherChat.toString(), deferred());
    const receipt = tasks.scoped('external-plugin', 1n).create({ payload: { priority: true } });
    tasks.scoped('external-plugin', 1n).complete(receipt.taskId);
    const [receiptInvocation] = scheduler.processTasksDue(new Date());
    if (receiptInvocation === undefined) {
      throw new Error('Expected receipt invocation');
    }
    gates.set(receiptInvocation.toString(), deferred());

    gates.get(blockerA.toString())?.resolve();
    gates.get(blockerB.toString())?.resolve();
    await eventually(() => starts.length === 4, 'receipt and cross-chat ordinary launches');
    expect(starts.slice(2)).toContain(receiptInvocation);
    expect(starts.slice(2)).toContain(ordinaryOtherChat);
    expect(starts).not.toContain(ordinarySameChat);
    gates.get(receiptInvocation.toString())?.resolve();
    await eventually(() => starts.includes(ordinarySameChat), 'same-chat topic after receipt');
  } finally {
    for (const gate of gates.values()) {
      gate.resolve();
    }
    await scheduler.stop();
  }
});

test('sleep entered after receipt claim but before launch settles it as skipped_budget', async () => {
  const blocker = deferred();
  const blockerStarted = deferred();
  let first = true;
  const { store, scheduler, tasks, conversationId } = await setup(
    (config) => {
      config.telegram.chats.push({ id: 987654321 });
      config.agent.max_concurrency = 1;
    },
    async () => {
      if (first) {
        first = false;
        blockerStarted.resolve();
        await blocker.promise;
      }
      return { state: 'completed', reason: 'done' };
    },
  );
  addConversation(store, 2n, 2n, 987654321n, 0n);
  insertInvocation(store, 50n, 2n, 'queued');

  try {
    scheduler.start();
    await blockerStarted.promise;
    const created = tasks.scoped('external-plugin', conversationId).create({ payload: { race: 'sleep' } });
    tasks.scoped('external-plugin', conversationId).complete(created.taskId);
    const [receiptInvocation] = scheduler.processTasksDue(new Date());
    expect(receiptInvocation).toBeDefined();
    expect(taskState(store, created.taskId)?.state).toBe('claimed');
    enterSleep(store.orm, new Date());
    blocker.resolve();
    await eventually(() => taskState(store, created.taskId)?.state === 'handled', 'sleep settlement');
    expect(
      store.db
        .prepare<[bigint], { state: string; completion_reason: string }>(
          'SELECT state, completion_reason FROM invocations WHERE id = ?',
        )
        .get(receiptInvocation!),
    ).toEqual({ state: 'skipped_budget', completion_reason: 'sleeping' });
    expect(
      store.db
        .prepare<[bigint], { state: string; invocation_outcome: string; completion_reason: string }>(
          'SELECT state, invocation_outcome, completion_reason FROM task_receipts WHERE task_id = ?',
        )
        .get(created.taskId),
    ).toEqual({ state: 'handled', invocation_outcome: 'skipped_budget', completion_reason: 'sleeping' });
  } finally {
    blocker.resolve();
    await scheduler.stop();
  }
});

test('busy timer completion stays pending without a spin and launches when the running chat finishes', async () => {
  const running = deferred();
  const firstStarted = deferred();
  const receiptStarted = deferred();
  let handlerCalls = 0;
  const { store, scheduler, tasks, conversationId } = await setup(undefined, async () => {
    handlerCalls += 1;
    if (handlerCalls === 1) {
      firstStarted.resolve();
      await running.promise;
    } else {
      receiptStarted.resolve();
    }
    return { state: 'completed', reason: 'done' };
  });
  insertInvocation(store, 70n, conversationId, 'queued');
  const due = new Date(Date.now() + 20);
  const timer = tasks.scoped('timer-plugin', conversationId).create({
    payload: { timer: true },
    scheduledAt: due.toISOString(),
    timerResult: { fired: true },
  });

  try {
    scheduler.start();
    await firstStarted.promise;
    await eventually(() => taskState(store, timer.taskId)?.state === 'pending', 'timer completion while busy');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handlerCalls).toBe(1);
    expect(taskState(store, timer.taskId)?.state).toBe('pending');
    running.resolve();
    await receiptStarted.promise;
    await eventually(() => taskState(store, timer.taskId)?.state === 'handled', 'receipt after busy run');
    expect(handlerCalls).toBe(2);
  } finally {
    running.resolve();
    await scheduler.stop();
  }
});

test('task service wake callback only nudges the existing scheduler', async () => {
  const { store, scheduler, conversationId } = await setup();
  let wakes = 0;
  const tasks = new LongTaskService(store.orm, () => {
    wakes += 1;
    scheduler.wake();
  });
  scheduler.start();
  try {
    const created = tasks.scoped('external-plugin', conversationId).create({ payload: { wake: true } });
    expect(wakes).toBe(1);
    tasks.scoped('external-plugin', conversationId).complete(created.taskId);
    expect(wakes).toBe(2);
    await eventually(
      () => taskState(store, created.taskId)?.state === 'handled',
      'delivery through existing scheduler',
    );
  } finally {
    await scheduler.stop();
  }
});

test('pending default receipts wait for sleep, while bypass receipts can claim', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  const defaultTask = tasks.scoped('external-plugin', conversationId).create({ payload: { type: 'default' } });
  const bypassTask = tasks.scoped('external-plugin', conversationId).create({
    payload: { type: 'bypass' },
    delivery: { bypassDailyBudget: true },
  });
  expect(tasks.scoped('external-plugin', conversationId).complete(defaultTask.taskId)).toBe(true);
  expect(tasks.scoped('external-plugin', conversationId).complete(bypassTask.taskId)).toBe(true);
  enterSleep(store.orm, new Date());

  scheduler.processTasksDue(new Date());

  expect(taskState(store, defaultTask.taskId)?.state).toBe('pending');
  expect(taskState(store, bypassTask.taskId)?.state).toBe('claimed');
});

test('timer completion becomes pending even while its chat has a running invocation, without claiming delivery', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  insertInvocation(store, 9n, conversationId, 'running');
  const due = '2026-01-02T00:00:00.000Z';
  const created = tasks.scoped('timer-plugin', conversationId).create({
    payload: { subject: 'timer' },
    scheduledAt: due,
    timerResult: { fired: true },
  });

  expect(scheduler.processTasksDue(new Date(due))).toEqual([]);
  expect(
    store.db.prepare<[bigint], { state: string }>('SELECT state FROM long_tasks WHERE id = ?').get(created.taskId)
      ?.state,
  ).toBe('completed');
  expect(taskState(store, created.taskId)?.state).toBe('pending');
});

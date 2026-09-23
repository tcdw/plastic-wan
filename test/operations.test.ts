import { afterAll, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { loadConfig } from '../src/platform/config.ts';
import {
  backupDatabase,
  purgeExpiredData,
  ServeLock,
  SqliteStore,
  stopRunningInstance,
  watchStopRequests,
} from '../src/store/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { writeTestConfig, pathExists, sleep, testConfigStore } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  // Cleanup must not fail the suite: on Windows an open SQLite handle can make
  // `rm` lose the race, and a leaked temp directory is acceptable here.
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined),
    ),
  );
});

test('retention scrubs referenced history and backup keeps seven consistent copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-operations-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const oldReceived = new Date('2026-01-01T00:00:00.000Z');
  ingestion.ingest(textUpdate(1, 10, 'old private text'), oldReceived);
  const [oldInvocation] = scheduler.processDue(new Date(oldReceived.getTime() + 15_000));
  if (oldInvocation === undefined) {
    throw new Error('Expected old invocation');
  }
  store.db
    .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
    .run(oldReceived.toISOString(), oldInvocation);
  store.db
    .prepare(
      "UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
    )
    .run(oldReceived.toISOString(), oldReceived.toISOString(), oldInvocation);
  store.db
    .prepare(
      "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (?, 'old-tool', 'probe', '{\"secret\":true}', 'old result', 'success', 0, ?, ?)",
    )
    .run(oldInvocation, oldReceived.toISOString(), oldReceived.toISOString());

  const newReceived = new Date('2026-02-15T00:00:00.000Z');
  ingestion.ingest(textUpdate(2, 11, 'new private text'), newReceived);
  const [newInvocation] = scheduler.processDue(new Date(newReceived.getTime() + 15_000));
  if (newInvocation === undefined) {
    throw new Error('Expected new invocation');
  }
  const historyBefore = store.db
    .prepare<[bigint], { snapshot_json: string }>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history'",
    )
    .get(newInvocation);
  expect(historyBefore?.snapshot_json).toContain('old private text');

  store.db
    .prepare(
      `INSERT INTO internal_contexts(
         conversation_id, invocation_id, source_agent_message_id, kind, version, observed_at, payload_json, created_at
       ) VALUES (
         (SELECT conversation_id FROM invocations WHERE id = ?),
         ?,
         NULL,
         'alarm_list',
         1,
         ?,
         ?,
         ?
       )`,
    )
    .run(
      oldInvocation,
      oldInvocation,
      oldReceived.toISOString(),
      JSON.stringify({
        kind: 'alarm_list',
        version: 1,
        observed_at: oldReceived.toISOString(),
        items: [{ id: 'old-alarm', scheduled_at: '2026-01-02T00:00:00.000Z', summary: 'old summary' }],
      }),
      oldReceived.toISOString(),
    );
  store.db
    .prepare(
      `INSERT INTO internal_contexts(
         conversation_id, invocation_id, source_agent_message_id, kind, version, observed_at, payload_json, created_at
       ) VALUES (
         (SELECT conversation_id FROM invocations WHERE id = ?),
         ?,
         NULL,
         'alarm_list',
         1,
         ?,
         ?,
         ?
       )`,
    )
    .run(
      newInvocation,
      newInvocation,
      newReceived.toISOString(),
      JSON.stringify({
        kind: 'alarm_list',
        version: 1,
        observed_at: newReceived.toISOString(),
        items: [{ id: 'new-alarm', scheduled_at: '2026-02-16T00:00:00.000Z', summary: 'new summary' }],
      }),
      newReceived.toISOString(),
    );

  purgeExpiredData(store.orm, loaded.config, newReceived);
  expect(
    store.db
      .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations WHERE id = ?')
      .get(oldInvocation)?.count,
  ).toBe(0n);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_call_id = 'old-tool'")
      .get()?.count,
  ).toBe(0n);
  expect(
    store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates WHERE update_id = 1').get()
      ?.count,
  ).toBe(0n);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM internal_contexts WHERE payload_json LIKE '%old-alarm%'",
      )
      .get()?.count,
  ).toBe(0n);
  expect(
    store.db
      .prepare<[], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM internal_contexts WHERE payload_json LIKE '%new-alarm%'",
      )
      .get()?.count,
  ).toBe(1n);
  const scrubbed = store.db
    .prepare<[], { text: string | null; raw: string }>(
      'SELECT r.text, r.raw_fragment_json AS raw FROM message_revisions r JOIN messages m ON m.id = r.message_id WHERE m.telegram_message_id = 10',
    )
    .get();
  expect(scrubbed).toEqual({ text: null, raw: '{}' });
  const retainedSnapshot = store.db
    .prepare<[bigint], { snapshot_json: string }>(
      "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history'",
    )
    .get(newInvocation);
  expect(retainedSnapshot?.snapshot_json).toContain('old private text');
  store.close();

  await mkdir(loaded.config.paths.backups, { recursive: true });
  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const path = join(loaded.config.paths.backups, `old-${index}.sqlite`);
      await writeFile(path, 'old');
      await utimes(path, new Date(0), new Date(index * 1_000));
    }),
  );
  const backupPath = await backupDatabase(loaded.config);
  expect(await pathExists(backupPath)).toBe(true);
  const backups = (await readdir(loaded.config.paths.backups)).filter((name) => name.endsWith('.sqlite'));
  expect(backups).toHaveLength(7);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  const integrity = backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
  expect(integrity?.integrity_check).toBe('ok');
  backup.close();
});

test('takeover stops the instance holding the lock and leaves no stop request behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lockPath = join(dataDir, 'serve.lock');
  const stopPath = join(dataDir, 'serve.stop');

  // Nothing to stop.
  expect(await stopRunningInstance(dataDir, 1_000)).toBeNull();

  // A lock whose process is gone is not an instance: `ServeLock.acquire` unlinks
  // it, and a stop request written for it would wait for nobody.
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(exited, 'exit');
  if (exited.pid === undefined) {
    throw new Error('helper process did not start');
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(lockPath, `${exited.pid}\n`);
  expect(await stopRunningInstance(dataDir, 1_000)).toBeNull();
  expect(await pathExists(stopPath)).toBe(false);

  // A live holder: the lock disappears only because the watcher saw the request.
  const lock = await ServeLock.acquire(dataDir);
  let requested = false;
  const stopWatching = watchStopRequests(dataDir, () => {
    requested = true;
    void lock.release();
  });
  expect(await stopRunningInstance(dataDir, 5_000)).toBe(process.pid);
  expect(requested).toBe(true);
  expect(await pathExists(lockPath)).toBe(false);
  expect(await pathExists(stopPath)).toBe(false);
  stopWatching();
});

test('takeover gives up on an instance that ignores the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  const lock = await ServeLock.acquire(dataDir);
  await expect(stopRunningInstance(dataDir, 500)).rejects.toThrow(/still holds/);
  expect(await pathExists(join(dataDir, 'serve.stop'))).toBe(false);
  await lock.release();
});

test('a stale stop request does not stop the instance that starts next', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-takeover-'));
  directories.push(directory);
  const dataDir = join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'serve.stop'), '4242\n');
  let requested = false;
  const stopWatching = watchStopRequests(dataDir, () => {
    requested = true;
  });
  await sleep(600);
  expect(requested).toBe(false);
  expect(await pathExists(join(dataDir, 'serve.stop'))).toBe(false);
  stopWatching();
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

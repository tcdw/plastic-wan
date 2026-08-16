import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { loadConfig } from "../src/config.ts";
import { backupDatabase, purgeExpiredData, SqliteStore } from "../src/database.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { writeTestConfig } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

test("retention scrubs referenced history and backup keeps seven consistent copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-operations-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
  const oldReceived = new Date("2026-01-01T00:00:00.000Z");
  ingestion.ingest(textUpdate(1, 10, "old private text"), oldReceived);
  const [oldInvocation] = scheduler.processDue(new Date(oldReceived.getTime() + 15_000));
  if (oldInvocation === undefined) throw new Error("Expected old invocation");
  store.db.query("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?").run(oldReceived.toISOString(), oldInvocation);
  store.db.query("UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(oldReceived.toISOString(), oldReceived.toISOString(), oldInvocation);
  store.db.query("INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (?, 'old-tool', 'probe', '{\"secret\":true}', 'old result', 'success', 0, ?, ?)")
    .run(oldInvocation, oldReceived.toISOString(), oldReceived.toISOString());

  const newReceived = new Date("2026-02-15T00:00:00.000Z");
  ingestion.ingest(textUpdate(2, 11, "new private text"), newReceived);
  const [newInvocation] = scheduler.processDue(new Date(newReceived.getTime() + 15_000));
  if (newInvocation === undefined) throw new Error("Expected new invocation");
  const historyBefore = store.db
    .query<{ snapshot_json: string }, [bigint]>("SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history'")
    .get(newInvocation);
  expect(historyBefore?.snapshot_json).toContain("old private text");

  purgeExpiredData(store.db, loaded.config, newReceived);
  expect(store.db.query<{ count: bigint }, [bigint]>("SELECT COUNT(*) AS count FROM invocations WHERE id = ?").get(oldInvocation)?.count).toBe(0n);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_call_id = 'old-tool'").get()?.count).toBe(0n);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM telegram_updates WHERE update_id = 1").get()?.count).toBe(0n);
  const scrubbed = store.db
    .query<{ text: string | null; raw: string }, []>("SELECT r.text, r.raw_fragment_json AS raw FROM message_revisions r JOIN messages m ON m.id = r.message_id WHERE m.telegram_message_id = 10")
    .get();
  expect(scrubbed).toEqual({ text: null, raw: "{}" });
  const retainedSnapshot = store.db
    .query<{ snapshot_json: string }, [bigint]>("SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history'")
    .get(newInvocation);
  expect(retainedSnapshot?.snapshot_json).toContain("old private text");
  store.close();

  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const path = join(loaded.config.paths.backups, `old-${index}.sqlite`);
    await Bun.write(path, "old");
    await utimes(path, new Date(0), new Date(index * 1_000));
  }));
  const backupPath = await backupDatabase(loaded.config);
  expect(await Bun.file(backupPath).exists()).toBe(true);
  const backups = (await readdir(loaded.config.paths.backups)).filter((name) => name.endsWith(".sqlite"));
  expect(backups).toHaveLength(7);
  const backup = new Database(backupPath, { readonly: true, strict: true, safeIntegers: true });
  expect(backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  backup.close();
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: "private", first_name: "Owner" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text,
    },
  };
}

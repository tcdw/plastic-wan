import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { loadConfig, type LoadedConfig } from "../src/config.ts";
import { SqliteStore } from "../src/database.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { testConfigToml, writeTestConfig } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function setup(transform?: (toml: string) => string): Promise<{
  loaded: LoadedConfig;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
}> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-scheduler-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  const toml = transform?.(testConfigToml(directory)) ?? testConfigToml(directory);
  await writeTestConfig(directory, configPath, toml);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return {
    loaded,
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999 }),
    scheduler: new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" })),
  };
}

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

describe("bucket scheduler", () => {
  test("freezes the latest revision at the fixed deadline", async () => {
    const { store, ingestion, scheduler } = await setup((toml) => toml.replace("bucket_window_seconds = 15", "bucket_window_seconds = 6"));
    const start = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(textUpdate(1, 10, "before"), start);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_005,
        date: 1_700_000_010,
        chat: { id: 123456789, type: "private", first_name: "Owner" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "after",
      },
    };
    ingestion.ingest(edited, new Date(start.getTime() + 5_000));
    expect(scheduler.processDue(new Date(start.getTime() + 5_999))).toHaveLength(0);
    expect(scheduler.processDue(new Date(start.getTime() + 6_000))).toHaveLength(1);
    const snapshot = store.db
      .query<{ snapshot_json: string }, []>("SELECT snapshot_json FROM invocation_messages WHERE section = 'new'")
      .get();
    expect(snapshot === null ? null : JSON.parse(snapshot.snapshot_json).text).toBe("after");
    store.close();
  });

  test("post-deadline edits affect future history without rewriting the frozen invocation", async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(textUpdate(1, 10, "before"), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (firstInvocation === undefined) throw new Error("Expected first invocation");
    store.db.query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)").run(firstInvocation);
    store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(firstInvocation);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_020,
        date: 1_700_000_010,
        chat: { id: 123456789, type: "private", first_name: "Owner" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        text: "after",
      },
    };
    ingestion.ingest(edited, new Date(start.getTime() + 16_000));
    ingestion.ingest(textUpdate(3, 11, "next"), new Date(start.getTime() + 20_000));
    const [secondInvocation] = scheduler.processDue(new Date(start.getTime() + 35_000));
    if (secondInvocation === undefined) throw new Error("Expected second invocation");
    const frozen = store.db
      .query<{ snapshot_json: string }, [bigint]>("SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'new'")
      .get(firstInvocation);
    const future = store.db
      .query<{ snapshot_json: string }, [bigint]>("SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no DESC LIMIT 1")
      .get(secondInvocation);
    expect(frozen === null ? null : JSON.parse(frozen.snapshot_json).text).toBe("before");
    expect(future === null ? null : JSON.parse(future.snapshot_json).text).toBe("after");
    store.close();
  });

  test("recovers a bucket younger than five minutes", async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(textUpdate(1, 10, "recent"), start);
    const recoveredAt = new Date(start.getTime() + 4 * 60_000);
    scheduler.recover(recoveredAt);
    const [invocationId] = scheduler.processDue(recoveredAt);
    expect(invocationId).toBeDefined();
    expect(store.db.query<{ state: string }, []>("SELECT state FROM buckets").get()?.state).toBe("queued");
    store.close();
  });

  test("expires restart work older than five minutes", async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(textUpdate(1, 10, "old"), start);
    scheduler.recover(new Date(start.getTime() + 5 * 60_000 + 1));
    expect(store.db.query<{ state: string }, []>("SELECT state FROM buckets").get()?.state).toBe("expired");
    store.close();
  });

  test("merges more than three queued buckets and refunds reservations", async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date("2026-08-15T00:00:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      const received = new Date(start.getTime() + index * 20_000);
      ingestion.ingest(textUpdate(index + 1, index + 10, `message-${index}`), received);
      scheduler.processDue(new Date(received.getTime() + 15_000));
    }
    const states = store.db
      .query<{ state: string; count: bigint }, []>("SELECT state, COUNT(*) AS count FROM buckets GROUP BY state ORDER BY state")
      .all();
    expect(states).toEqual([
      { state: "merged", count: 4n },
      { state: "queued", count: 1n },
    ]);
    const invocationUsage = store.db
      .query<{ amount: bigint }, []>("SELECT amount FROM daily_usage WHERE metric = 'agent_invocations'")
      .get();
    expect(invocationUsage?.amount).toBe(1n);
    const boundaries = store.db
      .query<{ count: bigint }, []>("SELECT COUNT(DISTINCT source_bucket_id) AS count FROM bucket_messages WHERE bucket_id = (SELECT id FROM buckets WHERE state = 'queued')")
      .get();
    expect(boundaries?.count).toBe(4n);
    store.close();
  });

  test("skips a bucket once the daily invocation reservation is exhausted", async () => {
    const { store, ingestion, scheduler } = await setup((toml) => toml.replace("max_invocations_per_day = 100", "max_invocations_per_day = 1"));
    const start = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(textUpdate(1, 10, "first"), start);
    scheduler.processDue(new Date(start.getTime() + 15_000));
    const secondStart = new Date(start.getTime() + 20_000);
    ingestion.ingest(textUpdate(2, 11, "second"), secondStart);
    scheduler.processDue(new Date(secondStart.getTime() + 15_000));
    const states = store.db
      .query<{ state: string }, []>("SELECT state FROM buckets ORDER BY id")
      .all()
      .map((row) => row.state);
    expect(states).toEqual(["queued", "skipped_budget"]);
    store.close();
  });
});

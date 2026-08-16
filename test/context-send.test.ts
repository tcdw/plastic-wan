import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "grammy";
import type { Update } from "grammy/types";
import { loadConfig } from "../src/config.ts";
import { ContextBuilder } from "../src/context-builder.ts";
import { SqliteStore } from "../src/database.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import { createSendTool, type TelegramSendApi } from "../src/send-tool.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { writeTestConfig } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function setup(): Promise<{
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  builder: ContextBuilder;
}> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-context-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return {
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999 }),
    scheduler: new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" })),
    builder: new ContextBuilder(store, loaded.config),
  };
}

function update(updateId: number, messageId: number, text: string): Update {
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

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) throw new Error("Expected one due invocation");
  return invocationId;
}

describe("invocation context", () => {
  test("uses twenty prior Telegram messages and separates the current bucket", async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date("2026-08-15T00:00:00.000Z");
    let latestInvocation = 0n;
    for (let index = 0; index < 22; index += 1) {
      const received = new Date(start.getTime() + index * 20_000);
      ingestion.ingest(update(index + 1, index + 1, `message-${index}`), received);
      latestInvocation = processOne(scheduler, new Date(received.getTime() + 15_000));
      store.db.query("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)").run(latestInvocation);
      store.db.query("UPDATE invocations SET state = 'completed' WHERE id = ?").run(latestInvocation);
    }
    const counts = store.db
      .query<{ section: string; count: bigint }, [bigint]>(
        "SELECT section, COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? GROUP BY section ORDER BY section",
      )
      .all(latestInvocation);
    expect(counts).toEqual([
      { section: "history", count: 20n },
      { section: "new", count: 1n },
    ]);
    store.close();
  });
});

describe("send tool", () => {
  test("sends plain text, audits it, and writes Telegram-visible history", async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(update(1, 10, "hello"), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0);
    const api: TelegramSendApi = {
      sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
    });
    await tool.execute("call-1", { kind: "text", text: "world", reply_to_message_id: "10" });
    const audit = store.db
      .query<{ tool_state: string; send_state: string; sent_by_bot: bigint; text: string }, []>(
        "SELECT tc.state AS tool_state, ts.state AS send_state, m.sent_by_bot, r.text FROM tool_calls tc JOIN telegram_sends ts ON ts.tool_call_id = tc.id JOIN messages m ON m.telegram_message_id = ts.telegram_message_id JOIN message_revisions r ON r.id = m.current_revision_id",
      )
      .get();
    expect(audit).toEqual({ tool_state: "success", send_state: "success", sent_by_bot: 1n, text: "world" });
    store.close();
  });

  test("rejects and audits a reply outside visible context", async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(update(1, 10, "hello"), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0);
    const api: TelegramSendApi = {
      sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } }),
    };
    const tool = createSendTool({
      store,
      api,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
    });
    await expect(tool.execute("call-1", { kind: "text", text: "world", reply_to_message_id: "9999" })).rejects.toThrow("not visible");
    const row = store.db.query<{ state: string; error_code: string }, []>("SELECT state, error_code FROM tool_calls").get();
    expect(row).toEqual({ state: "error", error_code: "reply_not_visible" });
    expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM telegram_sends").get()?.count).toBe(0n);
    store.close();
  });
  test("enforces six sends and does not retry an unknown network outcome", async () => {
    const { store, ingestion, scheduler, builder } = await setup();
    const received = new Date("2026-08-15T00:00:00.000Z");
    ingestion.ingest(update(1, 10, "hello"), received);
    const invocationId = processOne(scheduler, new Date(received.getTime() + 15_000));
    const context = builder.build(invocationId, 200_000, 0);
    let successfulCalls = 0;
    const successApi: TelegramSendApi = {
      sendMessage: async () => {
        successfulCalls += 1;
        return { message_id: 500 + successfulCalls, date: 1_700_000_100 + successfulCalls, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 600, date: 1_700_000_200, chat: { id: 123456789 } }),
    };
    const quotaTool = createSendTool({
      store,
      api: successApi,
      context,
      stickerCapabilities: new Map(),
      maxSends: 6,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
    });
    for (let index = 0; index < 6; index += 1) {
      await quotaTool.execute(`quota-${index}`, { kind: "text", text: `message-${index}` });
    }
    await expect(quotaTool.execute("quota-6", { kind: "text", text: "seventh" })).rejects.toThrow("send limit");
    expect(successfulCalls).toBe(6);

    const secondReceived = new Date(received.getTime() + 20_000);
    ingestion.ingest(update(2, 11, "next"), secondReceived);
    const secondInvocation = processOne(scheduler, new Date(secondReceived.getTime() + 15_000));
    const secondContext = builder.build(secondInvocation, 200_000, 0);
    let unknownCalls = 0;
    const unknownApi: TelegramSendApi = {
      sendMessage: async () => {
        unknownCalls += 1;
        throw new HttpError("network failed", new Error("socket closed"));
      },
      sendSticker: async () => ({ message_id: 700, date: 1_700_000_300, chat: { id: 123456789 } }),
    };
    const unknownTool = createSendTool({
      store,
      api: unknownApi,
      context: secondContext,
      stickerCapabilities: new Map(),
      maxSends: 6,
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
    });
    await expect(unknownTool.execute("unknown-1", { kind: "text", text: "uncertain" })).rejects.toThrow("outcome is unknown");
    expect(unknownCalls).toBe(1);
    expect(store.db.query<{ state: string }, []>("SELECT state FROM telegram_sends WHERE id = (SELECT MAX(id) FROM telegram_sends)").get()?.state).toBe("outcome_unknown");
    store.close();
  });

});

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Update } from "grammy/types";
import { AgentRuntime } from "../src/agent-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { SqliteStore } from "../src/database.ts";
import type { ModelRegistry } from "../src/providers.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import type { TelegramSendApi } from "../src/send-tool.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { testConfigToml } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

test("a fresh Agent publishes only through send and audits model usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-agent-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await Bun.write(configPath, testConfigToml(directory));
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: "private", first_name: "Owner" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text: "hello",
    },
  };
  const received = new Date("2026-08-15T00:00:00.000Z");
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) throw new Error("Expected a due invocation");

  const faux = fauxProvider({
    provider: "agent",
    models: [{ id: "agent-model", input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send", { kind: "text", text: "published" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("private assistant text"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, mutableModels: models, agentModel: model, visionModel: model };
  let messageId = 500;
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    registry,
    telegramApi: api,
    bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: "completed", reason: "completed" });
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM telegram_sends WHERE state = 'success'").get()?.count).toBe(1n);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM messages WHERE sent_by_bot = 1").get()?.count).toBe(1n);
  const assistantTexts = store.db
    .query<{ text: string }, []>("SELECT text FROM agent_messages WHERE role = 'assistant' ORDER BY sequence_no")
    .all()
    .map((row) => row.text);
  expect(assistantTexts).toContain("private assistant text");
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM model_calls WHERE state = 'success'").get()?.count).toBe(2n);
  store.close();
});

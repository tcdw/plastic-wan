import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import sharp from "sharp";
import type { Update } from "grammy/types";
import { AgentRuntime } from "../src/agent-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { KeyedSemaphore } from "../src/concurrency.ts";
import { SqliteStore } from "../src/database.ts";
import { MediaService, type MediaDownloader } from "../src/media.ts";
import type { ModelRegistry } from "../src/providers.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import type { TelegramSendApi } from "../src/send-tool.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { testConfigToml, writeTestConfig } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

test("a fresh Agent publishes only through send and audits model usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-agent-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await writeTestConfig(directory, configPath);
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

test("passes Telegram photos directly to the multimodal agent and keeps stickers tool-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-agent-image-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, "fixture.png");
  await sharp({
    create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const received = new Date("2026-08-15T00:00:00.000Z");
  const update: Update = {
    update_id: 2,
    message: {
      message_id: 20,
      date: 1_700_000_000,
      chat: { id: 123456789, type: "private", first_name: "Owner" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      photo: [
        { file_id: "photo-small", file_unique_id: "photo-small-unique", width: 8, height: 4, file_size: 50 },
        { file_id: "photo-large", file_unique_id: "photo-large-unique", width: 16, height: 8, file_size: 100 },
      ],
      sticker: {
        file_id: "sticker-file",
        file_unique_id: "sticker-unique",
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: "regular",
      },
    },
  };
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) throw new Error("Expected a due invocation");

  const faux = fauxProvider({
    provider: "agent",
    models: [{ id: "agent-model", input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  faux.setResponses([(context) => {
    const user = context.messages[0];
    expect(user?.role).toBe("user");
    if (user?.role !== "user" || typeof user.content === "string") throw new Error("Expected multimodal user content");
    const images = user.content.filter((entry) => entry.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/jpeg");
    expect(user.content[0]).toMatchObject({ type: "text" });
    return fauxAssistantMessage("saw the photo");
  }]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, mutableModels: models, agentModel: model, visionModel: model };
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      expect(fileId).toBe("photo-large");
      await Bun.write(destination, Bun.file(fixturePath));
    },
  };
  const media = new MediaService({
    store,
    config: loaded.config,
    registry,
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 502, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    registry,
    telegramApi: api,
    bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
    directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: "completed", reason: "completed" });
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM media").get()?.count).toBe(2n);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image'").get()?.count).toBe(0n);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat'").get()?.count).toBe(0n);
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});
test("lets a text-only agent read a Telegram photo through read_image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-agent-fallback-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  const config = testConfigToml(directory).replace('input = ["text", "image"]', 'input = ["text"]');
  await writeTestConfig(directory, configPath, config);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, "fixture.png");
  await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const received = new Date("2026-08-15T00:00:00.000Z");
  ingestion.ingest({
    update_id: 3,
    message: {
      message_id: 30,
      date: 1_700_000_000,
      chat: { id: 123456789, type: "private", first_name: "Owner" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 16, height: 8, file_size: 100 }],
    },
  }, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) throw new Error("Expected a due invocation");

  const agentFaux = fauxProvider({
    provider: "agent",
    models: [{ id: "agent-model", input: ["text"], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  let photoRef: string | undefined;
  agentFaux.setResponses([
    (context) => {
      const content = context.messages[0]?.content;
      if (typeof content !== "string") {
        const text = content?.find((entry) => entry.type === "text")?.text ?? "";
        const match = /"image_ref":"([^"]+)"/.exec(text);
        photoRef = match?.[1];
      }
      if (photoRef === undefined) throw new Error("Text-only agent context omitted image_ref");
      return fauxAssistantMessage(fauxToolCall("read_image", { image_ref: photoRef }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("understood"),
  ]);
  const visionFaux = fauxProvider({
    provider: "vision",
    models: [{ id: "vision-model", input: ["text", "image"], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  visionFaux.setResponses([fauxAssistantMessage("A dark rectangle.")]);
  const models = createModels();
  models.setProvider(agentFaux.provider);
  models.setProvider(visionFaux.provider);
  const agentModel = agentFaux.getModel();
  const visionModel = visionFaux.getModel();
  const registry: ModelRegistry = { models, mutableModels: models, agentModel, visionModel };
  const media = new MediaService({
    store,
    config: loaded.config,
    registry,
    mediaClient: {
      download: async (fileId, destination, signal) => {
        signal.throwIfAborted();
        expect(fileId).toBe("photo-file");
        await Bun.write(destination, Bun.file(fixturePath));
      },
    },
    modelGate: new KeyedSemaphore(),
  });
  const runtime = new AgentRuntime({
    store,
    config: loaded.config,
    registry,
    telegramApi: {
      sendMessage: async () => ({ message_id: 601, date: 1_700_000_100, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 602, date: 1_700_000_100, chat: { id: 123456789 } }),
    },
    bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
    additionalTools: (context, _state, deadline) => [media.createReadImageTool(context, deadline)],
  });
  const outcome = await runtime.run(invocationId, new AbortController().signal);
  expect(outcome).toEqual({ state: "completed", reason: "completed" });
  expect(agentFaux.state.callCount).toBe(2);
  expect(visionFaux.state.callCount).toBe(1);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image' AND state = 'success'").get()?.count).toBe(1n);
  expect(store.db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat' AND state = 'success'").get()?.count).toBe(1n);
  store.close();
});

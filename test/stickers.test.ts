import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Update } from "grammy/types";
import sharp from "sharp";
import { loadConfig } from "../src/config.ts";
import { KeyedSemaphore } from "../src/concurrency.ts";
import { ContextBuilder } from "../src/context-builder.ts";
import { SqliteStore } from "../src/database.ts";
import { MediaService, type MediaDownloader } from "../src/media.ts";
import type { ModelRegistry } from "../src/providers.ts";
import { BucketScheduler } from "../src/scheduler.ts";
import { createSendTool, type TelegramSendApi } from "../src/send-tool.ts";
import { StickerService } from "../src/stickers.ts";
import { TelegramIngestion } from "../src/telegram-ingestion.ts";
import { testConfigToml } from "./helpers.ts";

const directories: string[] = [];

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

test("sync, representative-frame indexing, search, and sticker send share scoped capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-stickers-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  const toml = `${testConfigToml(directory)}
[[telegram.sticker_sets]]
alias = "cats"
name = "CatSet"
`;
  await Bun.write(configPath, toml);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, "sticker.webp");
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).webp().toFile(fixturePath);
  const faux = fauxProvider({
    provider: "vision",
    models: [{ id: "vision-model", input: ["text", "image"], contextWindow: 128_000, maxTokens: 8_192 }],
  });
  faux.setResponses([(context) => {
    expect(context.tools?.map((tool) => tool.name)).toEqual(["report_sticker_analysis"]);
    return fauxAssistantMessage(fauxToolCall("report_sticker_analysis", {
      description_zh: "一只委屈猫正在哭泣",
      emotion_zh: ["委屈", "难过"],
      action_zh: ["哭泣"],
      tags_zh: ["猫", "眼泪"],
      tags_en: ["cat", "crying"],
    }));
  }]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry: ModelRegistry = { models, mutableModels: models, agentModel: model, visionModel: model };
  const downloadedFileIds: string[] = [];
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      downloadedFileIds.push(fileId);
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
  const stickers = new StickerService({
    store,
    config: loaded.config,
    media,
    api: {
      getStickerSet: async () => ({
        name: "CatSet",
        title: "Cats",
        stickers: [{
          file_id: "sticker-file",
          file_unique_id: "sticker-unique",
          width: 64,
          height: 64,
          is_animated: false,
          is_video: false,
          emoji: "😭",
          thumbnail: { file_id: "thumb-file" },
        }],
      }),
    },
  });
  await stickers.sync();
  const stickerRow = store.db.query<{ id: bigint }, []>("SELECT id FROM stickers").get();
  if (stickerRow === null) throw new Error("Sticker sync did not create a row");
  const directAnalysis = await media.analyzeStickerForIndex(stickerRow.id, new AbortController().signal);
  expect(directAnalysis.description).toBe("一只委屈猫正在哭泣");
  expect(await stickers.runOne()).toBe(true);
  expect(downloadedFileIds).toEqual(["thumb-file"]);
  expect(store.db.query<{ state: string }, []>("SELECT index_state AS state FROM stickers").get()?.state).toBe("success");

  const ingestion = new TelegramIngestion(store, loaded.config, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: "private", first_name: "Owner" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text: "send a sticker",
    },
  };
  const received = new Date("2026-08-15T00:00:00.000Z");
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, async () => ({ state: "completed", reason: "done" }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) throw new Error("Expected a due invocation");
  const context = new ContextBuilder(store, loaded.config).build(invocationId, 200_000, 0);
  const capabilities = new Map<string, string>();
  const search = stickers.createSearchTool(context, capabilities);
  const result = await search.execute("search-1", { query: "委屈猫", set: "cats", limit: 5 });
  const text = result.content.find((entry) => entry.type === "text");
  if (text === undefined || text.type !== "text") throw new Error("Search returned no text result");
  const parsed: unknown = JSON.parse(text.text);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("Search result shape is invalid");
  const first = parsed[0];
  if (typeof first !== "object" || first === null || !("sticker_ref" in first) || typeof first.sticker_ref !== "string") {
    throw new Error("Search result omitted sticker_ref");
  }
  let sentSticker: string | undefined;
  const api: TelegramSendApi = {
    sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async (_chatId, sticker) => {
      sentSticker = sticker;
      return { message_id: 502, date: 1_700_000_101, chat: { id: 123456789 } };
    },
  };
  const send = createSendTool({
    store,
    api,
    context,
    stickerCapabilities: capabilities,
    maxSends: 6,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: "Plastic Wan", username: "plasticwan" },
  });
  await send.execute("send-1", { kind: "sticker", sticker_ref: first.sticker_ref });
  expect(sentSticker).toBe("sticker-file");
  store.close();
});

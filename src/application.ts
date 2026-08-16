import { Bot } from "grammy";
import { AdminServer } from "./admin/server.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { assertConfigPermissions, loadConfig } from "./config.ts";
import { KeyedSemaphore } from "./concurrency.ts";
import type { InvocationContext } from "./context-builder.ts";
import { ServeLock, SqliteStore } from "./database.ts";
import { SecretStore } from "./secrets.ts";
import { MediaService, TelegramMediaClient } from "./media.ts";
import { McpManager } from "./mcp.ts";
import { createModelRegistry } from "./providers.ts";
import { BucketScheduler } from "./scheduler.ts";
import { StickerService } from "./stickers.ts";
import { TelegramIngestion } from "./telegram-ingestion.ts";

const ALLOWED_UPDATES = ["message", "edited_message", "my_chat_member"] as const;

export async function serve(configPath: string): Promise<void> {
  const loaded = await loadConfig(configPath);
  await assertConfigPermissions(loaded.configPath);
  const secrets = new SecretStore();
  let lock: ServeLock | undefined;
  let store: SqliteStore | undefined;
  let bot: Bot | undefined;
  let scheduler: BucketScheduler | undefined;
  let stickers: StickerService | undefined;
  let mcp: McpManager | undefined;
  let admin: AdminServer | undefined;
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent("shutdown_requested");
    // Unblock bot.start() so the finally block below runs the full cleanup.
    // grammY's stop() also fires a best-effort offset-confirming getUpdates;
    // swallow its rejection so it can never become an unhandled promise
    // rejection and crash the process mid-shutdown (Bun exits non-zero on
    // unhandled rejections).
    void bot?.stop().catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    const token = await secrets.resolve(loaded.config.telegram.token);
    lock = await ServeLock.acquire(loaded.config.data_dir);
    store = await SqliteStore.open(loaded.config);
    bot = new Bot(token);
    const registry = await createModelRegistry(loaded.config, secrets);
    const me = await bot.api.getMe();
    const initialized = store.db
      .query<{ value: string }, []>("SELECT value FROM app_state WHERE key = 'telegram_initialized'")
      .get() !== null;
    await bot.api.deleteWebhook({ drop_pending_updates: !initialized });
    if (!initialized) {
      store.db
        .query("INSERT INTO app_state(key, value, updated_at) VALUES ('telegram_initialized', '1', ?)")
        .run(new Date().toISOString());
    }
    const ingestion = new TelegramIngestion(store, loaded.config, me);
    const modelGate = new KeyedSemaphore();
    const media = new MediaService({
      store,
      config: loaded.config,
      registry,
      mediaClient: new TelegramMediaClient(bot.api, token),
      modelGate,
    });
    const stickerService = new StickerService({ store, config: loaded.config, api: bot.api, media });
    stickers = stickerService;
    await stickerService.sync();
    stickerService.start();
    const mcpManager = new McpManager(store, loaded.config, secrets);
    mcp = mcpManager;
    const runtime = new AgentRuntime({
      store,
      config: loaded.config,
      registry,
      telegramApi: bot.api,
      bot: {
        id: BigInt(me.id),
        displayName: [me.first_name, me.last_name].filter((part) => part !== undefined).join(" "),
        username: me.username ?? null,
      },
      modelGate,
      additionalTools: (context, state, deadline) => [
        media.createReadImageTool(context, deadline),
        stickerService.createSearchTool(context, state.stickerCapabilities),
        ...mcpManager.createTools(context, deadline),
      ],
    });
    const startedScheduler = new BucketScheduler(store, loaded.config, loaded.hash, (invocationId, signal) => runtime.run(invocationId, signal));
    scheduler = startedScheduler;
    const preview: InvocationContext = {
      invocationId: 0n,
      conversationId: 0n,
      chatId: 0n,
      threadId: 0n,
      systemPrompt: "",
      userPrompt: "",
      imageCapabilities: new Map(),
      visibleReplyMessageIds: new Set(),
      omittedNewMessages: 0,
    };
    mcpManager.setRegistryValidator((mcpTools) => runtime.validateAdditionalTools(preview, [
      media.createReadImageTool(preview, Number.MAX_SAFE_INTEGER),
      stickerService.createSearchTool(preview, new Map()),
      ...mcpTools,
    ]));
    await mcpManager.start();
    startedScheduler.start();
    if (loaded.config.admin?.enabled === true) {
      const adminServer = new AdminServer({ store, config: loaded.config });
      admin = adminServer;
      const listening = adminServer.start();
      logEvent("admin_started", { host: listening.hostname, port: listening.port });
    }
    bot.use(async (context) => {
      ingestion.ingest(context.update);
      startedScheduler.wake();
    });
    logEvent("serve_started", { bot_id: String(me.id), config_hash: loaded.hash });
    await bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(secrets.redact(message));
  } finally {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    await admin?.stop();
    await scheduler?.stop(30_000);
    await stickers?.stop();
    await mcp?.stop();
    store?.close();
    await lock?.release();
  }
}

export function logEvent(event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

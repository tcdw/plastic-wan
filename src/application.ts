import { Bot, type Context } from 'grammy';
import { seedConfigAdmins } from './admin/admins.ts';
import { AdminServer } from './admin/server.ts';
import { AgentRuntime } from './agent-runtime.ts';
import { BOT_COMMANDS, BotCommandService, type ParsedCommand, registerBotCommands } from './bot-commands.ts';
import { KeyedSemaphore } from './concurrency.ts';
import { assertConfigPermissions, loadConfig } from './config.ts';
import type { InvocationContext } from './context-builder.ts';
import { ServeLock, SqliteStore } from './database.ts';
import { McpManager } from './mcp.ts';
import { MediaService, TelegramMediaClient } from './media.ts';
import { createMemoryTools, MemoryStore } from './memory.ts';
import { AgentModelSwitcher } from './model-switch.ts';
import { createModelRegistry } from './providers.ts';
import { BucketScheduler } from './scheduler.ts';
import { SecretStore } from './secrets.ts';
import { runStartupCatchUp } from './startup-catch-up.ts';
import { StickerService } from './stickers.ts';
import { TelegramIngestion } from './telegram-ingestion.ts';

const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'] as const;

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
  let startupCatchUpController: AbortController | undefined;
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('shutdown_requested');
    startupCatchUpController?.abort(new Error('shutdown'));
    // Unblock bot.start() so the finally block below runs the full cleanup.
    // grammY's stop() also fires a best-effort offset-confirming getUpdates;
    // swallow its rejection so it can never become an unhandled promise
    // rejection and crash the process mid-shutdown (Bun exits non-zero on
    // unhandled rejections).
    void bot?.stop().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    const token = await secrets.resolve(loaded.config.telegram.token);
    lock = await ServeLock.acquire(loaded.config.data_dir);
    store = await SqliteStore.open(loaded.config);
    seedConfigAdmins(store.db, loaded.config.telegram.admins ?? []);
    bot = new Bot(token);
    const registry = await createModelRegistry(loaded.config, secrets);
    const modelSwitcher = new AgentModelSwitcher(loaded.config, registry.models);
    const me = await bot.api.getMe();
    try {
      await registerBotCommands(bot.api);
      logEvent('commands_registered', { commands: BOT_COMMANDS.map((entry) => entry.command).join(',') });
    } catch (error) {
      // Registration is convenience only: command parsing works without the
      // Telegram menu, so a failed setMyCommands must not block startup.
      logEvent('command_registration_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const initialized =
      store.db.query<{ value: string }, []>("SELECT value FROM app_state WHERE key = 'telegram_initialized'").get() !==
      null;
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
    const memoryStore = new MemoryStore(store.db);
    const runtime = new AgentRuntime({
      store,
      config: loaded.config,
      registry,
      modelSwitcher,
      telegramApi: bot.api,
      bot: {
        id: BigInt(me.id),
        displayName: [me.first_name, me.last_name].filter((part) => part !== undefined).join(' '),
        username: me.username ?? null,
      },
      modelGate,
      directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
      additionalTools: (context, state, deadline) => [
        media.createReadImageTool(context, deadline),
        stickerService.createSearchTool(context, state.stickerCapabilities),
        ...createMemoryTools(memoryStore, context),
        ...mcpManager.createTools(context, deadline),
      ],
    });
    const startedScheduler = new BucketScheduler(store, loaded.config, loaded.hash, (invocationId, signal) =>
      runtime.run(invocationId, signal),
    );
    scheduler = startedScheduler;
    const commands = new BotCommandService(store, loaded.config, startedScheduler, modelSwitcher);
    const preview: InvocationContext = {
      invocationId: 0n,
      conversationId: 0n,
      chatId: 0n,
      threadId: 0n,
      systemPrompt: '',
      userPrompt: '',
      imageCapabilities: new Map(),
      directImages: [],
      replyTargets: new Map(),
      omittedNewMessages: 0,
    };
    mcpManager.setRegistryValidator((mcpTools) =>
      runtime.validateAdditionalTools(preview, [
        media.createReadImageTool(preview, Number.MAX_SAFE_INTEGER),
        stickerService.createSearchTool(preview, new Map()),
        ...createMemoryTools(memoryStore, preview),
        ...mcpTools,
      ]),
    );
    const catchUpController = new AbortController();
    startupCatchUpController = catchUpController;
    const catchUp = await runStartupCatchUp({
      api: bot.api,
      store,
      ingestion,
      scheduler: startedScheduler,
      allowedUpdates: ALLOWED_UPDATES,
      signal: catchUpController.signal,
    });
    startupCatchUpController = undefined;
    logEvent('startup_catch_up_completed', {
      updates: catchUp.updates,
      stored_messages: catchUp.storedMessages,
      invocations: catchUp.invocationIds.length,
    });
    await mcpManager.start();
    startedScheduler.start();
    if (loaded.config.admin?.enabled === true) {
      const adminServer = new AdminServer({ store, config: loaded.config, scheduler: startedScheduler, modelSwitcher });
      admin = adminServer;
      const listening = adminServer.start();
      logEvent('admin_started', { host: listening.hostname, port: listening.port });
    }
    bot.use(async (context) => {
      const result = ingestion.ingest(context.update);
      if (result.command !== undefined) {
        await replyToCommand(context, commands, result.command);
      }
      startedScheduler.wake();
    });
    logEvent('serve_started', { bot_id: String(me.id), config_hash: loaded.hash });
    await bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(secrets.redact(message));
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
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

async function replyToCommand(context: Context, commands: BotCommandService, command: ParsedCommand): Promise<void> {
  const message = context.update.message;
  if (message === undefined) return;
  const chatId = message.chat.id;
  const sender =
    message.from === undefined
      ? null
      : {
          id: BigInt(message.from.id),
          name: [message.from.first_name, message.from.last_name].filter((part) => part !== undefined).join(' '),
          username: message.from.username ?? null,
        };
  let text: string;
  try {
    text = commands.run(command, BigInt(chatId), sender);
  } catch (error) {
    logEvent('command_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    await context.api.sendMessage(String(chatId), text, {
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      reply_parameters: { message_id: message.message_id },
    });
    logEvent('command_reply_sent', { command: command.name, chat_id: String(chatId) });
  } catch (error) {
    logEvent('command_reply_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

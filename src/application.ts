import { eq } from 'drizzle-orm';
import { Bot, type Context } from 'grammy';
import { seedConfigAdmins } from './store/admins.ts';
import { AdminServer } from './ingress/admin/server.ts';
import { AgentRuntime, type AdditionalToolFactory } from './orchestration/agent-runtime.ts';
import {
  createAlarmTool,
  createDeleteAlarmTool,
  createListAlarmTool,
  type AgentMessageRecorder,
} from './capabilities/alarm.ts';
import {
  BOT_COMMANDS,
  BotCommandService,
  type ParsedCommand,
  registerBotCommands,
} from './orchestration/bot-commands.ts';
import { KeyedSemaphore } from './platform/concurrency.ts';
import { assertConfigPermissions, loadConfig } from './platform/config.ts';
import { ServeLock, SqliteStore } from './store/database.ts';
import { previewContext } from './platform/invocation-context.ts';
import { McpManager } from './capabilities/mcp.ts';
import { TelegramMediaClient } from './capabilities/media/media-download.ts';
import { MediaService } from './capabilities/media/media.ts';
import { createMemoryTools, MemoryStore } from './context/memory.ts';
import { AgentModelSwitcher } from './platform/model-switch.ts';
import { createModelRegistry } from './platform/providers.ts';
import { BucketScheduler } from './orchestration/scheduler.ts';
import { SecretStore } from './platform/secrets.ts';
import { runStartupCatchUp } from './startup-catch-up.ts';
import { appState } from './store/schema.ts';
import { StickerService } from './capabilities/stickers.ts';
import { TelegramIngestion } from './ingress/telegram-ingestion.ts';
import { createWebFetchTool } from './capabilities/web-fetch.ts';

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
    if (shuttingDown) {
      return;
    }
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
    const webFetchStore = store;
    seedConfigAdmins(store.orm, loaded.config.telegram.admins ?? []);
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
      store.orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, 'telegram_initialized'))
        .get() !== undefined;
    await bot.api.deleteWebhook({ drop_pending_updates: !initialized });
    if (!initialized) {
      store.orm
        .insert(appState)
        .values({ key: 'telegram_initialized', value: '1', updatedAt: new Date().toISOString() })
        .run();
    }
    const ingestion = new TelegramIngestion(store, loaded.config, me);
    const modelGate = new KeyedSemaphore();
    const media = new MediaService({
      store,
      config: loaded.config,
      secrets,
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
    const memoryStore = new MemoryStore(store.orm);
    let runtime: AgentRuntime;
    const alarmToolRuntime: AgentMessageRecorder = {
      recordAgentMessage(invocationId, role, text) {
        return runtime.recordAgentMessage(invocationId, role, text);
      },
    };
    const additionalTools: AdditionalToolFactory = (context, state, deadline) => [
      media.createReadImageTool(context, deadline),
      stickerService.createSearchTool(context, state.stickerCapabilities),
      ...createMemoryTools(memoryStore, context),
      createWebFetchTool({ store: webFetchStore, context, invocationDeadline: deadline }),
      createAlarmTool({ store: webFetchStore, context }),
      createListAlarmTool({ store: webFetchStore, context, runtime: alarmToolRuntime }),
      createDeleteAlarmTool({ store: webFetchStore, context }),
      ...mcpManager.createTools(context, deadline),
    ];
    runtime = new AgentRuntime({
      store,
      config: loaded.config,
      secrets,
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
      additionalTools,
    });
    const startedScheduler = new BucketScheduler(store, loaded.config, loaded.hash, (invocationId, signal) =>
      runtime.run(invocationId, signal),
    );
    scheduler = startedScheduler;
    const commands = new BotCommandService(store, loaded.config, startedScheduler, modelSwitcher);
    const preview = previewContext();
    mcpManager.setRegistryValidator((mcpTools) =>
      runtime.validateAdditionalTools(preview, [
        media.createReadImageTool(preview, Number.MAX_SAFE_INTEGER),
        stickerService.createSearchTool(preview, new Map()),
        ...createMemoryTools(memoryStore, preview),
        createWebFetchTool({ store: webFetchStore, context: preview, invocationDeadline: Number.MAX_SAFE_INTEGER }),
        createAlarmTool({ store: webFetchStore, context: preview }),
        createListAlarmTool({
          store: webFetchStore,
          context: preview,
          runtime: alarmToolRuntime,
        }),
        createDeleteAlarmTool({ store: webFetchStore, context: preview }),
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
  if (message === undefined) {
    return;
  }
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

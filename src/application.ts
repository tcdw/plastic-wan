import { eq } from 'drizzle-orm';
import { Bot, type Context } from 'grammy';
import { seedConfigAdmins } from './store/admins.ts';
import { AdminServer } from './ingress/admin/server.ts';
import { AgentRuntime, type CapabilityToolFactory, type ToolFactory } from './orchestration/agent-runtime.ts';
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
import { ConfigReloader } from './platform/config-reload.ts';
import { ServeLock, SqliteStore } from './store/database.ts';
import { previewContext, unavailableCapabilities } from './platform/invocation-context.ts';
import { McpManager } from './capabilities/mcp.ts';
import { TelegramMediaClient } from './capabilities/media/media-download.ts';
import { MediaService } from './capabilities/media/media.ts';
import { createMemoryTools, MemoryStore } from './context/memory.ts';
import { AgentModelSwitcher } from './platform/model-switch.ts';
import { buildModelRegistry } from './platform/providers.ts';
import { RuntimeConfigurationStore } from './platform/runtime-config.ts';
import { BucketScheduler } from './orchestration/scheduler.ts';
import { ConversationRuntime } from './orchestration/conversation-runtime.ts';
import { keyJarPath } from './platform/key-jar.ts';
import { SecretStore } from './platform/secrets.ts';
import { runStartupCatchUp } from './startup-catch-up.ts';
import { appState } from './store/schema.ts';
import { StickerService } from './capabilities/stickers.ts';
import { TelegramIngestion } from './ingress/telegram-ingestion.ts';
import { capability } from './capabilities/execute-tool.ts';
import { createWebFetchTool } from './capabilities/web-fetch.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, SystemResources } from './platform/system-resources.ts';

const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'] as const;

/**
 * Exit code of a panel-requested restart. `EX_TEMPFAIL` marks an intentional
 * stop that a supervisor should bring back, and stays distinguishable from a
 * crash in logs and container restart policies.
 */
export const RESTART_EXIT_CODE = 75;

export async function serve(configPath: string): Promise<void> {
  const loaded = await loadConfig(configPath);
  await assertConfigPermissions(loaded.configPath);
  const secrets = new SecretStore(keyJarPath(loaded.configPath));
  let lock: ServeLock | undefined;
  let store: SqliteStore | undefined;
  let bot: Bot | undefined;
  let scheduler: BucketScheduler | undefined;
  let stickers: StickerService | undefined;
  let mcp: McpManager | undefined;
  let admin: AdminServer | undefined;
  let startupCatchUpController: AbortController | undefined;
  let shuttingDown = false;
  let restartRequested = false;
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
    // rejection and crash the process mid-shutdown.
    void bot?.stop().catch(() => undefined);
  };
  /**
   * The Admin Panel's restart: the same graceful shutdown as a signal, but the
   * process leaves with `RESTART_EXIT_CODE` so the supervisor starts it again.
   *
   * Shutdown reaches `admin.stop()` only through the `finally` block below,
   * after `bot.stop()` has unblocked `bot.start()`, so the panel's 202 is long
   * gone by the time the Admin server destroys its connections. Anything that
   * stops the Admin server earlier would cut that response off.
   */
  const requestRestart = (): void => {
    if (restartRequested || shuttingDown) {
      return;
    }
    restartRequested = true;
    logEvent('restart_requested');
    shutdown();
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
    // The registry is built once here and republished by every reload; the
    // configuration and its models always travel together.
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
    const modelSwitcher = new AgentModelSwitcher(configStore);
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
    const ingestion = new TelegramIngestion(store, configStore, me);
    const modelGate = new KeyedSemaphore();
    const media = new MediaService({
      store,
      configStore,
      secrets,
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
    const systemResources = await SystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR);
    logEvent('system_skills_loaded', { skills: systemResources.skills.map((skill) => skill.name).join(',') });
    const conversationRuntime = new ConversationRuntime({
      agentCacheSize: loaded.config.agent.context.agent_cache_size,
    });
    let runtime: AgentRuntime;
    const alarmToolRuntime: AgentMessageRecorder = {
      recordAgentMessage(invocationId, role, text) {
        return runtime.recordAgentMessage(invocationId, role, text);
      },
    };
    // Runtime-internal capabilities: dispatched through the execute primitive.
    const capabilityTools: CapabilityToolFactory = (context, deadline, capabilities) => [
      capability(media.createReadImageTool(context, capabilities, deadline), false),
      capability(stickerService.createSearchTool(context, capabilities), false),
      ...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true)),
      capability(createWebFetchTool({ store: webFetchStore, context, invocationDeadline: deadline }), false),
      capability(createAlarmTool({ store: webFetchStore, context }), true),
      capability(createListAlarmTool({ store: webFetchStore, context, runtime: alarmToolRuntime }), false),
      capability(createDeleteAlarmTool({ store: webFetchStore, context }), true),
    ];
    // Directly exposed non-primitive tools: allowlisted MCP tools only.
    const additionalTools: ToolFactory = (context, deadline) => [...mcpManager.createTools(context, deadline)];
    runtime = new AgentRuntime({
      store,
      configStore,
      secrets,
      telegramApi: bot.api,
      bot: {
        id: BigInt(me.id),
        displayName: [me.first_name, me.last_name].filter((part) => part !== undefined).join(' '),
        username: me.username ?? null,
      },
      modelGate,
      systemResources,
      directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
      capabilityTools,
      additionalTools,
      conversationRuntime,
    });
    const startedScheduler = new BucketScheduler(
      store,
      configStore,
      (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
      conversationRuntime,
    );
    scheduler = startedScheduler;
    const preview = previewContext();
    const configReloader = new ConfigReloader({
      loaded,
      store: configStore,
      modelSwitcher,
      secrets,
      validateAgentModel: (model) =>
        runtime.validateAdditionalTools(
          preview,
          additionalTools(preview, Number.MAX_SAFE_INTEGER, unavailableCapabilities()),
          model,
        ),
      // A raised max_concurrency only takes effect on the next scheduler tick.
      onPublished: () => startedScheduler.wake(),
    });
    const commands = new BotCommandService(
      store,
      configStore,
      startedScheduler,
      modelSwitcher,
      conversationRuntime,
      configReloader,
    );
    mcpManager.setRegistryValidator((mcpTools) =>
      runtime.validateAdditionalTools(preview, mcpTools, modelSwitcher.model()),
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
      const adminServer = new AdminServer({
        store,
        configStore,
        scheduler: startedScheduler,
        modelSwitcher,
        configReloader,
        secrets,
        requestRestart,
      });
      admin = adminServer;
      const listening = await adminServer.start();
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
  if (restartRequested) {
    logEvent('restart_exit', { code: RESTART_EXIT_CODE });
    // Leaving through the exit code lets pending output flush; the unref'd timer
    // only fires if some handle outlives the cleanup, so the supervisor is not
    // left waiting on a process that cannot finish.
    process.exitCode = RESTART_EXIT_CODE;
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 1_000).unref();
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
    text = await commands.run(command, BigInt(chatId), sender);
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

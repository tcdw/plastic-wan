import type { Message } from 'grammy/types';
import { and, eq, sql } from 'drizzle-orm';
import { isBotAdmin } from '../store/admins.ts';
import type { RawConfig } from '../platform/config.ts';
import { isWithinActiveWindows } from '../platform/participation.ts';
import { type SqliteStore, isChatPaused, resolveChatConfig } from '../store/database.ts';
import { ParticipationRegistry, chatAttentionUntil } from '../store/participation.ts';
import type { AgentModelOption, AgentModelSwitcher } from '../platform/model-switch.ts';
import type { BucketScheduler } from './scheduler.ts';
import type { ConversationRuntime } from './conversation-runtime.ts';
import { ConversationContextStore, listConversationContexts } from '../context/context-store.ts';
import { readDailyTokenBudget } from '../store/sleep.ts';
import { botAdmins, chatContextCutoffs, chatPause, chats, conversations, dailyUsage } from '../store/schema.ts';

export interface ParsedCommand {
  readonly name: 'pause' | 'resume' | 'status' | 'model' | 'cut_topic';
  readonly argument?: string;
  /** Telegram message ID of the command message itself; used by cut_topic. */
  readonly messageId?: bigint;
  /**
   * Forum topic the command was sent in; the Conversation Context to cut. Absent
   * for every chat that has one Conversation, which is the `message_thread_id = 0`
   * case — see `conversationThreadId`.
   */
  readonly threadId?: bigint;
}

/**
 * The Conversation a Telegram message belongs to, as a thread id.
 *
 * Telegram sets `message_thread_id` on more than forum topics: a private chat
 * with thread mode enabled carries one on its messages, and so does a reply
 * inside a plain supergroup (the id of the thread's root message). Ingestion
 * has always ignored every one of those and filed the message under thread 0,
 * so this rule is the only one that agrees with `conversations`.
 *
 * `parseBotCommand` used the raw field instead. `/cut_topic` carrying any such
 * id therefore looked for a Conversation with a thread id that ingestion never
 * wrote, found nothing, and cleared no Context — while still writing the
 * per-Chat cutoff and replying that the Context was cleared. That is the exact
 * failure the cut is supposed to prevent: the rendered history is truncated and
 * the model keeps the whole transcript.
 */
export function conversationThreadId(message: Message | undefined): bigint {
  return message?.chat.type === 'supergroup' &&
    message.chat.is_forum === true &&
    message.is_topic_message === true &&
    message.message_thread_id !== undefined
    ? BigInt(message.message_thread_id)
    : 0n;
}

export interface CommandSender {
  readonly id: bigint;
  readonly name: string;
  readonly username: string | null;
}

const COMMAND_NAMES = new Set<ParsedCommand['name']>(['pause', 'resume', 'status', 'model', 'cut_topic']);
const DENIED_REPLY = '该命令仅对本 Bot 的管理员可用。';
const MODEL_PAGE_SIZE = 20;

export interface BotCommandRegistration {
  readonly command: string;
  readonly description: string;
}

// Single source of truth for the Telegram command menu: everything registered
// via setMyCommands must also parse in parseBotCommand.
export const BOT_COMMANDS: readonly BotCommandRegistration[] = [
  { command: 'pause', description: '暂停本群互动（仅管理员）' },
  { command: 'resume', description: '恢复本群互动（仅管理员）' },
  { command: 'status', description: '查看当前模型、thinking effort 与本日 token 用量' },
  { command: 'model', description: '查看或切换 agent 模型（仅管理员）' },
  { command: 'cut_topic', description: '切掉此消息及更早的历史，仅对新会话生效（仅管理员）' },
];

export interface CommandRegistrationApi {
  setMyCommands(commands: readonly BotCommandRegistration[]): Promise<unknown>;
}

export async function registerBotCommands(api: CommandRegistrationApi): Promise<void> {
  for (const entry of BOT_COMMANDS) {
    if (!COMMAND_NAMES.has(entry.command as ParsedCommand['name'])) {
      throw new Error(`Command not handled by parseBotCommand: ${entry.command}`);
    }
  }
  await api.setMyCommands(BOT_COMMANDS);
}

// Telegram command tokens are case-insensitive and may carry an explicit
// bot mention (`/pause@PlasticWanBot`); the mention must match this bot.
export function parseBotCommand(message: Message, botUsername: string | null): ParsedCommand | null {
  if (message.text === undefined || message.from?.is_bot === true) {
    return null;
  }
  const entity = message.entities?.find((entry) => entry.type === 'bot_command' && entry.offset === 0);
  if (entity === undefined) {
    return null;
  }
  const token = message.text.slice(0, entity.length);
  const separator = token.indexOf('@');
  const name = (separator === -1 ? token.slice(1) : token.slice(1, separator)).toLowerCase();
  const mention = separator === -1 ? null : token.slice(separator + 1).toLowerCase();
  if (mention !== null && mention !== botUsername?.toLowerCase()) {
    return null;
  }
  if (!COMMAND_NAMES.has(name as ParsedCommand['name'])) {
    return null;
  }
  const base: ParsedCommand =
    name !== 'model'
      ? { name: name as ParsedCommand['name'] }
      : (() => {
          const argument = message.text.slice(entity.offset + entity.length).trim();
          return argument.length === 0 ? { name: 'model' } : { name: 'model', argument };
        })();
  const threadId = conversationThreadId(message);
  const scoped: ParsedCommand = {
    ...base,
    ...(message.message_id === undefined ? {} : { messageId: BigInt(message.message_id) }),
    ...(threadId === 0n ? {} : { threadId }),
  };
  return scoped;
}

// Chat-scoped control commands. State changes and replies are deterministic
// bot responses, not model output, so they bypass the agent send tool.
export class BotCommandService {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #scheduler: BucketScheduler;
  readonly #modelSwitcher: AgentModelSwitcher | undefined;
  readonly #participation: ParticipationRegistry;
  readonly #contexts: ConversationContextStore;
  readonly #conversationRuntime: ConversationRuntime | undefined;

  constructor(
    store: SqliteStore,
    config: RawConfig,
    scheduler: BucketScheduler,
    modelSwitcher?: AgentModelSwitcher,
    conversationRuntime?: ConversationRuntime,
  ) {
    this.#store = store;
    this.#config = config;
    this.#scheduler = scheduler;
    this.#modelSwitcher = modelSwitcher;
    this.#participation = new ParticipationRegistry(config);
    this.#contexts = new ConversationContextStore(store);
    this.#conversationRuntime = conversationRuntime;
  }

  run(command: ParsedCommand, telegramChatId: bigint, sender: CommandSender | null, now = new Date()): string {
    switch (command.name) {
      case 'pause':
        return this.#adminGate(sender) ? this.#pause(telegramChatId, now) : DENIED_REPLY;
      case 'resume':
        return this.#adminGate(sender) ? this.#resume(telegramChatId) : DENIED_REPLY;
      case 'status':
        return this.#status(telegramChatId, now);
      case 'model':
        return this.#adminGate(sender) ? this.#modelSwitch(command.argument) : DENIED_REPLY;
      case 'cut_topic':
        return this.#adminGate(sender)
          ? this.#cutTopic(telegramChatId, command.messageId, command.threadId, now)
          : DENIED_REPLY;
    }
  }

  #adminGate(sender: CommandSender | null): boolean {
    if (sender === null || !isBotAdmin(this.#store.orm, sender.id)) {
      return false;
    }
    const timestamp = new Date().toISOString();
    // Keep the panel list readable: refresh the display name of acting admins.
    this.#store.orm
      .insert(botAdmins)
      .values({
        telegramUserId: sender.id,
        displayName: sender.name,
        addedBy: 'telegram',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({ target: botAdmins.telegramUserId, set: { displayName: sender.name, updatedAt: timestamp } })
      .run();
    return true;
  }

  #pause(telegramChatId: bigint, now: Date): string {
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) {
      throw new Error(`Chat ${telegramChatId} has no stored row`);
    }
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#store.orm
        .insert(chatPause)
        .values({ chatId, pausedAt: timestamp })
        .onConflictDoUpdate({ target: chatPause.chatId, set: { pausedAt: timestamp } })
        .run();
      this.#store.orm.run(
        sql`UPDATE buckets SET state = 'expired', error_code = 'chat_paused', finished_at = ${timestamp}, updated_at = ${timestamp}
           WHERE state IN ('collecting', 'queued') AND conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})`,
      );
      // A claimed alarm whose queued invocation is being aborted must close as
      // cancelled/chat_paused rather than stay `firing` until a later restart.
      this.#store.orm.run(
        sql`UPDATE alarms SET state = 'cancelled', cancelled_at = ${timestamp}, cancel_reason = 'chat_paused', admin_cancelled = 0, updated_at = ${timestamp}
           WHERE state = 'firing' AND invocation_id IN (
             SELECT i.id FROM invocations i
             JOIN conversations v ON v.id = i.conversation_id
             WHERE i.state = 'queued' AND v.chat_id = ${chatId}
           )`,
      );
      this.#store.orm.run(
        sql`UPDATE invocations SET state = 'aborted', completion_reason = 'chat_paused', finished_at = ${timestamp}
           WHERE state = 'queued' AND conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})`,
      );
    });
    this.#scheduler.pauseChat(chatId);
    return '已暂停本群互动，发送 /resume 可恢复。';
  }

  #resume(telegramChatId: bigint): string {
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) {
      throw new Error(`Chat ${telegramChatId} has no stored row`);
    }
    this.#store.orm.delete(chatPause).where(eq(chatPause.chatId, chatId)).run();
    return '已恢复本群互动。';
  }

  // Cuts agent-session history at the command message itself: the cutoff row
  // stores the command's Telegram message ID, so the command and everything
  // before it drop out of future invocations. Only the new cutoff matters, so
  // replying is safe even when this chat has never triggered the agent.
  //
  // The continuous Conversation Context is cleared in the same step. Without
  // that, the command would only trim the rendered history while the model kept
  // seeing everything through its retained transcript.
  #cutTopic(telegramChatId: bigint, messageId: bigint | undefined, threadId: bigint | undefined, now: Date): string {
    if (messageId === undefined) {
      throw new Error(`cut_topic command is missing its Telegram message ID`);
    }
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) {
      throw new Error(`Chat ${telegramChatId} has no stored row`);
    }
    const timestamp = now.toISOString();
    this.#store.orm
      .insert(chatContextCutoffs)
      .values({ chatId, telegramMessageId: messageId, createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: chatContextCutoffs.chatId,
        set: { telegramMessageId: messageId, updatedAt: timestamp },
      })
      .run();
    const conversationId = this.#store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId ?? 0n)))
      .get()?.id;
    if (conversationId !== undefined) {
      // Interrupt before clearing. A run in flight holds the pre-cut transcript and
      // a header snapshot taken at its start, so it would keep answering from the
      // history just cut and could write a lower `head_seq` back over the cut.
      this.#scheduler.abortConversation(conversationId);
      const header = this.#contexts.header(conversationId);
      if (header !== undefined) {
        this.#contexts.clear(header, now);
        console.log(
          JSON.stringify({
            event: 'context_cleared',
            conversation_id: conversationId.toString(),
            chat_id: telegramChatId.toString(),
            head_seq: header.headSeq.toString(),
            at: timestamp,
          }),
        );
      }
      // Drop the in-memory transcript too; the canonical history is the truth.
      this.#conversationRuntime?.forget(conversationId);
    }
    return '已切掉此消息及更早的历史，并清空该话题的连续 Context。';
  }

  #modelSwitch(argument: string | undefined): string {
    const switcher = this.#modelSwitcher;
    if (switcher === undefined) {
      return '运行时模型切换不可用。';
    }
    if (argument === undefined) {
      return this.#modelMenu(switcher, 1, switcher.list());
    }
    if (argument === 'reset') {
      const current = switcher.reset();
      return `已恢复 config.jsonc 默认模型: ${current.provider} / ${current.model}。`;
    }
    const options = switcher.list();
    const pageMatch = /^page\s+(\d+)$/.exec(argument);
    if (pageMatch !== null) {
      const page = Number.parseInt(pageMatch[1] ?? '', 10);
      const pageCount = Math.max(1, Math.ceil(options.length / MODEL_PAGE_SIZE));
      if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
        return `无效页码。${this.#modelMenu(switcher, 1, options)}`;
      }
      return this.#modelMenu(switcher, page, options);
    }
    const index = /^\d+$/.test(argument) ? Number.parseInt(argument, 10) : NaN;
    if (!Number.isInteger(index) || index < 1 || index > options.length) {
      return `无效序号。${this.#modelMenu(switcher, 1, options)}`;
    }
    const option = options[index - 1];
    if (option === undefined) {
      return `无效序号。${this.#modelMenu(switcher, 1, options)}`;
    }
    const current = switcher.switch(option.provider, option.model);
    return `已切换: ${current.provider} / ${current.model}，将在下一次 agent session 生效。`;
  }

  #modelMenu(switcher: AgentModelSwitcher, page: number, options: readonly AgentModelOption[]): string {
    const current = switcher.current();
    const pageCount = Math.max(1, Math.ceil(options.length / MODEL_PAGE_SIZE));
    const start = (page - 1) * MODEL_PAGE_SIZE;
    const end = Math.min(start + MODEL_PAGE_SIZE, options.length);
    const lines = [
      `当前模型: ${current.provider} / ${current.model}`,
      `可用模型（第 ${page}/${pageCount} 页，共 ${options.length} 条）:`,
    ];
    for (let index = start; index < end; index += 1) {
      const option = options[index];
      if (option === undefined) {
        break;
      }
      lines.push(`${index + 1}. ${option.provider} / ${option.model}（${option.name}）`);
    }
    lines.push('使用 /model 序号 切换，/model page 页码 翻页，/model reset 恢复默认');
    return lines.join('\n');
  }

  #status(telegramChatId: bigint, now: Date): string {
    const chat = this.#chatConfig(telegramChatId);
    if (chat === undefined) {
      throw new Error(`Chat ${telegramChatId} is not configured`);
    }
    const date = now.toISOString().slice(0, 10);
    const chatId = this.#internalChatId(telegramChatId);
    const tokens =
      this.#store.orm
        .select({ amount: dailyUsage.amount })
        .from(dailyUsage)
        .where(
          and(
            eq(dailyUsage.utcDate, date),
            eq(dailyUsage.scope, 'chat'),
            eq(dailyUsage.resource, telegramChatId.toString()),
            eq(dailyUsage.metric, 'model_tokens'),
          ),
        )
        .get()?.amount ?? 0n;
    const dailyBudget = readDailyTokenBudget(this.#store.orm, this.#config.agent.daily_budget.max_tokens, now);
    const dailyBudgetBasisPoints =
      (dailyBudget.usedTokens * 10_000n + dailyBudget.maxTokens / 2n) / dailyBudget.maxTokens;
    const dailyBudgetPercentage = `${dailyBudgetBasisPoints / 100n}.${(dailyBudgetBasisPoints % 100n).toString().padStart(2, '0')}%`;
    const tokenBreakdown =
      chatId === null
        ? null
        : this.#store.orm
            .all<{
              readTokens: bigint;
              writeTokens: bigint;
              cacheReadTokens: bigint;
              cacheWriteTokens: bigint;
            }>(
              sql`SELECT COALESCE(SUM(model_calls.input_tokens), 0) AS readTokens,
                      COALESCE(SUM(model_calls.output_tokens), 0) AS writeTokens,
                      COALESCE(SUM(model_calls.cache_read_tokens), 0) AS cacheReadTokens,
                      COALESCE(SUM(model_calls.cache_write_tokens), 0) AS cacheWriteTokens
               FROM model_calls
               JOIN invocations ON invocations.id = model_calls.invocation_id
               WHERE invocations.conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})
                 AND substr(model_calls.finished_at, 1, 10) = ${date}`,
            )
            .at(0);
    const paused = chatId !== null && isChatPaused(this.#store.orm, chatId);
    const effective = this.#modelSwitcher?.current() ?? {
      provider: this.#config.agent.provider,
      model: this.#config.agent.model,
    };
    const lines = [
      `当前模型: ${effective.provider} / ${effective.model}`,
      `思考强度: ${this.#config.agent.thinking_level}`,
      `本群今日 token 用量: ${tokens.toLocaleString('en-US')}`,
      `全局今日 token 用量: ${dailyBudget.usedTokens.toLocaleString('en-US')} / ${dailyBudget.maxTokens.toLocaleString('en-US')} (${dailyBudgetPercentage})`,
      `读取: ${(tokenBreakdown?.readTokens ?? 0n).toLocaleString('en-US')}`,
      `写入: ${(tokenBreakdown?.writeTokens ?? 0n).toLocaleString('en-US')}`,
      `缓存读取: ${(tokenBreakdown?.cacheReadTokens ?? 0n).toLocaleString('en-US')}`,
      `缓存写入: ${(tokenBreakdown?.cacheWriteTokens ?? 0n).toLocaleString('en-US')}`,
    ];
    if (paused) {
      lines.push('互动: 已暂停');
      lines.push(...this.#contextLines(telegramChatId));
      return lines.join('\n');
    }
    const participation = this.#participationLine(telegramChatId, chatId, now);
    if (participation !== null) {
      lines.push(participation);
    }
    lines.push(...this.#contextLines(telegramChatId));
    return lines.join('\n');
  }

  /**
   * Conversation Context visibility: how much retained history the agent sees,
   * how many sends are inside the GC window, and when the last collection ran.
   */
  #contextLines(telegramChatId: bigint): string[] {
    const rows = listConversationContexts(this.#store, { telegramChatId });
    if (rows.length === 0) {
      return ['Context: 尚未建立'];
    }
    return rows.map((row) => {
      const topic = row.messageThreadId === 0n ? '' : `#${row.messageThreadId.toString()} `;
      const header = this.#contexts.header(row.conversationId);
      const stats = header === undefined ? null : this.#contexts.stats(header);
      const gc = stats?.lastGcAt == null ? '未 GC' : `上次 GC ${stats.lastGcAt}`;
      return `Context ${topic}消息 ${stats?.messageCount ?? Number(row.messageCount)}，保留 send ${stats?.retainedSends ?? 0}，head_seq ${row.headSeq}，${gc}`;
    });
  }

  // Only chats with a configured schedule report a participation line, so chats
  // that always participate keep the previous `/status` layout.
  #participationLine(telegramChatId: bigint, chatId: bigint | null, now: Date): string | null {
    const chat = this.#store.orm
      .select({ type: chats.type })
      .from(chats)
      .where(eq(chats.telegramChatId, telegramChatId))
      .get();
    if (chat === undefined) {
      return null;
    }
    const rule = this.#participation.ruleFor(this.#store.orm, telegramChatId, chat.type);
    if (rule === undefined) {
      return null;
    }
    if (isWithinActiveWindows(rule, now)) {
      return '互动: 活跃时段内';
    }
    const until = chatId === null ? null : chatAttentionUntil(this.#store.orm, chatId, now);
    return until === null ? '互动: 静默（仅 @、Reply 或关键词触发）' : `互动: 注意力窗口至 ${until}`;
  }

  #internalChatId(telegramChatId: bigint): bigint | null {
    return (
      this.#store.orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, telegramChatId)).get()?.id ??
      null
    );
  }

  #chatConfig(telegramChatId: bigint): RawConfig['telegram']['chats'][number] | undefined {
    return resolveChatConfig(this.#config, this.#store.orm, telegramChatId);
  }
}

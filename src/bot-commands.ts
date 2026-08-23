import type { Message } from 'grammy/types';
import { isBotAdmin } from './admin/admins.ts';
import type { RawConfig } from './config.ts';
import type { SqliteStore } from './database.ts';
import type { AgentModelOption, AgentModelSwitcher } from './model-switch.ts';
import type { BucketScheduler } from './scheduler.ts';

export interface ParsedCommand {
  readonly name: 'pause' | 'resume' | 'status' | 'model';
  readonly argument?: string;
}

export interface CommandSender {
  readonly id: bigint;
  readonly name: string;
  readonly username: string | null;
}

const COMMAND_NAMES = new Set<ParsedCommand['name']>(['pause', 'resume', 'status', 'model']);
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
  if (message.text === undefined || message.from?.is_bot === true) return null;
  const entity = message.entities?.find((entry) => entry.type === 'bot_command' && entry.offset === 0);
  if (entity === undefined) return null;
  const token = message.text.slice(0, entity.length);
  const separator = token.indexOf('@');
  const name = (separator === -1 ? token.slice(1) : token.slice(1, separator)).toLowerCase();
  const mention = separator === -1 ? null : token.slice(separator + 1).toLowerCase();
  if (mention !== null && mention !== botUsername?.toLowerCase()) return null;
  if (!COMMAND_NAMES.has(name as ParsedCommand['name'])) return null;
  if (name !== 'model') return { name: name as ParsedCommand['name'] };
  const argument = message.text.slice(entity.offset + entity.length).trim();
  return argument.length === 0 ? { name: 'model' } : { name: 'model', argument };
}

// Chat-scoped control commands. State changes and replies are deterministic
// bot responses, not model output, so they bypass the agent send tool.
export class BotCommandService {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #scheduler: BucketScheduler;
  readonly #modelSwitcher: AgentModelSwitcher | undefined;

  constructor(store: SqliteStore, config: RawConfig, scheduler: BucketScheduler, modelSwitcher?: AgentModelSwitcher) {
    this.#store = store;
    this.#config = config;
    this.#scheduler = scheduler;
    this.#modelSwitcher = modelSwitcher;
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
    }
  }

  #adminGate(sender: CommandSender | null): boolean {
    if (sender === null || !isBotAdmin(this.#store.db, sender.id)) return false;
    const timestamp = new Date().toISOString();
    // Keep the panel list readable: refresh the display name of acting admins.
    this.#store.db
      .query(
        "INSERT INTO bot_admins(telegram_user_id, display_name, added_by, created_at, updated_at) VALUES (?, ?, 'telegram', ?, ?) ON CONFLICT(telegram_user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at",
      )
      .run(sender.id, sender.name, timestamp, timestamp);
    return true;
  }

  #pause(telegramChatId: bigint, now: Date): string {
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) throw new Error(`Chat ${telegramChatId} has no stored row`);
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#store.db
        .query(
          'INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET paused_at = excluded.paused_at',
        )
        .run(chatId, timestamp);
      this.#store.db
        .query(
          `UPDATE buckets SET state = 'expired', error_code = 'chat_paused', finished_at = ?, updated_at = ?
           WHERE state IN ('collecting', 'queued') AND conversation_id IN (SELECT id FROM conversations WHERE chat_id = ?)`,
        )
        .run(timestamp, timestamp, chatId);
      this.#store.db
        .query(
          `UPDATE invocations SET state = 'aborted', completion_reason = 'chat_paused', finished_at = ?
           WHERE state = 'queued' AND conversation_id IN (SELECT id FROM conversations WHERE chat_id = ?)`,
        )
        .run(timestamp, chatId);
    });
    this.#scheduler.pauseChat(chatId);
    return '已暂停本群互动，发送 /resume 可恢复。';
  }

  #resume(telegramChatId: bigint): string {
    const chatId = this.#internalChatId(telegramChatId);
    if (chatId === null) throw new Error(`Chat ${telegramChatId} has no stored row`);
    this.#store.db.query('DELETE FROM chat_pause WHERE chat_id = ?').run(chatId);
    return '已恢复本群互动。';
  }

  #modelSwitch(argument: string | undefined): string {
    const switcher = this.#modelSwitcher;
    if (switcher === undefined) return '运行时模型切换不可用。';
    if (argument === undefined) return this.#modelMenu(switcher, 1, switcher.list());
    if (argument === 'reset') {
      const current = switcher.reset();
      return `已恢复 config.toml 默认模型: ${current.provider} / ${current.model}。`;
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
    if (option === undefined) return `无效序号。${this.#modelMenu(switcher, 1, options)}`;
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
      if (option === undefined) break;
      lines.push(`${index + 1}. ${option.provider} / ${option.model}（${option.name}）`);
    }
    lines.push('使用 /model 序号 切换，/model page 页码 翻页，/model reset 恢复默认');
    return lines.join('\n');
  }

  #status(telegramChatId: bigint, now: Date): string {
    const chat = this.#chatConfig(telegramChatId);
    if (chat === undefined) throw new Error(`Chat ${telegramChatId} is not configured`);
    const date = now.toISOString().slice(0, 10);
    const tokens =
      this.#store.db
        .query<{ amount: bigint }, [string, string]>(
          "SELECT amount FROM daily_usage WHERE utc_date = ? AND scope = 'chat' AND resource = ? AND metric = 'model_tokens'",
        )
        .get(date, telegramChatId.toString())?.amount ?? 0n;
    const chatId = this.#internalChatId(telegramChatId);
    const paused =
      chatId !== null &&
      this.#store.db
        .query<{ present: bigint }, [bigint]>('SELECT 1 AS present FROM chat_pause WHERE chat_id = ?')
        .get(chatId) !== null;
    const effective = this.#modelSwitcher?.current() ?? {
      provider: this.#config.agent.provider,
      model: this.#config.agent.model,
    };
    const lines = [
      `当前模型: ${effective.provider} / ${effective.model}`,
      `thinking effort: ${this.#config.agent.thinking_level}`,
      `今日 token 用量: ${tokens} / ${chat.budget.max_tokens_per_day}`,
    ];
    if (paused) lines.push('互动: 已暂停');
    return lines.join('\n');
  }

  #internalChatId(telegramChatId: bigint): bigint | null {
    return (
      this.#store.db
        .query<{ id: bigint }, [bigint]>('SELECT id FROM chats WHERE telegram_chat_id = ?')
        .get(telegramChatId)?.id ?? null
    );
  }

  #chatConfig(telegramChatId: bigint): RawConfig['telegram']['chats'][number] | undefined {
    const direct = this.#config.telegram.chats.find((chat) => BigInt(chat.id) === telegramChatId);
    if (direct !== undefined) return direct;
    const migration = this.#store.db
      .query<{ old_chat_id: bigint }, [bigint]>('SELECT old_chat_id FROM chat_migrations WHERE new_chat_id = ?')
      .get(telegramChatId);
    if (migration === null) return undefined;
    return this.#config.telegram.chats.find((chat) => BigInt(chat.id) === migration.old_chat_id);
  }
}

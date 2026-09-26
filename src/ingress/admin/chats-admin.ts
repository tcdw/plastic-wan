import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { eq } from 'drizzle-orm';
import {
  type AgentSettings,
  type FileChat,
  type FileConfig,
  type RawConfig,
  resolveAgentSettings,
  ThinkingLevelSchema,
} from '../../platform/config.ts';
import type { ConfigEdit } from '../../platform/config-file.ts';
import { supportedThinkingLevels } from '../../platform/thinking-levels.ts';
import type { SqliteStore } from '../../store/database.ts';
import { chatMigrations, chats } from '../../store/schema.ts';
import { AdminQueryError } from './audit.ts';
import { supervisedRestartEnabled } from './providers-admin.ts';

const ChatIdSchema = Type.String({ pattern: '^-?[1-9][0-9]{0,15}$' });
const TopicIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,15}$' });
const SettingsProperties = {
  topic_ids: Type.Union([Type.Array(TopicIdSchema, { minItems: 1, uniqueItems: true }), Type.Null()]),
  provider: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  model: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  thinking_level: Type.Union([ThinkingLevelSchema, Type.Null()]),
};
const SettingsSchema = Type.Object(SettingsProperties, { additionalProperties: false });
const CreateSchema = Type.Object({ id: ChatIdSchema, ...SettingsProperties }, { additionalProperties: false });
const settingsValidator = Compile(SettingsSchema);
const createValidator = Compile(CreateSchema);

export type ChatSettingsBody = Static<typeof SettingsSchema>;
export type CreateChatBody = Static<typeof CreateSchema>;

/** Configuration IDs are numbers, but HTTP IDs stay strings until the safe-integer check. */
export function parseChatId(value: string): number {
  if (!/^-?[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AdminQueryError('invalid_chat_id', 'Chat ID must be a nonzero safe integer');
  }
  return Number(value);
}

export function parseChatSettings(value: unknown): ChatSettingsBody {
  if (!settingsValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected topic_ids, provider, model and thinking_level; use null to inherit or allow all topics',
    );
  }
  return value;
}

export function parseCreateChat(value: unknown): CreateChatBody {
  if (!createValidator.Check(value)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected a string Chat ID and topic_ids, provider, model and thinking_level',
    );
  }
  return value;
}

function managedSettings(body: ChatSettingsBody): Omit<FileChat, 'id'> {
  if ((body.provider === null) !== (body.model === null)) {
    throw new AdminQueryError('invalid_model_reference', 'provider and model must both be set or both be null');
  }
  // An inherited thinking level would tie the global default to this Chat's model:
  // a later global change could then be rejected because of a Chat it never names.
  if (body.provider !== null && body.thinking_level === null) {
    throw new AdminQueryError('thinking_level_required', 'A Chat model override must also set thinking_level');
  }
  const topicIds = body.topic_ids?.map((id) => {
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new AdminQueryError('invalid_topic_id', 'Topic IDs must be positive safe integers');
    }
    return number;
  });
  return {
    ...(topicIds === undefined ? {} : { topic_ids: topicIds }),
    ...(body.provider === null ? {} : { provider: body.provider }),
    ...(body.model === null ? {} : { model: body.model }),
    ...(body.thinking_level === null ? {} : { thinking_level: body.thinking_level }),
  };
}

export function createChat(file: FileConfig, body: CreateChatBody): ConfigEdit[] {
  const id = parseChatId(body.id);
  if (file.telegram.chats.some((chat) => chat.id === id)) {
    throw new AdminQueryError('chat_exists', `Chat ${id} is already configured`, 409);
  }
  return [{ path: ['telegram', 'chats', file.telegram.chats.length], value: { id, ...managedSettings(body) } }];
}

function chatIndex(file: FileConfig, id: number): number {
  const index = file.telegram.chats.findIndex((chat) => chat.id === id);
  if (index < 0) {
    throw new AdminQueryError('chat_not_found', `Chat ${id} is not configured in the file`, 404);
  }
  return index;
}

export function updateChat(file: FileConfig, id: number, body: ChatSettingsBody): ConfigEdit[] {
  const index = chatIndex(file, id);
  const current = file.telegram.chats[index];
  const settings = managedSettings(body);
  const edits: ConfigEdit[] = [];
  // Edit only the managed fields, preserving instructions, participation and other Chat settings.
  for (const key of ['topic_ids', 'provider', 'model', 'thinking_level'] as const) {
    if (JSON.stringify(current?.[key]) !== JSON.stringify(settings[key])) {
      edits.push({ path: ['telegram', 'chats', index, key], value: settings[key] });
    }
  }
  return edits;
}

export function deleteChat(file: FileConfig, id: number): ConfigEdit[] {
  const index = chatIndex(file, id);
  if (file.telegram.chats.length === 1) {
    throw new AdminQueryError('last_chat_required', 'At least one Chat must remain in the allowlist', 409);
  }
  return [{ path: ['telegram', 'chats', index], value: undefined }];
}

function chatSettings(config: { agent: AgentSettings }, chat: FileChat | undefined) {
  return chat === undefined
    ? null
    : {
        topic_ids: chat.topic_ids?.map(String) ?? null,
        provider: chat.provider ?? null,
        model: chat.model ?? null,
        thinking_level: chat.thinking_level ?? null,
        effective: resolveAgentSettings(config, chat),
      };
}

export function listChats(
  file: FileConfig,
  active: RawConfig,
  store: SqliteStore,
  revision: string,
  restartRequired: readonly string[],
) {
  const savedChats = new Map(file.telegram.chats.map((chat) => [chat.id, chat]));
  const activeChats = new Map(active.telegram.chats.map((chat) => [chat.id, chat]));
  return {
    revision,
    supervised: supervisedRestartEnabled(),
    restart_required: restartRequired,
    defaults: resolveAgentSettings(file),
    models: Object.entries(file.providers).flatMap(([provider, definition]) =>
      definition.models
        .filter((model) => model.input.includes('text'))
        .map((model) => ({
          provider,
          model: model.id,
          name: model.name ?? model.id,
          thinking_levels: supportedThinkingLevels(model),
        })),
    ),
    items: [...new Set([...savedChats.keys(), ...activeChats.keys()])].map((id) => {
      const migration = store.orm
        .select()
        .from(chatMigrations)
        .where(eq(chatMigrations.oldChatId, BigInt(id)))
        .get();
      const runtimeId = migration?.newChatId ?? BigInt(id);
      const known = store.orm.select().from(chats).where(eq(chats.telegramChatId, runtimeId)).get();
      return {
        id: String(id),
        runtime_chat_id: String(runtimeId),
        title: known?.title ?? null,
        type: known?.type ?? null,
        saved: chatSettings(file, savedChats.get(id)),
        active: chatSettings(active, activeChats.get(id)),
      };
    }),
  };
}

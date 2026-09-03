import { and, desc, eq, sql } from 'drizzle-orm';
import type { Message, Update } from 'grammy/types';
import { type ParsedCommand, parseBotCommand } from '../orchestration/bot-commands.ts';
import type { RawConfig } from '../platform/config.ts';
import { asRunResult, isChatPaused, resolveChatConfig, type SqliteStore } from '../store/database.ts';
import {
  bucketMessages,
  buckets,
  chatMigrations,
  chats,
  conversations,
  invocations,
  media as mediaTable,
  messageRevisions,
  messages,
  senders,
  telegramUpdates,
} from '../store/schema.ts';

const IMAGE_MIME_TYPES: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
};
const SERVICE_KEYS: Record<string, true> = {
  new_chat_members: true,
  left_chat_member: true,
  new_chat_title: true,
  new_chat_photo: true,
  delete_chat_photo: true,
  group_chat_created: true,
  supergroup_chat_created: true,
  channel_chat_created: true,
  message_auto_delete_timer_changed: true,
  migrate_to_chat_id: true,
  migrate_from_chat_id: true,
  pinned_message: true,
  forum_topic_created: true,
  forum_topic_closed: true,
  forum_topic_reopened: true,
  forum_topic_edited: true,
  general_forum_topic_hidden: true,
  general_forum_topic_unhidden: true,
  video_chat_scheduled: true,
  video_chat_started: true,
  video_chat_ended: true,
  video_chat_participants_invited: true,
};
const MAX_IMAGE_DOCUMENT_BYTES = 20 * 1024 * 1024;

interface StoredMessage {
  readonly id: bigint;
  readonly revisionId: bigint;
  readonly eligibleHuman: boolean;
  readonly companionOnly: boolean;
}

export interface IngestResult {
  readonly messageId?: bigint;
  readonly bucketId?: bigint;
  readonly command?: ParsedCommand;
}

export class TelegramIngestion {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #allowedChats = new Map<string, ReadonlySet<bigint> | undefined>();
  readonly #botId: bigint;
  readonly #botUsername: string | null;

  constructor(store: SqliteStore, config: RawConfig, bot: { readonly id: number; readonly username?: string | null }) {
    this.#store = store;
    this.#config = config;
    this.#botId = BigInt(bot.id);
    this.#botUsername = bot.username ?? null;
    for (const chat of config.telegram.chats) {
      this.#allowedChats.set(
        String(chat.id),
        chat.topic_ids === undefined ? undefined : new Set(chat.topic_ids.map((topicId) => BigInt(topicId))),
      );
    }
  }

  ingest(update: Update, receivedAt = new Date()): IngestResult {
    return this.#store.transaction(() => this.#ingestTransaction(update, receivedAt, true));
  }

  ingestCatchUp(update: Update, receivedAt = new Date()): IngestResult {
    return this.#store.transaction(() => this.#ingestTransaction(update, receivedAt, false));
  }

  #ingestTransaction(update: Update, receivedAt: Date, schedule: boolean): IngestResult {
    const message = update.edited_message ?? update.message;
    const membership = update.my_chat_member;
    const chat = message?.chat ?? membership?.chat;
    const chatId = chat === undefined ? undefined : BigInt(chat.id);
    const threadId =
      message?.chat.type === 'supergroup' &&
      message.chat.is_forum === true &&
      message.is_topic_message === true &&
      message.message_thread_id !== undefined
        ? BigInt(message.message_thread_id)
        : 0n;
    const topics = chatId === undefined ? null : this.#topicsFor(chatId);
    const topicAllowed = topics !== null && (topics === undefined || topics.has(threadId));
    const allowed = chat !== undefined && chat.type !== 'channel' && topicAllowed;
    const rejectionReason = allowed
      ? null
      : chat === undefined
        ? 'unsupported_update'
        : chat.type === 'channel'
          ? 'channel'
          : topics === null
            ? 'chat_not_allowed'
            : 'topic_not_allowed';
    const inserted = asRunResult(
      this.#store.orm
        .insert(telegramUpdates)
        .values({
          updateId: BigInt(update.update_id),
          chatId: chatId ?? null,
          chatType: chat?.type ?? null,
          receivedAt: receivedAt.toISOString(),
          allowed,
          rejectionReason,
          rawJson: allowed ? JSON.stringify(update) : null,
        })
        .onConflictDoNothing({ target: telegramUpdates.updateId })
        .run(),
    );
    if (inserted.changes === 0) {
      return {};
    }
    if (!allowed || chat === undefined || chatId === undefined || topics === null) {
      return {};
    }

    this.#recordMigration(message, receivedAt);
    if (message === undefined) {
      this.#upsertChat(chat, chatId, receivedAt);
      return {};
    }
    const chatConfig = resolveChatConfig(this.#config, this.#store.orm, chatId);
    const ignoredUserIds = chatConfig?.ignored_user_ids ?? [];
    if (isIgnoredUser(message, ignoredUserIds)) {
      return {};
    }
    const internalChatId = this.#upsertChat(chat, chatId, receivedAt);
    const edited = update.edited_message !== undefined;
    // Chat control commands are handled by the bot itself: they are audited
    // but never stored as messages, so they cannot trigger or taint buckets.
    const command = schedule && !edited ? parseBotCommand(message, this.#botUsername) : null;
    if (command !== null) {
      return { command };
    }
    const stored = this.#storeMessage(message, internalChatId, threadId, receivedAt, edited, ignoredUserIds);
    if (stored === undefined) {
      return {};
    }
    let bucketId: bigint | undefined;
    if (!edited && schedule) {
      bucketId = this.#appendToBucket(internalChatId, threadId, stored, receivedAt);
    }
    return {
      messageId: stored.id,
      ...(bucketId === undefined ? {} : { bucketId }),
    };
  }

  /** `null` when the chat is not allowed; `undefined` when allowed for all topics. */
  #topicsFor(chatId: bigint): ReadonlySet<bigint> | undefined | null {
    if (this.#allowedChats.has(chatId.toString())) {
      return this.#allowedChats.get(chatId.toString());
    }
    const migration = this.#store.orm
      .select({ oldChatId: chatMigrations.oldChatId })
      .from(chatMigrations)
      .where(eq(chatMigrations.newChatId, chatId))
      .get();
    if (migration === undefined) {
      return null;
    }
    const migrated = migration.oldChatId.toString();
    return this.#allowedChats.has(migrated) ? this.#allowedChats.get(migrated) : null;
  }

  #recordMigration(message: Message | undefined, receivedAt: Date): void {
    if (message === undefined) {
      return;
    }
    let oldChatId: bigint | undefined;
    let newChatId: bigint | undefined;
    if ('migrate_to_chat_id' in message) {
      oldChatId = BigInt(message.chat.id);
      newChatId = BigInt(message.migrate_to_chat_id);
    } else if ('migrate_from_chat_id' in message) {
      oldChatId = BigInt(message.migrate_from_chat_id);
      newChatId = BigInt(message.chat.id);
    }
    if (oldChatId === undefined || newChatId === undefined) {
      return;
    }
    this.#store.orm
      .insert(chatMigrations)
      .values({
        oldChatId,
        newChatId,
        receivedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: chatMigrations.oldChatId,
        set: { newChatId, receivedAt: receivedAt.toISOString() },
      })
      .run();
  }

  #upsertChat(chat: Message['chat'], chatId: bigint, receivedAt: Date): bigint {
    const title = 'title' in chat ? (chat.title ?? null) : null;
    const username = 'username' in chat ? (chat.username ?? null) : null;
    this.#store.orm
      .insert(chats)
      .values({
        telegramChatId: chatId,
        canonicalChatId: chatId,
        type: chat.type,
        title,
        username,
        updatedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: chats.telegramChatId,
        set: { type: chat.type, title, username, updatedAt: receivedAt.toISOString() },
      })
      .run();
    const row = this.#store.orm.select({ id: chats.id }).from(chats).where(eq(chats.telegramChatId, chatId)).get();
    if (row === undefined) {
      throw new Error('Chat upsert did not return a row');
    }
    return row.id;
  }

  #storeMessage(
    message: Message,
    internalChatId: bigint,
    threadId: bigint,
    receivedAt: Date,
    edited: boolean,
    ignoredUserIds: readonly number[],
  ): StoredMessage | undefined {
    const sender = this.#upsertSender(message, receivedAt);
    const fromBot = message.from?.is_bot === true;
    const ownMessage = message.from !== undefined && BigInt(message.from.id) === this.#botId;
    const service = isServiceMessage(message);
    if (ownMessage || (fromBot && !this.#config.telegram.process_bot_messages)) {
      return undefined;
    }
    const conversationId = this.#upsertConversation(internalChatId, threadId, receivedAt);
    const telegramMessageId = BigInt(message.message_id);
    const existing = this.#store.orm
      .all<{ id: bigint; revision_no: bigint }>(
        sql`SELECT m.id, COALESCE(MAX(r.revision_no), 0) AS revision_no FROM messages m LEFT JOIN message_revisions r ON r.message_id = m.id WHERE m.chat_id = ${internalChatId} AND m.telegram_message_id = ${telegramMessageId} GROUP BY m.id`,
      )
      .at(0);
    let messageId: bigint;
    let revisionNo: bigint;
    if (existing === undefined) {
      const created = this.#store.orm
        .insert(messages)
        .values({
          conversationId,
          chatId: internalChatId,
          telegramMessageId,
          telegramDate: new Date(message.date * 1000).toISOString(),
          receivedAt: receivedAt.toISOString(),
        })
        .returning({ id: messages.id })
        .get();
      if (created === undefined) {
        throw new Error('messages insert returned no row');
      }
      messageId = created.id;
      revisionNo = 1n;
    } else {
      messageId = existing.id;
      if (!edited) {
        return undefined;
      }
      revisionNo = existing.revision_no + 1n;
    }
    const normalized = normalizeMessage(message, service, ignoredUserIds);
    const stickerOnly =
      normalized.kind === 'sticker' &&
      normalized.text === null &&
      normalized.caption === null &&
      normalized.media.length === 1 &&
      normalized.media[0]?.kind === 'sticker';
    const eligibleHuman =
      !fromBot && !service && (!stickerOnly || this.#config.telegram.sticker_trigger_enabled === true);
    const revision = this.#store.orm
      .insert(messageRevisions)
      .values({
        messageId,
        revisionNo,
        senderId: sender,
        kind: normalized.kind,
        text: normalized.text,
        caption: normalized.caption,
        replyToMessageId: normalized.replyToMessageId,
        replySnapshotJson: normalized.replySnapshot,
        forwardOriginJson: normalized.forwardOrigin,
        mediaGroupId: message.media_group_id ?? null,
        serviceJson: service ? JSON.stringify(message) : null,
        createdAt: receivedAt.toISOString(),
        rawFragmentJson: JSON.stringify(message),
      })
      .returning({ id: messageRevisions.id })
      .get();
    if (revision === undefined) {
      throw new Error('message_revisions insert returned no row');
    }
    const revisionId = revision.id;
    this.#store.orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
    for (const media of normalized.media) {
      this.#store.orm
        .insert(mediaTable)
        .values({
          revisionId,
          kind: media.kind,
          fileId: media.fileId,
          fileUniqueId: media.fileUniqueId,
          mimeType: media.mimeType,
          fileSize: media.fileSize,
          width: media.width,
          height: media.height,
          telegramJson: media.telegramJson,
        })
        .run();
    }
    return {
      id: messageId,
      revisionId,
      eligibleHuman,
      companionOnly: !eligibleHuman,
    };
  }

  #upsertSender(message: Message, receivedAt: Date): bigint | null {
    const senderChat = message.sender_chat;
    let type: 'user' | 'sender_chat';
    let telegramId: bigint;
    let displayName: string;
    let username: string | null;
    let isBot: boolean;
    if (senderChat !== undefined) {
      type = 'sender_chat';
      telegramId = BigInt(senderChat.id);
      displayName = senderChat.title ?? senderChat.username ?? senderChat.id.toString();
      username = senderChat.username ?? null;
      isBot = false;
    } else if (message.from !== undefined) {
      type = 'user';
      telegramId = BigInt(message.from.id);
      displayName = [message.from.first_name, message.from.last_name].filter((part) => part !== undefined).join(' ');
      username = message.from.username ?? null;
      isBot = message.from.is_bot;
    } else {
      return null;
    }
    this.#store.orm
      .insert(senders)
      .values({
        telegramType: type,
        telegramId,
        displayName,
        username,
        isBot,
        updatedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: [senders.telegramType, senders.telegramId],
        set: { displayName, username, isBot, updatedAt: receivedAt.toISOString() },
      })
      .run();
    const row = this.#store.orm
      .select({ id: senders.id })
      .from(senders)
      .where(and(eq(senders.telegramType, type), eq(senders.telegramId, telegramId)))
      .get();
    if (row === undefined) {
      throw new Error('Sender upsert did not return a row');
    }
    return row.id;
  }

  #upsertConversation(chatId: bigint, threadId: bigint, receivedAt: Date): bigint {
    this.#store.orm
      .insert(conversations)
      .values({
        chatId,
        messageThreadId: threadId,
        createdAt: receivedAt.toISOString(),
        updatedAt: receivedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: [conversations.chatId, conversations.messageThreadId],
        set: { updatedAt: receivedAt.toISOString() },
      })
      .run();
    const row = this.#store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
      .get();
    if (row === undefined) {
      throw new Error('Conversation upsert did not return a row');
    }
    return row.id;
  }

  #appendToBucket(chatId: bigint, threadId: bigint, message: StoredMessage, receivedAt: Date): bigint | undefined {
    if (isChatPaused(this.#store.orm, chatId)) {
      return undefined;
    }
    const conversation = this.#store.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId)))
      .get();
    if (conversation === undefined) {
      throw new Error('Conversation missing while assigning bucket');
    }
    const collecting = this.#store.orm
      .select({ id: buckets.id })
      .from(buckets)
      .where(and(eq(buckets.conversationId, conversation.id), eq(buckets.state, 'collecting')))
      .get();
    if (message.companionOnly && collecting === undefined) {
      return undefined;
    }
    let bucketId = collecting?.id;
    if (bucketId === undefined) {
      if (!message.eligibleHuman) {
        return undefined;
      }
      const now = receivedAt.toISOString();
      const latestInvocation = this.#store.orm
        .select({ state: invocations.state, startedAt: invocations.startedAt })
        .from(invocations)
        .innerJoin(conversations, eq(invocations.conversationId, conversations.id))
        .where(eq(conversations.chatId, chatId))
        .orderBy(desc(invocations.id))
        .limit(1)
        .get();
      const priorPaceAt =
        latestInvocation?.startedAt === null || latestInvocation?.startedAt === undefined
          ? receivedAt.getTime()
          : Date.parse(latestInvocation.startedAt) + this.#config.telegram.bucket_window_seconds * 1_000;
      const remainsOnPriorPace =
        latestInvocation?.state === 'queued' ||
        latestInvocation?.state === 'running' ||
        receivedAt.getTime() < priorPaceAt;
      const deadline = remainsOnPriorPace
        ? Math.max(receivedAt.getTime(), priorPaceAt)
        : receivedAt.getTime() + this.#config.telegram.bucket_window_seconds * 1_000;
      const created = this.#store.orm
        .insert(buckets)
        .values({
          conversationId: conversation.id,
          state: 'collecting',
          firstReceivedAt: now,
          deadlineAt: new Date(deadline).toISOString(),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: buckets.id })
        .get();
      if (created === undefined) {
        throw new Error('buckets insert returned no row');
      }
      bucketId = created.id;
    }
    const sequence = this.#store.orm
      .all<{ next_sequence: bigint }>(
        sql`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM bucket_messages WHERE bucket_id = ${bucketId}`,
      )
      .at(0);
    if (sequence === undefined) {
      throw new Error('Unable to allocate bucket sequence');
    }
    this.#store.orm
      .insert(bucketMessages)
      .values({
        bucketId,
        messageId: message.id,
        sequenceNo: sequence.next_sequence,
        sourceBucketId: bucketId,
      })
      .run();
    return bucketId;
  }
}

interface NormalizedMedia {
  readonly kind: 'photo' | 'document' | 'sticker';
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly width: bigint | null;
  readonly height: bigint | null;
  readonly telegramJson: string;
}

interface NormalizedMessage {
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly replyToMessageId: bigint | null;
  readonly replySnapshot: string | null;
  readonly forwardOrigin: string | null;
  readonly media: readonly NormalizedMedia[];
}

function normalizeMessage(message: Message, service: boolean, ignoredUserIds: readonly number[]): NormalizedMessage {
  const media: NormalizedMedia[] = [];
  let kind = service ? 'service' : 'unsupported';
  if (message.text !== undefined) {
    kind = 'text';
  }
  if (message.photo !== undefined) {
    kind = 'photo';
    const photo = message.photo.at(-1);
    if (photo !== undefined) {
      media.push({
        kind: 'photo',
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        mimeType: 'image/jpeg',
        fileSize: photo.file_size === undefined ? null : BigInt(photo.file_size),
        width: BigInt(photo.width),
        height: BigInt(photo.height),
        telegramJson: JSON.stringify(photo),
      });
    }
  }
  const document = message.document;
  if (
    document !== undefined &&
    document.mime_type !== undefined &&
    document.mime_type in IMAGE_MIME_TYPES &&
    document.file_size !== undefined &&
    document.file_size <= MAX_IMAGE_DOCUMENT_BYTES
  ) {
    kind = 'document';
    media.push({
      kind: 'document',
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      mimeType: document.mime_type,
      fileSize: BigInt(document.file_size),
      width: document.thumbnail === undefined ? null : BigInt(document.thumbnail.width),
      height: document.thumbnail === undefined ? null : BigInt(document.thumbnail.height),
      telegramJson: JSON.stringify(document),
    });
  }
  const sticker = message.sticker;
  if (sticker !== undefined) {
    kind = 'sticker';
    media.push({
      kind: 'sticker',
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      mimeType: sticker.is_video ? 'video/webm' : sticker.is_animated ? 'application/x-tgsticker' : 'image/webp',
      fileSize: sticker.file_size === undefined ? null : BigInt(sticker.file_size),
      width: BigInt(sticker.width),
      height: BigInt(sticker.height),
      telegramJson: JSON.stringify(sticker),
    });
  }
  const reply = message.reply_to_message;
  const visibleReply = reply !== undefined && !isIgnoredUser(reply, ignoredUserIds) ? reply : undefined;
  return {
    kind,
    text: message.text ?? null,
    caption: message.caption ?? null,
    replyToMessageId: visibleReply === undefined ? null : BigInt(visibleReply.message_id),
    replySnapshot: visibleReply === undefined ? null : JSON.stringify(compactReply(visibleReply)),
    forwardOrigin: message.forward_origin === undefined ? null : JSON.stringify(message.forward_origin),
    media,
  };
}

function isIgnoredUser(message: Message, ignoredUserIds: readonly number[]): boolean {
  if (message.sender_chat !== undefined || message.from === undefined) {
    return false;
  }
  const senderId = BigInt(message.from.id);
  return ignoredUserIds.some((ignoredUserId) => BigInt(ignoredUserId) === senderId);
}

function compactReply(message: Message): Record<string, unknown> {
  const sender = message.sender_chat ?? message.from;
  const senderName =
    sender === undefined
      ? 'unknown'
      : 'title' in sender
        ? sender.title
        : [sender.first_name, sender.last_name].filter((part) => part !== undefined).join(' ');
  const content = message.text ?? message.caption;
  return {
    message_id: String(message.message_id),
    sender: senderName,
    content:
      content === undefined
        ? `[${message.photo !== undefined ? 'photo' : message.sticker !== undefined ? 'sticker' : 'message'}]`
        : content.slice(0, 500),
  };
}

function isServiceMessage(message: Message): boolean {
  for (const key of Object.keys(SERVICE_KEYS)) {
    if (key in message) {
      return true;
    }
  }
  return false;
}

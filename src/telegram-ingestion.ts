import type { Message, Update } from 'grammy/types';
import { type ParsedCommand, parseBotCommand } from './bot-commands.ts';
import type { RawConfig } from './config.ts';
import { type SqliteStore, isChatPaused } from './database.ts';

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
    const threadId = message?.message_thread_id === undefined ? 0n : BigInt(message.message_thread_id);
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
    const inserted = this.#store.db
      .query(
        'INSERT INTO telegram_updates(update_id, chat_id, chat_type, received_at, allowed, rejection_reason, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(update_id) DO NOTHING',
      )
      .run(
        BigInt(update.update_id),
        chatId ?? null,
        chat?.type ?? null,
        receivedAt.toISOString(),
        allowed ? 1n : 0n,
        rejectionReason,
        allowed ? JSON.stringify(update) : null,
      );
    if (inserted.changes === 0) return {};
    if (!allowed || chat === undefined || chatId === undefined || topics === null) return {};

    this.#recordMigration(message, receivedAt);
    const internalChatId = this.#upsertChat(chat, chatId, receivedAt);
    if (message === undefined) return {};
    const edited = update.edited_message !== undefined;
    // Chat control commands are handled by the bot itself: they are audited
    // but never stored as messages, so they cannot trigger or taint buckets.
    const command = schedule && !edited ? parseBotCommand(message, this.#botUsername) : null;
    if (command !== null) return { command };
    const stored = this.#storeMessage(message, internalChatId, threadId, receivedAt, edited);
    if (stored === undefined) return {};
    let bucketId: bigint | undefined;
    if (!edited && schedule) bucketId = this.#appendToBucket(internalChatId, threadId, stored, receivedAt);
    return {
      messageId: stored.id,
      ...(bucketId === undefined ? {} : { bucketId }),
    };
  }

  /** `null` when the chat is not allowed; `undefined` when allowed for all topics. */
  #topicsFor(chatId: bigint): ReadonlySet<bigint> | undefined | null {
    if (this.#allowedChats.has(chatId.toString())) return this.#allowedChats.get(chatId.toString());
    const migration = this.#store.db
      .query<{ old_chat_id: bigint }, [bigint]>('SELECT old_chat_id FROM chat_migrations WHERE new_chat_id = ?')
      .get(chatId);
    if (migration === null) return null;
    const migrated = migration.old_chat_id.toString();
    return this.#allowedChats.has(migrated) ? this.#allowedChats.get(migrated) : null;
  }

  #recordMigration(message: Message | undefined, receivedAt: Date): void {
    if (message === undefined) return;
    let oldChatId: bigint | undefined;
    let newChatId: bigint | undefined;
    if ('migrate_to_chat_id' in message) {
      oldChatId = BigInt(message.chat.id);
      newChatId = BigInt(message.migrate_to_chat_id);
    } else if ('migrate_from_chat_id' in message) {
      oldChatId = BigInt(message.migrate_from_chat_id);
      newChatId = BigInt(message.chat.id);
    }
    if (oldChatId === undefined || newChatId === undefined) return;
    this.#store.db
      .query(
        'INSERT INTO chat_migrations(old_chat_id, new_chat_id, received_at) VALUES (?, ?, ?) ON CONFLICT(old_chat_id) DO UPDATE SET new_chat_id = excluded.new_chat_id, received_at = excluded.received_at',
      )
      .run(oldChatId, newChatId, receivedAt.toISOString());
  }

  #upsertChat(chat: Message['chat'], chatId: bigint, receivedAt: Date): bigint {
    const title = 'title' in chat ? (chat.title ?? null) : null;
    const username = 'username' in chat ? (chat.username ?? null) : null;
    this.#store.db
      .query(
        'INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, username, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_chat_id) DO UPDATE SET type = excluded.type, title = excluded.title, username = excluded.username, updated_at = excluded.updated_at',
      )
      .run(chatId, chatId, chat.type, title, username, receivedAt.toISOString());
    const row = this.#store.db
      .query<{ id: bigint }, [bigint]>('SELECT id FROM chats WHERE telegram_chat_id = ?')
      .get(chatId);
    if (row === null) throw new Error('Chat upsert did not return a row');
    return row.id;
  }

  #storeMessage(
    message: Message,
    internalChatId: bigint,
    threadId: bigint,
    receivedAt: Date,
    edited: boolean,
  ): StoredMessage | undefined {
    const sender = this.#upsertSender(message, receivedAt);
    const fromBot = message.from?.is_bot === true;
    const ownMessage = message.from !== undefined && BigInt(message.from.id) === this.#botId;
    const service = isServiceMessage(message);
    if (ownMessage || (fromBot && !this.#config.telegram.process_bot_messages)) return undefined;
    const conversationId = this.#upsertConversation(internalChatId, threadId, receivedAt);
    const telegramMessageId = BigInt(message.message_id);
    const existing = this.#store.db
      .query<{ id: bigint; revision_no: bigint }, [bigint, bigint]>(
        'SELECT m.id, COALESCE(MAX(r.revision_no), 0) AS revision_no FROM messages m LEFT JOIN message_revisions r ON r.message_id = m.id WHERE m.chat_id = ? AND m.telegram_message_id = ? GROUP BY m.id',
      )
      .get(internalChatId, telegramMessageId);
    let messageId: bigint;
    let revisionNo: bigint;
    if (existing === null) {
      const created = this.#store.db
        .query(
          'INSERT INTO messages(conversation_id, chat_id, telegram_message_id, telegram_date, received_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          conversationId,
          internalChatId,
          telegramMessageId,
          new Date(message.date * 1000).toISOString(),
          receivedAt.toISOString(),
        );
      messageId = BigInt(created.lastInsertRowid);
      revisionNo = 1n;
    } else {
      messageId = existing.id;
      if (!edited) return undefined;
      revisionNo = existing.revision_no + 1n;
    }
    const normalized = normalizeMessage(message, service);
    const revision = this.#store.db
      .query(
        'INSERT INTO message_revisions(message_id, revision_no, sender_id, kind, text, caption, reply_to_message_id, reply_snapshot_json, forward_origin_json, media_group_id, service_json, created_at, raw_fragment_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        messageId,
        revisionNo,
        sender,
        normalized.kind,
        normalized.text,
        normalized.caption,
        normalized.replyToMessageId,
        normalized.replySnapshot,
        normalized.forwardOrigin,
        message.media_group_id ?? null,
        service ? JSON.stringify(message) : null,
        receivedAt.toISOString(),
        JSON.stringify(message),
      );
    const revisionId = revision.lastInsertRowid;
    this.#store.db.query('UPDATE messages SET current_revision_id = ? WHERE id = ?').run(revisionId, messageId);
    for (const media of normalized.media) {
      this.#store.db
        .query(
          'INSERT INTO media(revision_id, kind, file_id, file_unique_id, mime_type, file_size, width, height, telegram_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          revisionId,
          media.kind,
          media.fileId,
          media.fileUniqueId,
          media.mimeType,
          media.fileSize,
          media.width,
          media.height,
          media.telegramJson,
        );
    }
    return {
      id: messageId,
      revisionId: BigInt(revisionId),
      eligibleHuman: !fromBot && !service,
      companionOnly: fromBot || service,
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
    this.#store.db
      .query(
        'INSERT INTO senders(telegram_type, telegram_id, display_name, username, is_bot, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_type, telegram_id) DO UPDATE SET display_name = excluded.display_name, username = excluded.username, is_bot = excluded.is_bot, updated_at = excluded.updated_at',
      )
      .run(type, telegramId, displayName, username, isBot ? 1n : 0n, receivedAt.toISOString());
    const row = this.#store.db
      .query<{ id: bigint }, [string, bigint]>('SELECT id FROM senders WHERE telegram_type = ? AND telegram_id = ?')
      .get(type, telegramId);
    if (row === null) throw new Error('Sender upsert did not return a row');
    return row.id;
  }

  #upsertConversation(chatId: bigint, threadId: bigint, receivedAt: Date): bigint {
    this.#store.db
      .query(
        'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, message_thread_id) DO UPDATE SET updated_at = excluded.updated_at',
      )
      .run(chatId, threadId, receivedAt.toISOString(), receivedAt.toISOString());
    const row = this.#store.db
      .query<{ id: bigint }, [bigint, bigint]>(
        'SELECT id FROM conversations WHERE chat_id = ? AND message_thread_id = ?',
      )
      .get(chatId, threadId);
    if (row === null) throw new Error('Conversation upsert did not return a row');
    return row.id;
  }

  #appendToBucket(chatId: bigint, threadId: bigint, message: StoredMessage, receivedAt: Date): bigint | undefined {
    if (isChatPaused(this.#store.db, chatId)) return undefined;
    const conversation = this.#store.db
      .query<{ id: bigint }, [bigint, bigint]>(
        'SELECT id FROM conversations WHERE chat_id = ? AND message_thread_id = ?',
      )
      .get(chatId, threadId);
    if (conversation === null) throw new Error('Conversation missing while assigning bucket');
    const collecting = this.#store.db
      .query<{ id: bigint }, [bigint]>("SELECT id FROM buckets WHERE conversation_id = ? AND state = 'collecting'")
      .get(conversation.id);
    if (message.companionOnly && collecting === null) return undefined;
    let bucketId = collecting?.id;
    if (bucketId === undefined) {
      if (!message.eligibleHuman) return undefined;
      const now = receivedAt.toISOString();
      const latestInvocation = this.#store.db
        .query<{ state: string; started_at: string | null }, [bigint]>(
          `SELECT i.state, i.started_at FROM invocations i
           JOIN conversations v ON v.id = i.conversation_id
           WHERE v.chat_id = ?
           ORDER BY i.id DESC LIMIT 1`,
        )
        .get(chatId);
      const priorPaceAt =
        latestInvocation?.started_at === null || latestInvocation?.started_at === undefined
          ? receivedAt.getTime()
          : Date.parse(latestInvocation.started_at) + this.#config.telegram.bucket_window_seconds * 1_000;
      const remainsOnPriorPace =
        latestInvocation?.state === 'queued' ||
        latestInvocation?.state === 'running' ||
        receivedAt.getTime() < priorPaceAt;
      const deadline = remainsOnPriorPace
        ? Math.max(receivedAt.getTime(), priorPaceAt)
        : receivedAt.getTime() + this.#config.telegram.bucket_window_seconds * 1_000;
      const created = this.#store.db
        .query(
          "INSERT INTO buckets(conversation_id, state, first_received_at, deadline_at, created_at, updated_at) VALUES (?, 'collecting', ?, ?, ?, ?)",
        )
        .run(conversation.id, now, new Date(deadline).toISOString(), now, now);
      bucketId = BigInt(created.lastInsertRowid);
    }
    const sequence = this.#store.db
      .query<{ next_sequence: bigint }, [bigint]>(
        'SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM bucket_messages WHERE bucket_id = ?',
      )
      .get(bucketId);
    if (sequence === null) throw new Error('Unable to allocate bucket sequence');
    this.#store.db
      .query('INSERT INTO bucket_messages(bucket_id, message_id, sequence_no, source_bucket_id) VALUES (?, ?, ?, ?)')
      .run(bucketId, message.id, sequence.next_sequence, bucketId);
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

function normalizeMessage(message: Message, service: boolean): NormalizedMessage {
  const media: NormalizedMedia[] = [];
  let kind = service ? 'service' : 'unsupported';
  if (message.text !== undefined) kind = 'text';
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
  return {
    kind,
    text: message.text ?? null,
    caption: message.caption ?? null,
    replyToMessageId: reply === undefined ? null : BigInt(reply.message_id),
    replySnapshot: reply === undefined ? null : JSON.stringify(compactReply(reply)),
    forwardOrigin: message.forward_origin === undefined ? null : JSON.stringify(message.forward_origin),
    media,
  };
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
    if (key in message) return true;
  }
  return false;
}

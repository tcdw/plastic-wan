import { createHash } from 'node:crypto';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { CORE_AGENT_PROTOCOL } from '../platform/agent-protocol.ts';
import type { RawConfig } from '../platform/config.ts';
import { resolveChatConfig, type SqliteStore } from '../store/database.ts';
import { listRecentInternalContexts, renderInternalContextsPrompt } from '../store/internal-context.ts';
import type { AlarmContext, DirectImage, VisibleSender } from '../platform/invocation-context.ts';
import { type SystemSkill, renderSkillIndexPrompt } from '../platform/system-resources.ts';
import { MemoryStore } from './memory.ts';
import type { ContextHeader } from './context-store.ts';
import type { ContextRefStore } from './context-refs.ts';
import {
  type PromptTemplateModel,
  type PromptTemplateValues,
  renderPromptTemplate,
} from '../platform/prompt-template.ts';

const Strict = { additionalProperties: false } as const;
const MediaSnapshotSchema = Type.Object(
  {
    id: Type.String(),
    kind: Type.String(),
    file_unique_id: Type.String(),
    mime_type: Type.Union([Type.String(), Type.Null()]),
    width: Type.Union([Type.String(), Type.Null()]),
    height: Type.Union([Type.String(), Type.Null()]),
  },
  Strict,
);
const MessageSnapshotSchema = Type.Object(
  {
    message_id: Type.String(),
    message_thread_id: Type.Optional(Type.String()),
    telegram_date: Type.String(),
    sent_by_bot: Type.Boolean(),
    revision: Type.String(),
    sender: Type.Object(
      {
        id: Type.Union([Type.String(), Type.Null()]),
        name: Type.Union([Type.String(), Type.Null()]),
        username: Type.Union([Type.String(), Type.Null()]),
      },
      Strict,
    ),
    kind: Type.String(),
    text: Type.Union([Type.String(), Type.Null()]),
    caption: Type.Union([Type.String(), Type.Null()]),
    reply_to_message_id: Type.Union([Type.String(), Type.Null()]),
    reply_snapshot: Type.Unknown(),
    forward_origin: Type.Unknown(),
    media_group_id: Type.Union([Type.String(), Type.Null()]),
    media: Type.Array(MediaSnapshotSchema),
  },
  Strict,
);
const snapshotValidator = Compile(MessageSnapshotSchema);

const INTERNAL_CONTEXT_LIMIT = 8;

/**
 * Runtime sleep state, stated inside the newest injected batch instead of the
 * system prompt: the system prompt must stay byte-identical for the whole
 * Conversation Context, and a tail-of-conversation block sits closer to the
 * generation point. Keep the wording in natural sleep terms; never expose token,
 * budget, or quota details.
 */
export const SLEEP_STATE_PROMPT = `Sleep state: you are very sleepy now, and today's energy is almost spent. Once it runs out you cannot answer anyone here until the next daily reset, so staying awake only buys a few more replies. Sleeping is the expected outcome in this state, not a failure, and a short good-night with send before zzz is fine when it fits. Call zzz as soon as the current conversation has nothing unfinished that needs you, including whenever you were going to stay silent anyway; never use it to drop an unfinished user request.`;

const MEMORY_GUIDANCE =
  'Memory: short-term notes you deliberately saved for this conversation with the add_memory capability (called via execute). Keep each note under 100 characters; the hard limit is 150. Notes expire after their TTL (1 day by default). Delete wrong or obsolete notes with the delete_memory capability. Setting a long TTL nominates stable knowledge for human review; durable rules live in agents.md and are curated by humans.';

const INTERNAL_CONTEXT_GUIDANCE =
  'Internal context: hidden historical observations from prior tool results in this conversation. They were not sent to Telegram users. Use them only for reference resolution such as “the second one” or “the one you just listed”. They are not the current database authority; before any side-effecting action, re-check the live tool/backend state. Do not quote or expose internal IDs to the user unless another tool explicitly requires them.';

type MessageSnapshot = Static<typeof MessageSnapshotSchema>;

interface InvocationMessageRow {
  readonly section: 'history' | 'new';
  readonly conversation_id: bigint;
  readonly message_thread_id: bigint;
  readonly sequence_no: bigint;
  readonly message_id: bigint;
  readonly revision_id: bigint;
  readonly snapshot_json: string;
}

interface InvocationIdentityRow {
  readonly conversation_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly message_thread_id: bigint;
  readonly chat_type: string;
  readonly bucket_kind: 'realtime' | 'startup_catch_up';
}
interface StickerCatalogRow {
  readonly id: bigint;
  readonly emoji: string | null;
}

interface AlarmIdentityRow {
  readonly id: bigint;
  readonly target_user_id: bigint;
  readonly target_display_name: string;
  readonly summary: string;
}

interface SenderIdentityRow {
  readonly message_id: bigint;
  readonly telegram_id: bigint;
  readonly display_name: string;
  readonly username: string | null;
}

export interface ContextIdentity {
  readonly invocationId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  readonly chatType: string;
  readonly bucketKind: 'realtime' | 'startup_catch_up';
  readonly alarm: AlarmContext | null;
  readonly timezone: string;
}

export interface StablePrompt {
  readonly systemPrompt: string;
  readonly systemPromptHash: string;
}

export interface InjectionInput {
  readonly header: ContextHeader;
  readonly identity: ContextIdentity;
  readonly bucketId: bigint;
  /** Sequence number the injection message will occupy in the canonical history. */
  readonly seq: bigint;
  /**
   * Telegram message IDs already carried by the retained transcript. History
   * rows for them are not re-rendered — the transcript *is* the history. Rows
   * that were never injected (a message blocked by a participation gate, for
   * example) still have to be rendered, or the model would never see them.
   */
  readonly injectedMessageIds: ReadonlySet<string>;
  readonly sleepy: boolean;
  readonly supportsImages: boolean;
  readonly contextWindow: number;
  readonly toolDefinitionCharacters: number;
  readonly maxOutputTokens: number;
  /** Estimated characters already held by the retained transcript. */
  readonly transcriptCharacters: number;
  /**
   * The newest sticker catalog the retained transcript already carries, or `null`.
   * The catalog is rendered only when it differs: it is the same few hundred
   * characters on every batch, and each copy lands in the canonical history, so
   * a long-lived run used to accumulate one copy per injection.
   */
  readonly carriedStickerCatalog: string | null;
  readonly agentModel: PromptTemplateModel;
  readonly now?: Date;
}

export interface Injection {
  readonly text: string;
  readonly directImages: readonly DirectImage[];
  /** `img_` reference of this batch mapped to the media row it authorizes. */
  readonly mediaRefs: ReadonlyMap<string, bigint>;
  readonly visibleSenders: readonly VisibleSender[];
  readonly callerUserId: bigint | null;
  readonly omittedNewMessages: number;
  readonly messageCount: number;
  readonly historyCount: number;
  /** The current catalog, whether or not this batch had to render it. */
  readonly stickerCatalog: string;
}

export class ContextBuilder {
  readonly #store: SqliteStore;
  readonly #memory: MemoryStore;
  readonly #skills: readonly SystemSkill[];
  readonly #refs: ContextRefStore;

  constructor(store: SqliteStore, refs: ContextRefStore, skills: readonly SystemSkill[] = []) {
    this.#store = store;
    this.#memory = new MemoryStore(store.orm);
    this.#refs = refs;
    this.#skills = skills;
  }

  identity(config: RawConfig, invocationId: bigint): ContextIdentity {
    const identity = this.#store.db
      .prepare<[bigint], InvocationIdentityRow>(
        `SELECT i.conversation_id, c.telegram_chat_id, v.message_thread_id, c.type AS chat_type,
                b.kind AS bucket_kind
         FROM invocations i
         JOIN buckets b ON b.id = i.bucket_id
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         WHERE i.id = ?`,
      )
      .get(invocationId);
    if (identity === undefined) {
      throw new Error(`Invocation ${invocationId} does not exist`);
    }
    const chatConfig = resolveChatConfig(config, this.#store.orm, identity.telegram_chat_id);
    if (chatConfig === undefined) {
      throw new Error(`Invocation chat ${identity.telegram_chat_id} is no longer configured`);
    }
    const alarmIdentity = this.#store.db
      .prepare<[bigint], AlarmIdentityRow>(
        'SELECT id, target_user_id, target_display_name, summary FROM alarms WHERE invocation_id = ?',
      )
      .get(invocationId);
    return {
      invocationId,
      conversationId: identity.conversation_id,
      chatId: identity.telegram_chat_id,
      threadId: identity.message_thread_id,
      chatType: identity.chat_type,
      bucketKind: identity.bucket_kind,
      alarm:
        alarmIdentity === undefined
          ? null
          : {
              userId: alarmIdentity.target_user_id,
              displayName: alarmIdentity.target_display_name,
              summary: alarmIdentity.summary,
            },
      timezone: chatConfig.timezone ?? config.timezone,
    };
  }

  /**
   * The stable part of the prompt: everything that may live for the whole
   * Conversation Context. Anything that changes per invocation (time, memory,
   * internal context, sleep state, alarm task, catch-up note) is rendered by
   * `renderInjection` instead, because a changing system prompt invalidates the
   * context and the provider prefix cache every run.
   */
  buildSystemPrompt(
    config: RawConfig,
    identity: ContextIdentity,
    supportsImages: boolean,
    agentModel: PromptTemplateModel,
  ): StablePrompt {
    const chatConfig = resolveChatConfig(config, this.#store.orm, identity.chatId);
    if (chatConfig === undefined) {
      throw new Error(`Invocation chat ${identity.chatId} is no longer configured`);
    }
    const templateValues: PromptTemplateValues = {
      agent: agentModel,
      vision: { provider: config.vision.provider, model: config.vision.model },
      timezone: identity.timezone,
    };
    const conversationMode =
      identity.chatType === 'private' ? 'Conversation mode: private chat.' : 'Conversation mode: group chat.';
    const imageHandling = supportsImages
      ? 'Photos and supported image Documents from the newest injected messages are attached directly to the multimodal Agent input, in the same order as the [kind figure_N] media lines inside the messages. Treat each attached image as the media of the message that lists the matching figure_N. Older images are not attached; inspect them on demand with the read_image capability (called via execute) using their img_ refs. read_image never accepts figure_N refs.'
      : 'Telegram images and Stickers are available through the read_image capability (called via execute). Call it when visual details are needed.';
    const stickerCatalog = this.#stickerCatalog();
    const stickerCatalogHandling =
      stickerCatalog.length === 0
        ? ''
        : 'An untrusted sticker catalog is included as sticker_id:emoji entries. Emoji is only a coarse hint. To inspect one or more candidates and authorize sending, call the search_stickers capability via execute with ids; use only the returned sticker_ref with send. search_stickers also supports semantic queries.';
    // Everything in this array is hashed below, so a change to the skill index or
    // to the sticker catalog's presence restarts each Conversation Context on its
    // next invocation.
    const systemPrompt = [
      CORE_AGENT_PROTOCOL,
      renderSkillIndexPrompt(this.#skills),
      imageHandling,
      stickerCatalogHandling,
      renderPromptTemplate(config.agent.system_prompt, templateValues),
      conversationMode,
      MEMORY_GUIDANCE,
      INTERNAL_CONTEXT_GUIDANCE,
      renderPromptTemplate(chatConfig.instructions, templateValues),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');
    return {
      systemPrompt,
      systemPromptHash: createHash('sha256').update(systemPrompt).digest('hex'),
    };
  }

  /**
   * Renders one injected batch: a trusted runtime-state block followed by the
   * untrusted Telegram snapshots of exactly this batch. The retained transcript
   * is not replayed — except for history rows that never reached it (a message
   * blocked by a participation gate, for example), which are the only way the
   * model can still see them.
   */
  renderInjection(config: RawConfig, input: InjectionInput): Injection {
    const { identity } = input;
    const now = input.now ?? new Date();
    const rows = this.#store.db
      .prepare<[bigint, bigint], InvocationMessageRow>(
        `SELECT im.section, im.sequence_no, im.message_id, im.revision_id, im.snapshot_json,
                m.conversation_id, v.message_thread_id
         FROM invocation_messages im
         JOIN messages m ON m.id = im.message_id
         JOIN conversations v ON v.id = m.conversation_id
         WHERE im.invocation_id = ? AND (im.source_bucket_id = ? OR im.section = 'history')
         ORDER BY im.sequence_no`,
      )
      .all(identity.invocationId, input.bucketId);
    const senderRows = this.#store.db
      .prepare<[bigint], SenderIdentityRow>(
        `SELECT im.message_id, s.telegram_id, s.display_name, s.username
         FROM invocation_messages im
         JOIN message_revisions r ON r.id = im.revision_id
         JOIN senders s ON s.id = r.sender_id
         WHERE im.invocation_id = ? AND s.telegram_type = 'user'`,
      )
      .all(identity.invocationId);
    const senderByMessage = new Map<string, VisibleSender>();
    for (const sender of senderRows) {
      senderByMessage.set(sender.message_id.toString(), {
        userId: sender.telegram_id,
        displayName: sender.display_name,
        username: sender.username,
      });
    }
    const mediaIds = new Map<string, bigint>();
    const prepared = rows.map((row) => ({
      section: row.section,
      messageId: row.message_id,
      snapshot: this.#prepareSnapshot(row.snapshot_json, input.header, input.seq, mediaIds, now),
      target: { conversationId: row.conversation_id, threadId: row.message_thread_id },
    }));
    const stickerCatalog = this.#stickerCatalog();
    const renderStickerCatalog = stickerCatalog.length > 0 && stickerCatalog !== input.carriedStickerCatalog;
    const maximumCharacters = Math.max(
      1_024,
      Math.floor(input.contextWindow * 4 * config.agent.context_stop_ratio) -
        input.toolDefinitionCharacters -
        input.maxOutputTokens * 4 -
        input.transcriptCharacters,
    );
    const current = prepared.filter((entry) => entry.section === 'new');
    const history = prepared.filter(
      (entry) => entry.section === 'history' && !input.injectedMessageIds.has(entry.snapshot.message_id),
    );
    const selectedCurrent: typeof current = [];
    let usedCharacters = 0;
    const format = (snapshot: PreparedSnapshot, inlineReplies: ReadonlySet<string>): string =>
      formatSnapshot(snapshot, {
        timezone: identity.timezone,
        now,
        showTopic: identity.bucketKind === 'startup_catch_up',
        inlineReplies,
      });
    const noInlineReplies = new Set<string>();
    for (const entry of current.toReversed()) {
      const size = format(entry.snapshot, noInlineReplies).length + 1;
      if (selectedCurrent.length > 0 && usedCharacters + size > maximumCharacters) {
        break;
      }
      selectedCurrent.unshift(entry);
      usedCharacters += size;
    }
    const selectedHistory: typeof history = [];
    for (const entry of history.toReversed()) {
      const size = format(entry.snapshot, noInlineReplies).length + 1;
      if (usedCharacters + size > maximumCharacters) {
        break;
      }
      selectedHistory.unshift(entry);
      usedCharacters += size;
    }
    const omittedNewMessages = current.length - selectedCurrent.length;
    // A reply to a message rendered in this same batch needs no quoted copy of it.
    const inlineReplies = new Set([...selectedHistory, ...selectedCurrent].map((entry) => entry.snapshot.message_id));
    // Attachments belong to the newest batch only: the model receives them once,
    // paired with figure_N markers rendered inside that batch's messages.
    // Older images stay reachable through their stable img_ refs.
    const orderedFigureMedia: { imageRef: string; originalRef: string }[] = [];
    let nextFigureNumber = 1;
    const renderSnapshot = (entry: (typeof prepared)[number]): string => {
      if (entry.section !== 'new') {
        return format(entry.snapshot, inlineReplies);
      }
      this.#refs.replyRef(input.header, BigInt(entry.snapshot.message_id), entry.target, input.seq, now);
      const snapshot = entry.snapshot;
      if (!input.supportsImages || snapshot.media.length === 0) {
        return format(snapshot, inlineReplies);
      }
      const rendered = {
        ...snapshot,
        media: snapshot.media.map((media) => {
          if (media.kind === 'sticker') {
            return media;
          }
          const imageRef = `figure_${nextFigureNumber++}`;
          orderedFigureMedia.push({ imageRef, originalRef: media.image_ref });
          return { ...media, image_ref: imageRef };
        }),
      };
      return format(rendered, inlineReplies);
    };
    const historyText = selectedHistory.map(renderSnapshot).join('\n');
    const currentText = selectedCurrent.map(renderSnapshot).join('\n');
    const omission =
      omittedNewMessages === 0 ? '' : `[${omittedNewMessages} earlier new messages omitted to fit the model context]\n`;
    const runtimeState = [
      `current_time: ${this.#renderCurrentTime(identity.timezone, now)}`,
      ...(input.sleepy ? [SLEEP_STATE_PROMPT] : []),
      ...(identity.alarm === null ? [] : [this.#alarmTask(identity.alarm)]),
      ...(identity.bucketKind === 'startup_catch_up'
        ? [
            "Startup catch-up: these are the latest configured number of messages across this chat and may span forum topics. Each message header includes its forum topic as topic:N. When responding to a specific topic, reply to a visible message from that topic; an un-replied send targets the newest message's topic.",
          ]
        : []),
      this.#memoryPrompt(identity.conversationId),
      this.#internalContextPrompt(identity.conversationId),
    ]
      .filter((part) => part.length > 0)
      .join('\n');
    const text = [
      '<runtime_state>',
      runtimeState,
      '</runtime_state>',
      ...(!renderStickerCatalog ? [] : ['<untrusted_sticker_catalog>', stickerCatalog, '</untrusted_sticker_catalog>']),
      ...(historyText.length === 0
        ? []
        : ['<untrusted_telegram_history>', historyText, '</untrusted_telegram_history>']),
      '<untrusted_new_messages>',
      `${omission}${currentText}`,
      '</untrusted_new_messages>',
    ].join('\n');
    const selected = [...selectedHistory, ...selectedCurrent];
    const visibleSenders = new Map<string, VisibleSender>();
    for (const entry of selected) {
      const sender = senderByMessage.get(entry.messageId.toString());
      if (sender !== undefined) {
        visibleSenders.set(sender.userId.toString(), sender);
      }
    }
    const callerUserId =
      [...selectedCurrent]
        .toReversed()
        .map((entry) => senderByMessage.get(entry.messageId.toString())?.userId ?? null)
        .find((userId) => userId !== null) ?? null;
    const directImages = input.supportsImages
      ? orderedFigureMedia.flatMap((media) => {
          const mediaId = mediaIds.get(media.originalRef);
          if (mediaId === undefined) {
            throw new Error('Selected media is missing its capability reference');
          }
          return [{ mediaId, imageRef: media.imageRef }];
        })
      : [];
    return {
      text,
      directImages,
      mediaRefs: mediaIds,
      visibleSenders: [...visibleSenders.values()],
      callerUserId,
      omittedNewMessages,
      messageCount: selected.length,
      historyCount: selectedHistory.length,
      stickerCatalog,
    };
  }

  #renderCurrentTime(timezone: string, now: Date): string {
    return `${new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long',
      hourCycle: 'h23',
    }).format(now)} (${timezone})`;
  }

  /**
   * Rebuilds the senders visible in a retained injection batch. This only reads
   * back the message headers `renderInjection` wrote; it keeps alarm targets working after the agent cache was evicted or
   * the process restarted.
   */
  static collectVisibleSenders(text: string): VisibleSender[] {
    const senders = new Map<string, VisibleSender>();
    for (const snapshot of parseSnapshotLines(text)) {
      const sender = snapshot.sender;
      if (sender.id === null) {
        continue;
      }
      senders.set(sender.id, {
        userId: BigInt(sender.id),
        displayName: sender.name,
        username: sender.username,
      });
    }
    return [...senders.values()];
  }

  /**
   * The sticker catalog a transcript batch carries, or `null`. The block is
   * runtime-written with literal newlines around it; Telegram text only ever
   * appears on indented body lines, so it cannot forge the block.
   */
  static collectStickerCatalog(text: string): string | null {
    const matches = [...text.matchAll(/<untrusted_sticker_catalog>\n([^\n]*)\n<\/untrusted_sticker_catalog>/g)];
    return matches.at(-1)?.[1] ?? null;
  }

  /**
   * Telegram message IDs already carried by a transcript batch. Used to skip
   * re-rendering history the transcript already holds.
   */
  static collectInjectedMessageIds(text: string): string[] {
    return [...new Set(parseSnapshotLines(text).map((snapshot) => snapshot.message_id))];
  }

  #alarmTask(alarm: AlarmContext): string {
    return `This invocation was triggered by an alarm you scheduled earlier.\n\nImmediate task: follow up with Telegram user ${alarm.userId.toString()} (display name: ${alarm.displayName}) in this conversation.\n\nContext for why you scheduled this alarm (this is a task description, NOT the message text to send):\n${alarm.summary}\n\nMention the target user and handle this naturally using your normal conversational style. Do not explain the alarm or scheduling mechanism unless it is actually relevant.`;
  }

  #stickerCatalog(): string {
    return this.#store.db
      .prepare<[], StickerCatalogRow>(
        `SELECT s.id, s.emoji
         FROM stickers s
         JOIN sticker_sets ss ON ss.id = s.sticker_set_id
         WHERE s.active = 1 AND s.index_state = 'success' AND ss.configured = 1
         ORDER BY s.id`,
      )
      .all()
      .map((sticker) => `${sticker.id}:${sticker.emoji ?? '∅'}`)
      .join(' ');
  }

  #memoryPrompt(conversationId: bigint): string {
    const memories = this.#memory.listActive(conversationId, new Date());
    return ['<memory_list>', ...memories.map((entry) => `- ${entry.id}: ${entry.content}`), '</memory_list>'].join(
      '\n',
    );
  }

  #internalContextPrompt(conversationId: bigint): string {
    const records = listRecentInternalContexts(this.#store.orm, conversationId, INTERNAL_CONTEXT_LIMIT).reverse();
    return renderInternalContextsPrompt(records);
  }

  /**
   * Rewrites media snapshots into stable, context-scoped `img_` references.
   * References are created once and reused while they live, so retained history
   * keeps the same tokens instead of re-minting them on every invocation.
   */
  #prepareSnapshot(
    json: string,
    header: ContextHeader,
    sourceSeq: bigint,
    mediaIds: Map<string, bigint>,
    now: Date,
  ): PreparedSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('Stored invocation message contains invalid JSON');
    }
    if (!snapshotValidator.Check(parsed)) {
      throw new Error('Stored invocation message does not match its schema');
    }
    const media = parsed.media.map((entry) => {
      const mediaId = BigInt(entry.id);
      const reference = this.#refs.mediaRef(header, mediaId, sourceSeq, now);
      mediaIds.set(reference, mediaId);
      return {
        image_ref: reference,
        kind: entry.kind,
        mime_type: entry.mime_type,
        width: entry.width,
        height: entry.height,
      };
    });
    return {
      message_id: parsed.message_id,
      ...(parsed.message_thread_id === undefined ? {} : { message_thread_id: parsed.message_thread_id }),
      telegram_date: parsed.telegram_date,
      sent_by_bot: parsed.sent_by_bot,
      sender: parsed.sender,
      kind: parsed.kind,
      text: parsed.text,
      caption: parsed.caption,
      reply_to_message_id: parsed.reply_to_message_id,
      reply_snapshot: parsed.reply_snapshot,
      forward_origin: parsed.forward_origin,
      media_group_id: parsed.media_group_id,
      media,
    };
  }
}

interface PreparedSnapshot extends Omit<MessageSnapshot, 'revision' | 'media'> {
  readonly media: readonly {
    readonly image_ref: string;
    readonly kind: string;
    readonly mime_type: string | null;
    readonly width: string | null;
    readonly height: string | null;
  }[];
}

interface FormatOptions {
  readonly timezone: string;
  readonly now: Date;
  readonly showTopic: boolean;
  /** Message IDs rendered in the same batch; replies to them skip the quote. */
  readonly inlineReplies: ReadonlySet<string>;
}

interface ReplySnapshot {
  readonly sender: string;
  readonly content: string;
}

/**
 * Renders one Telegram snapshot as a compact header plus indented body:
 *
 *   [156063 23:09:39 re:156048 uid:6869211498 @aac6fef] 雨夹雪
 *     > Mio Akiyama: 我去
 *     超级优质客户
 *
 * The bracket holds only runtime-controlled tokens and the display name follows
 * it on a single line. Every Telegram-controlled line is indented, so no message
 * content can forge a header, a runtime block tag, or a readback line.
 */
function formatSnapshot(snapshot: PreparedSnapshot, options: FormatOptions): string {
  const tokens = [snapshot.message_id, formatTime(snapshot.telegram_date, options.timezone, options.now)];
  if (options.showTopic && snapshot.message_thread_id !== undefined) {
    tokens.push(`topic:${snapshot.message_thread_id}`);
  }
  if (snapshot.sent_by_bot) {
    tokens.push('you');
  }
  if (snapshot.reply_to_message_id !== null) {
    tokens.push(`re:${snapshot.reply_to_message_id}`);
  }
  if (snapshot.sender.id !== null) {
    tokens.push(`uid:${snapshot.sender.id}`);
  }
  if (snapshot.sender.username !== null && USERNAME.test(snapshot.sender.username)) {
    tokens.push(`@${snapshot.sender.username}`);
  }
  const body: string[] = [];
  const forwardedFrom = forwardOriginName(snapshot.forward_origin);
  if (forwardedFrom !== null) {
    body.push(`(forwarded from ${singleLine(forwardedFrom)})`);
  }
  const reply = replySnapshot(snapshot.reply_snapshot);
  if (
    reply !== null &&
    snapshot.reply_to_message_id !== null &&
    !options.inlineReplies.has(snapshot.reply_to_message_id)
  ) {
    body.push(`> ${singleLine(reply.sender)}: ${singleLine(reply.content)}`);
  }
  for (const content of [snapshot.text, snapshot.caption]) {
    if (content !== null) {
      body.push(...content.split('\n'));
    }
  }
  for (const media of snapshot.media) {
    const size = media.width === null || media.height === null ? '' : ` ${media.width}x${media.height}`;
    body.push(`[${media.kind} ${media.image_ref}${size}]`);
  }
  if (body.length === 0) {
    body.push(`[${snapshot.kind}]`);
  }
  const name = singleLine(snapshot.sender.name ?? 'unknown');
  return [`[${tokens.join(' ')}] ${name}`, ...body.map((line) => `  ${line}`)].join('\n');
}

const USERNAME = /^[A-Za-z0-9_]+$/;
const HEADER = /^\[([1-9][0-9]*) ([^\]\n]*)\] (.*)$/;

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Chat-local time; the date is shown only when it differs from the batch's current date. */
function formatTime(iso: string, timezone: string, now: Date): string {
  const parts = (date: Date): Record<string, string> =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  const at = parts(new Date(iso));
  const today = parts(now);
  const time = `${at.hour}:${at.minute}:${at.second}`;
  return at.year === today.year && at.month === today.month && at.day === today.day
    ? time
    : `${at.year}-${at.month}-${at.day}T${time}`;
}

function replySnapshot(value: unknown): ReplySnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { sender, content } = value as Record<string, unknown>;
  return typeof sender === 'string' && typeof content === 'string' ? { sender, content } : null;
}

/** The display name of a Telegram MessageOrigin, stored verbatim from the Bot API. */
function forwardOriginName(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const origin = value as Record<string, unknown>;
  const title = (chat: unknown): string | null => {
    const value = typeof chat === 'object' && chat !== null ? (chat as Record<string, unknown>).title : undefined;
    return typeof value === 'string' ? value : null;
  };
  switch (origin.type) {
    case 'user': {
      const user = origin.sender_user;
      if (typeof user !== 'object' || user === null) {
        return null;
      }
      const { first_name: first, last_name: last } = user as Record<string, unknown>;
      return [first, last].filter((part): part is string => typeof part === 'string').join(' ') || null;
    }
    case 'hidden_user':
      return typeof origin.sender_user_name === 'string' ? origin.sender_user_name : null;
    case 'chat':
      return title(origin.sender_chat);
    case 'channel':
      return title(origin.chat);
    default:
      return 'unknown';
  }
}

interface RenderedHeader {
  readonly message_id: string;
  readonly sender: { readonly id: string | null; readonly name: string; readonly username: string | null };
}

/**
 * Reads back the message headers `renderInjection` wrote into a batch. Only
 * lines after the last `</runtime_state>` line count: the runtime block quotes
 * model- and tool-authored text, while every Telegram-authored line below it is
 * indented and can never match a header.
 */
function parseSnapshotLines(text: string): RenderedHeader[] {
  const lines = text.split('\n');
  const start = lines.lastIndexOf('</runtime_state>') + 1;
  const headers: RenderedHeader[] = [];
  for (const line of lines.slice(start)) {
    const match = HEADER.exec(line);
    if (match === null) {
      continue;
    }
    const [, messageId = '', bracket = '', name = ''] = match;
    const tokens = bracket.split(' ');
    const uid = tokens.find((token) => /^uid:[0-9]+$/.test(token));
    const username = tokens.find((token) => token.startsWith('@'));
    headers.push({
      message_id: messageId,
      sender: {
        id: uid === undefined ? null : uid.slice(4),
        name,
        username: username === undefined ? null : username.slice(1),
      },
    });
  }
  return headers;
}

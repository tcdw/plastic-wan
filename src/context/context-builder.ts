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

/**
 * The shape that actually reaches the model: no `revision`, and media carry a
 * capability `image_ref` instead of the internal media id. Reading a rendered
 * batch back (visible senders, already-injected message IDs) must validate
 * against this, not the stored-snapshot schema.
 */
const RenderedSnapshotSchema = Type.Object(
  {
    message_id: Type.String(),
    message_thread_id: Type.Optional(Type.String()),
    telegram_date: Type.String(),
    sent_by_bot: Type.Boolean(),
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
    media: Type.Array(Type.Object({ image_ref: Type.String() }, { additionalProperties: true })),
  },
  Strict,
);
const renderedSnapshotValidator = Compile(RenderedSnapshotSchema);
const INTERNAL_CONTEXT_LIMIT = 8;

/**
 * Runtime sleep state. Stated inside the newest injected batch instead of the
 * system prompt: the system prompt must stay byte-identical for the whole
 * Conversation Context, and a state block at the tail of the conversation is
 * also closer to the generation point than a system-prompt line ever was. Keep
 * the wording in natural sleep terms; never expose token, budget, or quota
 * details.
 */
export const SLEEP_STATE_PROMPT = `Sleep state: you are very sleepy now, and today's energy is almost spent. Once it runs out you cannot answer anyone here until the next daily reset, so staying awake only buys a few more replies. Sleeping is the expected outcome in this state, not a failure, and a short good-night with send before zzz is fine when it fits. Call zzz as soon as the current conversation has nothing unfinished that needs you, including whenever you were going to stay silent anyway; never use it to drop an unfinished user request.`;

const MEMORY_GUIDANCE =
  'Memory: short-term notes you deliberately saved for this conversation with the add_memory capability (called via execute). Keep each note under 100 characters; the hard limit is 150. Notes expire after their TTL (1 day by default). Delete wrong or obsolete notes with the delete_memory capability. Setting a long TTL nominates stable knowledge for human review; durable rules live in agents.md and are curated by humans.';

const INTERNAL_CONTEXT_GUIDANCE =
  'Internal context: hidden historical observations from prior tool results in this conversation. They were not sent to Telegram users. Use them only for reference resolution such as “the second one” or “the one you just listed”. They are not the current database authority; before any side-effecting action, re-check the live tool/backend state. Do not quote or expose internal IDs to the user unless another tool explicitly requires them.';

type MessageSnapshot = Static<typeof MessageSnapshotSchema>;
type RenderedSnapshot = Static<typeof RenderedSnapshotSchema>;

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
}

export class ContextBuilder {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #memory: MemoryStore;
  readonly #skills: readonly SystemSkill[];
  readonly #refs: ContextRefStore;

  constructor(store: SqliteStore, config: RawConfig, refs: ContextRefStore, skills: readonly SystemSkill[] = []) {
    this.#store = store;
    this.#config = config;
    this.#memory = new MemoryStore(store.orm);
    this.#refs = refs;
    this.#skills = skills;
  }

  /** Resolves the Conversation identity and alarm context of one invocation. */
  identity(invocationId: bigint): ContextIdentity {
    const identity = this.#store.db
      .query<InvocationIdentityRow, [bigint]>(
        `SELECT i.conversation_id, c.telegram_chat_id, v.message_thread_id, c.type AS chat_type,
                b.kind AS bucket_kind
         FROM invocations i
         JOIN buckets b ON b.id = i.bucket_id
         JOIN conversations v ON v.id = i.conversation_id
         JOIN chats c ON c.id = v.chat_id
         WHERE i.id = ?`,
      )
      .get(invocationId);
    if (identity === null) {
      throw new Error(`Invocation ${invocationId} does not exist`);
    }
    const chatConfig = resolveChatConfig(this.#config, this.#store.orm, identity.telegram_chat_id);
    if (chatConfig === undefined) {
      throw new Error(`Invocation chat ${identity.telegram_chat_id} is no longer configured`);
    }
    const alarmIdentity = this.#store.db
      .query<AlarmIdentityRow, [bigint]>(
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
        alarmIdentity === null
          ? null
          : {
              userId: alarmIdentity.target_user_id,
              displayName: alarmIdentity.target_display_name,
              summary: alarmIdentity.summary,
            },
      timezone: chatConfig.timezone ?? this.#config.timezone,
    };
  }

  /**
   * The stable part of the prompt: everything that may live for the whole
   * Conversation Context. Anything that changes per invocation (time, memory,
   * internal context, sleep state, alarm task, catch-up note) is rendered by
   * `renderInjection` instead, because a changing system prompt invalidates the
   * context and the provider prefix cache every run.
   */
  buildSystemPrompt(identity: ContextIdentity, supportsImages: boolean, agentModel: PromptTemplateModel): StablePrompt {
    const chatConfig = resolveChatConfig(this.#config, this.#store.orm, identity.chatId);
    if (chatConfig === undefined) {
      throw new Error(`Invocation chat ${identity.chatId} is no longer configured`);
    }
    const templateValues: PromptTemplateValues = {
      agent: agentModel,
      vision: { provider: this.#config.vision.provider, model: this.#config.vision.model },
      timezone: identity.timezone,
    };
    const conversationMode =
      identity.chatType === 'private'
        ? 'Conversation mode: private chat.'
        : 'Conversation mode: group chat. Silence is preferred unless the new messages warrant a useful response.';
    const imageHandling = supportsImages
      ? 'Photos and supported image Documents from the newest injected messages are attached directly to the multimodal Agent input, in the same order as the figure_N image_ref entries inside the message JSON. Treat each attached image as the media of the message whose JSON references the matching figure_N. Older images are not attached; inspect them on demand with the read_image capability (called via execute) using their img_ refs. read_image never accepts figure_N refs.'
      : 'Telegram images and Stickers are available through the read_image capability (called via execute). Call it when visual details are needed.';
    const stickerCatalog = this.#stickerCatalog();
    const stickerCatalogHandling =
      stickerCatalog.length === 0
        ? ''
        : 'An untrusted sticker catalog is included as sticker_id:emoji entries. Emoji is only a coarse hint. To inspect one or more candidates and authorize sending, call the search_stickers capability via execute with ids; use only the returned sticker_ref with send. search_stickers also supports semantic queries.';
    const systemPrompt = [
      CORE_AGENT_PROTOCOL,
      renderSkillIndexPrompt(this.#skills),
      imageHandling,
      stickerCatalogHandling,
      renderPromptTemplate(this.#config.agent.system_prompt, templateValues),
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
  renderInjection(input: InjectionInput): Injection {
    const { identity } = input;
    const now = input.now ?? new Date();
    const rows = this.#store.db
      .query<InvocationMessageRow, [bigint, bigint]>(
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
      .query<SenderIdentityRow, [bigint]>(
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
    const maximumCharacters = Math.max(
      1_024,
      Math.floor(input.contextWindow * 4 * this.#config.agent.context_stop_ratio) -
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
    for (const entry of current.toReversed()) {
      const size = JSON.stringify(entry.snapshot).length + 1;
      if (selectedCurrent.length > 0 && usedCharacters + size > maximumCharacters) {
        break;
      }
      selectedCurrent.unshift(entry);
      usedCharacters += size;
    }
    const selectedHistory: typeof history = [];
    for (const entry of history.toReversed()) {
      const size = JSON.stringify(entry.snapshot).length + 1;
      if (usedCharacters + size > maximumCharacters) {
        break;
      }
      selectedHistory.unshift(entry);
      usedCharacters += size;
    }
    const omittedNewMessages = current.length - selectedCurrent.length;
    // Attachments belong to the newest batch only: the model receives them once,
    // paired with figure_N markers rendered inside that batch's message JSON.
    // Older images stay reachable through their stable img_ refs.
    const orderedFigureMedia: { imageRef: string; originalRef: string }[] = [];
    let nextFigureNumber = 1;
    const renderSnapshot = (entry: (typeof prepared)[number]): string => {
      if (entry.section !== 'new') {
        return JSON.stringify(entry.snapshot);
      }
      this.#refs.replyRef(input.header, BigInt(entry.snapshot.message_id), entry.target, input.seq, now);
      const snapshot = entry.snapshot;
      if (!input.supportsImages || snapshot.media.length === 0) {
        return JSON.stringify(snapshot);
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
      return JSON.stringify(rendered);
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
            "Startup catch-up: these are the latest configured number of messages across this chat and may span forum topics. Each new message includes message_thread_id. When responding to a specific topic, reply to a visible message from that topic; an un-replied send targets the newest message's topic.",
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
      ...(stickerCatalog.length === 0
        ? []
        : ['<untrusted_sticker_catalog>', stickerCatalog, '</untrusted_sticker_catalog>']),
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
   * Rebuilds the senders visible in a retained injection batch. The batch text
   * is runtime-generated JSON, so this only reads back what `renderInjection`
   * wrote; it keeps alarm targets working after the agent cache was evicted or
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
        displayName: sender.name ?? '',
        username: sender.username,
      });
    }
    return [...senders.values()];
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
      .query<StickerCatalogRow, []>(
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

/** Reads back the message-JSON lines `renderInjection` wrote into a batch. */
function parseSnapshotLines(text: string): RenderedSnapshot[] {
  const snapshots: RenderedSnapshot[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"message_id"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (renderedSnapshotValidator.Check(parsed)) {
      snapshots.push(parsed);
    }
  }
  return snapshots;
}

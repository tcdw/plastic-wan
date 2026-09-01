import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { and, eq, lt, sql } from 'drizzle-orm';
import { GrammyError, HttpError } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import Type, { type Static } from 'typebox';
import type { InvocationContext } from '../platform/invocation-context.ts';
import { asRunResult, rejectToolCall, type SqliteStore } from '../store/database.ts';
import {
  chats,
  invocations,
  media,
  messageRevisions,
  messages,
  senders,
  stickers,
  telegramSends,
  toolCalls,
} from '../store/schema.ts';

export const SendInputSchema = Type.Object(
  {
    kind: Type.Optional(Type.Enum({ text: 'text', sticker: 'sticker' })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    parse_mode: Type.Optional(Type.Literal('MarkdownV2')),
    sticker_ref: Type.Optional(Type.String({ minLength: 1 })),
    reply_to_message_id: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  },
  { additionalProperties: false },
);

export type SendToolInput =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly parse_mode?: 'MarkdownV2';
      readonly reply_to_message_id?: string;
    }
  | { readonly kind: 'sticker'; readonly sticker_ref: string; readonly reply_to_message_id?: string };

function narrowSendInput(input: Static<typeof SendInputSchema>): SendToolInput | undefined {
  const kind = input.kind ?? (input.text !== undefined && input.sticker_ref === undefined ? 'text' : undefined);
  if (kind === undefined || (kind === 'sticker' && input.parse_mode !== undefined)) {
    return undefined;
  }
  const field = kind === 'text' ? ('text' as const) : ('sticker_ref' as const);
  if (input[field] === undefined) {
    return undefined;
  }
  const reply = input.reply_to_message_id === undefined ? {} : { reply_to_message_id: input.reply_to_message_id };
  const parseMode = kind === 'text' && input.parse_mode !== undefined ? { parse_mode: input.parse_mode } : {};
  return { kind, [field]: input[field], ...parseMode, ...reply } as SendToolInput;
}

interface TelegramSendResponse {
  readonly message_id: number;
  readonly date: number;
  readonly chat: { readonly id: number };
}

export interface TelegramSendApi {
  sendMessage(
    chatId: string,
    text: string,
    options: {
      readonly message_thread_id?: number;
      readonly parse_mode?: 'MarkdownV2';
      readonly reply_parameters?: { readonly message_id: number };
      readonly entities?: MessageEntity[];
    },
  ): Promise<TelegramSendResponse>;
  sendSticker(
    chatId: string,
    sticker: string,
    options: {
      readonly message_thread_id?: number;
      readonly reply_parameters?: { readonly message_id: number };
    },
  ): Promise<TelegramSendResponse>;
}

export interface SendToolEnvironment {
  readonly store: SqliteStore;
  readonly api: TelegramSendApi;
  readonly context: InvocationContext;
  readonly stickerCapabilities: ReadonlyMap<string, string>;
  readonly maxSends: number;
  readonly maxTextLength: number | undefined;
  readonly disallowBlankLines: boolean;
  readonly deadline: number;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
}

function alarmMention(
  alarm: InvocationContext['alarm'],
): { readonly text: string; readonly entity: MessageEntity; readonly url: string } | null {
  if (alarm === null) {
    return null;
  }
  const text = alarm.displayName.length > 0 ? `@${alarm.displayName}` : `@${alarm.userId.toString()}`;
  const url = `tg://user?id=${alarm.userId.toString()}`;
  return {
    text,
    url,
    entity: {
      type: 'text_link',
      offset: 0,
      length: text.length,
      url,
    },
  };
}

function escapeMarkdownV2LinkText(text: string): string {
  return text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, (character) => `\\${character}`);
}

export function createSendTool(
  environment: SendToolEnvironment,
): AgentTool<typeof SendInputSchema, { telegramMessageId: string }> {
  let firstTextSent = false;
  const textConstraints = [
    environment.maxTextLength === undefined
      ? 'Text must fit the schema limit.'
      : `Text must not exceed ${environment.maxTextLength} characters.`,
    environment.disallowBlankLines ? 'Text must not contain blank lines; use single newlines between paragraphs.' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  return {
    name: 'send',
    label: 'Send to Telegram',
    description: `Publish exactly one warranted user-visible Telegram message or sticker. Use this only after deciding the new messages or an alarm task require a reply, clarification, or confirmation; do not use it merely because the tool is available, to answer history-only content, or to publish private reasoning. Keep the message concise and self-contained. For text, kind may be omitted; omit parse_mode for plain text, or set parse_mode to MarkdownV2 only when the text is correctly escaped. ${textConstraints} For a sticker, kind must be sticker and sticker_ref must be a stk_ value returned by search_stickers in this invocation; img_ refs cannot be sent. Set reply_to_message_id only to a visible message, preferring the relevant new message. Success means Telegram accepted the send; if the tool fails or reports an unknown outcome, do not claim it was sent and do not blindly retry.`,
    parameters: SendInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const send = narrowSendInput(input);
      if (send === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'send_input_invalid');
        throw new Error('send input fields do not match its kind');
      }
      const replyTarget =
        send.reply_to_message_id === undefined
          ? undefined
          : environment.context.replyTargets.get(send.reply_to_message_id);
      if (send.reply_to_message_id !== undefined && replyTarget === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'reply_not_visible');
        throw new Error('reply_to_message_id is not visible in this invocation');
      }
      const targetConversationId = replyTarget?.conversationId ?? environment.context.conversationId;
      const targetThreadId = replyTarget?.threadId ?? environment.context.threadId;
      let mention: { readonly text: string; readonly entity: MessageEntity; readonly url: string } | null = null;
      let sendText = '';
      if (send.kind === 'text') {
        if (!firstTextSent) {
          mention = alarmMention(environment.context.alarm);
        }
        if (mention === null) {
          sendText = send.text;
        } else if (send.parse_mode === 'MarkdownV2') {
          // Telegram rejects `entities` together with `parse_mode`, so a
          // MarkdownV2 first contact encodes the target mention as an inline
          // `[text](tg://user?id=...)` link and keeps parse_mode intact.
          sendText = `[${escapeMarkdownV2LinkText(mention.text)}](${mention.url}) ${send.text}`;
        } else {
          sendText = `${mention.text} ${send.text}`;
        }
        if (environment.maxTextLength !== undefined && sendText.length > environment.maxTextLength) {
          recordRejectedSend(environment, toolCallId, input, 'send_text_too_long');
          throw new Error(
            `text length ${sendText.length} exceeds the configured limit of ${environment.maxTextLength} characters`,
          );
        }
        if (environment.disallowBlankLines && /\n[ \t]*\n/.test(sendText)) {
          recordRejectedSend(environment, toolCallId, input, 'send_blank_lines');
          throw new Error('text must not contain blank lines; separate paragraphs with single newlines');
        }
      }
      const stickerFileId = send.kind === 'sticker' ? environment.stickerCapabilities.get(send.sticker_ref) : undefined;
      if (send.kind === 'sticker' && stickerFileId === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'sticker_ref_not_authorized');
        throw new Error('sticker_ref was not returned by search_stickers in this invocation');
      }
      const pending = environment.store.transaction(() => {
        const now = new Date().toISOString();
        const createdToolCall = environment.store.orm
          .insert(toolCalls)
          .values({
            invocationId: environment.context.invocationId,
            toolCallId,
            toolName: 'send',
            argumentsJson: JSON.stringify(send),
            state: 'pending',
            sideEffect: true,
            createdAt: now,
          })
          .returning({ id: toolCalls.id })
          .get();
        if (createdToolCall === undefined) {
          throw new Error('tool_calls insert returned no row');
        }
        const toolId = createdToolCall.id;
        const quota = asRunResult(
          environment.store.orm
            .update(invocations)
            .set({ sendsUsed: sql`${invocations.sendsUsed} + 1`, sideEffectStarted: true })
            .where(
              and(
                eq(invocations.id, environment.context.invocationId),
                lt(invocations.sendsUsed, BigInt(environment.maxSends)),
              ),
            )
            .run(),
        );
        if (quota.changes === 0) {
          environment.store.orm
            .update(toolCalls)
            .set({ state: 'error', errorCode: 'send_limit', finishedAt: now })
            .where(eq(toolCalls.id, toolId))
            .run();
          return { toolId, sendId: null };
        }
        const createdSend = environment.store.orm
          .insert(telegramSends)
          .values({
            toolCallId: toolId,
            conversationId: targetConversationId,
            kind: send.kind,
            requestJson: JSON.stringify({ kind: send.kind, reply_to_message_id: send.reply_to_message_id ?? null }),
            state: 'pending',
            createdAt: now,
          })
          .returning({ id: telegramSends.id })
          .get();
        if (createdSend === undefined) {
          throw new Error('telegram_sends insert returned no row');
        }
        return { toolId, sendId: createdSend.id };
      });
      if (pending.sendId === null) {
        throw new Error(`send limit of ${environment.maxSends} reached`);
      }
      const sendId = pending.sendId;
      const options = {
        ...(targetThreadId === 0n ? {} : { message_thread_id: Number(targetThreadId) }),
        ...(send.reply_to_message_id === undefined
          ? {}
          : { reply_parameters: { message_id: Number(send.reply_to_message_id) } }),
        ...(send.kind === 'text' && send.parse_mode !== undefined ? { parse_mode: send.parse_mode } : {}),
        ...(send.kind === 'text' && mention !== null && send.parse_mode !== 'MarkdownV2'
          ? { entities: [mention.entity] }
          : {}),
      };
      const startedAt = performance.now();
      try {
        let response: TelegramSendResponse;
        while (true) {
          try {
            if (send.kind === 'text') {
              response = await environment.api.sendMessage(environment.context.chatId.toString(), sendText, options);
            } else if (stickerFileId !== undefined) {
              response = await environment.api.sendSticker(
                environment.context.chatId.toString(),
                stickerFileId,
                options,
              );
            } else {
              throw new Error('sticker_ref was not returned by search_stickers in this invocation');
            }
            break;
          } catch (error) {
            if (!(error instanceof GrammyError) || error.error_code !== 429) {
              throw error;
            }
            const retryAfter = error.parameters.retry_after;
            if (retryAfter === undefined || Date.now() + retryAfter * 1000 >= environment.deadline) {
              throw error;
            }
            await delay(retryAfter * 1000, undefined, { signal });
          }
        }
        environment.store.transaction(() => {
          const now = new Date().toISOString();
          environment.store.orm
            .update(toolCalls)
            .set({
              state: 'success',
              resultText: `telegram_message_id=${response.message_id}`,
              durationMs: BigInt(Math.round(performance.now() - startedAt)),
              finishedAt: now,
            })
            .where(eq(toolCalls.id, pending.toolId))
            .run();
          environment.store.orm
            .update(telegramSends)
            .set({
              state: 'success',
              telegramMessageId: BigInt(response.message_id),
              responseJson: JSON.stringify({ message_id: response.message_id }),
              finishedAt: now,
            })
            .where(eq(telegramSends.id, sendId))
            .run();
          recordOutgoingMessage(
            environment,
            response,
            send,
            stickerFileId ?? null,
            targetConversationId,
            sendText,
            now,
          );
        });
        if (mention !== null) {
          firstTextSent = true;
        }
        return {
          content: [{ type: 'text', text: `Sent Telegram message ${response.message_id}` }],
          details: { telegramMessageId: String(response.message_id) },
        };
      } catch (error) {
        const unknown = error instanceof HttpError || (error instanceof GrammyError && error.error_code >= 500);
        const errorCode =
          error instanceof GrammyError
            ? `telegram_${error.error_code}`
            : error instanceof HttpError
              ? 'telegram_network'
              : signal?.aborted
                ? 'aborted'
                : 'send_error';
        environment.store.transaction(() => {
          const now = new Date().toISOString();
          const state = unknown ? 'outcome_unknown' : 'error';
          environment.store.orm
            .update(toolCalls)
            .set({
              state,
              errorCode,
              durationMs: BigInt(Math.round(performance.now() - startedAt)),
              finishedAt: now,
            })
            .where(eq(toolCalls.id, pending.toolId))
            .run();
          environment.store.orm
            .update(telegramSends)
            .set({ state, errorCode, finishedAt: now })
            .where(eq(telegramSends.id, sendId))
            .run();
        });
        throw new Error(unknown ? 'Telegram send outcome is unknown' : `Telegram send failed: ${errorCode}`);
      }
    },
  };
}

function recordRejectedSend(
  environment: SendToolEnvironment,
  toolCallId: string,
  input: unknown,
  errorCode: string,
): void {
  rejectToolCall(
    environment.store.orm,
    environment.context.invocationId,
    toolCallId,
    'send',
    JSON.stringify(input),
    true,
    errorCode,
  );
}

function recordOutgoingMessage(
  environment: SendToolEnvironment,
  response: TelegramSendResponse,
  input: SendToolInput,
  stickerFileId: string | null,
  conversationId: bigint,
  sentText: string,
  recordedAt: string,
): void {
  environment.store.orm
    .insert(senders)
    .values({
      telegramType: 'user',
      telegramId: environment.bot.id,
      displayName: environment.bot.displayName,
      username: environment.bot.username,
      isBot: true,
      updatedAt: recordedAt,
    })
    .onConflictDoUpdate({
      target: [senders.telegramType, senders.telegramId],
      set: {
        displayName: sql`excluded.display_name`,
        username: sql`excluded.username`,
        isBot: true,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run();
  const sender = environment.store.orm
    .select({ id: senders.id })
    .from(senders)
    .where(and(eq(senders.telegramType, 'user'), eq(senders.telegramId, environment.bot.id)))
    .get();
  if (sender === undefined) {
    throw new Error('Bot sender row is missing after upsert');
  }
  const chat = environment.store.orm
    .select({ id: chats.id })
    .from(chats)
    .where(eq(chats.telegramChatId, environment.context.chatId))
    .get();
  if (chat === undefined) {
    throw new Error('Outgoing chat row does not exist');
  }
  const createdMessage = environment.store.orm
    .insert(messages)
    .values({
      conversationId,
      chatId: chat.id,
      telegramMessageId: BigInt(response.message_id),
      visible: true,
      sentByBot: true,
      telegramDate: new Date(response.date * 1000).toISOString(),
      receivedAt: recordedAt,
    })
    .returning({ id: messages.id })
    .get();
  if (createdMessage === undefined) {
    throw new Error('messages insert returned no row');
  }
  const messageId = createdMessage.id;
  const createdRevision = environment.store.orm
    .insert(messageRevisions)
    .values({
      messageId,
      revisionNo: 1n,
      senderId: sender.id,
      kind: input.kind,
      text: input.kind === 'text' ? sentText : null,
      replyToMessageId: input.reply_to_message_id === undefined ? null : BigInt(input.reply_to_message_id),
      createdAt: recordedAt,
      rawFragmentJson: JSON.stringify({ message_id: response.message_id, kind: input.kind }),
    })
    .returning({ id: messageRevisions.id })
    .get();
  if (createdRevision === undefined) {
    throw new Error('message_revisions insert returned no row');
  }
  const revisionId = createdRevision.id;
  environment.store.orm.update(messages).set({ currentRevisionId: revisionId }).where(eq(messages.id, messageId)).run();
  if (input.kind === 'sticker' && stickerFileId !== null) {
    const sticker = environment.store.orm
      .select({ fileUniqueId: stickers.fileUniqueId })
      .from(stickers)
      .where(eq(stickers.fileId, stickerFileId))
      .get();
    if (sticker !== undefined) {
      environment.store.orm
        .insert(media)
        .values({
          revisionId,
          kind: 'sticker',
          fileId: stickerFileId,
          fileUniqueId: sticker.fileUniqueId,
          mimeType: 'image/webp',
          telegramJson: JSON.stringify({ sent: true }),
        })
        .run();
    }
  }
}

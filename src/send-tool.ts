import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { GrammyError, HttpError } from 'grammy';
import Type, { type Static } from 'typebox';
import type { InvocationContext } from './context-builder.ts';
import type { SqliteStore } from './database.ts';

export const SendInputSchema = Type.Object(
  {
    kind: Type.Optional(Type.Enum({ text: 'text', sticker: 'sticker' })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    sticker_ref: Type.Optional(Type.String({ minLength: 1 })),
    reply_to_message_id: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  },
  { additionalProperties: false },
);

export type SendToolInput =
  | { readonly kind: 'text'; readonly text: string; readonly reply_to_message_id?: string }
  | { readonly kind: 'sticker'; readonly sticker_ref: string; readonly reply_to_message_id?: string };

function narrowSendInput(input: Static<typeof SendInputSchema>): SendToolInput | undefined {
  const kind = input.kind ?? (input.text !== undefined && input.sticker_ref === undefined ? 'text' : undefined);
  if (kind === undefined) return undefined;
  const field = kind === 'text' ? ('text' as const) : ('sticker_ref' as const);
  if (input[field] === undefined) return undefined;
  const reply = input.reply_to_message_id === undefined ? {} : { reply_to_message_id: input.reply_to_message_id };
  return { kind, [field]: input[field], ...reply } as SendToolInput;
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
      readonly reply_parameters?: { readonly message_id: number };
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
  readonly deadline: number;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
}

export function createSendTool(
  environment: SendToolEnvironment,
): AgentTool<typeof SendInputSchema, { telegramMessageId: string }> {
  return {
    name: 'send',
    label: 'Send to Telegram',
    description:
      "Send one plain-text message or one sticker to this invocation's Telegram chat. For plain text, kind may be omitted when text is the only content field. For a sticker send, kind MUST be sticker and sticker_ref MUST be a stk_ value returned by search_stickers in THIS invocation; the img_ image_ref values shown in the context are for read_image only and will be rejected. Reply targets must be visible in this invocation.",
    parameters: SendInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const send = narrowSendInput(input);
      if (send === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'send_input_invalid');
        throw new Error('send input is missing the field required by its kind');
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
      const stickerFileId = send.kind === 'sticker' ? environment.stickerCapabilities.get(send.sticker_ref) : undefined;
      if (send.kind === 'sticker' && stickerFileId === undefined) {
        recordRejectedSend(environment, toolCallId, input, 'sticker_ref_not_authorized');
        throw new Error('sticker_ref was not returned by search_stickers in this invocation');
      }
      const pending = environment.store.transaction(() => {
        const now = new Date().toISOString();
        const tool = environment.store.db
          .query(
            "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, created_at) VALUES (?, ?, 'send', ?, 'pending', 1, ?)",
          )
          .run(environment.context.invocationId, toolCallId, JSON.stringify(send), now);
        const toolId = BigInt(tool.lastInsertRowid);
        const quota = environment.store.db
          .query(
            'UPDATE invocations SET sends_used = sends_used + 1, side_effect_started = 1 WHERE id = ? AND sends_used < ?',
          )
          .run(environment.context.invocationId, BigInt(environment.maxSends));
        if (quota.changes === 0) {
          environment.store.db
            .query("UPDATE tool_calls SET state = 'error', error_code = 'send_limit', finished_at = ? WHERE id = ?")
            .run(now, toolId);
          return { toolId, sendId: null };
        }
        const sendInsert = environment.store.db
          .query(
            "INSERT INTO telegram_sends(tool_call_id, conversation_id, kind, request_json, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
          )
          .run(
            toolId,
            targetConversationId,
            send.kind,
            JSON.stringify({ kind: send.kind, reply_to_message_id: send.reply_to_message_id ?? null }),
            now,
          );
        return { toolId, sendId: BigInt(sendInsert.lastInsertRowid) };
      });
      if (pending.sendId === null) throw new Error(`send limit of ${environment.maxSends} reached`);
      const options = {
        ...(targetThreadId === 0n ? {} : { message_thread_id: Number(targetThreadId) }),
        ...(send.reply_to_message_id === undefined
          ? {}
          : { reply_parameters: { message_id: Number(send.reply_to_message_id) } }),
      };
      const startedAt = performance.now();
      try {
        let response: TelegramSendResponse;
        while (true) {
          try {
            if (send.kind === 'text') {
              response = await environment.api.sendMessage(environment.context.chatId.toString(), send.text, options);
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
            if (!(error instanceof GrammyError) || error.error_code !== 429) throw error;
            const retryAfter = error.parameters.retry_after;
            if (retryAfter === undefined || Date.now() + retryAfter * 1000 >= environment.deadline) throw error;
            await delay(retryAfter * 1000, undefined, { signal });
          }
        }
        environment.store.transaction(() => {
          const now = new Date().toISOString();
          environment.store.db
            .query(
              "UPDATE tool_calls SET state = 'success', result_text = ?, duration_ms = ?, finished_at = ? WHERE id = ?",
            )
            .run(
              `telegram_message_id=${response.message_id}`,
              BigInt(Math.round(performance.now() - startedAt)),
              now,
              pending.toolId,
            );
          environment.store.db
            .query(
              "UPDATE telegram_sends SET state = 'success', telegram_message_id = ?, response_json = ?, finished_at = ? WHERE id = ?",
            )
            .run(BigInt(response.message_id), JSON.stringify({ message_id: response.message_id }), now, pending.sendId);
          recordOutgoingMessage(environment, response, send, stickerFileId ?? null, targetConversationId, now);
        });
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
          environment.store.db
            .query('UPDATE tool_calls SET state = ?, error_code = ?, duration_ms = ?, finished_at = ? WHERE id = ?')
            .run(state, errorCode, BigInt(Math.round(performance.now() - startedAt)), now, pending.toolId);
          environment.store.db
            .query('UPDATE telegram_sends SET state = ?, error_code = ?, finished_at = ? WHERE id = ?')
            .run(state, errorCode, now, pending.sendId);
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
  const now = new Date().toISOString();
  environment.store.db
    .query(
      "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, error_code, created_at, finished_at) VALUES (?, ?, 'send', ?, 'error', 1, ?, ?, ?)",
    )
    .run(environment.context.invocationId, toolCallId, JSON.stringify(input), errorCode, now, now);
}

function recordOutgoingMessage(
  environment: SendToolEnvironment,
  response: TelegramSendResponse,
  input: SendToolInput,
  stickerFileId: string | null,
  conversationId: bigint,
  recordedAt: string,
): void {
  environment.store.db
    .query(
      "INSERT INTO senders(telegram_type, telegram_id, display_name, username, is_bot, updated_at) VALUES ('user', ?, ?, ?, 1, ?) ON CONFLICT(telegram_type, telegram_id) DO UPDATE SET display_name = excluded.display_name, username = excluded.username, is_bot = 1, updated_at = excluded.updated_at",
    )
    .run(environment.bot.id, environment.bot.displayName, environment.bot.username, recordedAt);
  const sender = environment.store.db
    .query<{ id: bigint }, [bigint]>("SELECT id FROM senders WHERE telegram_type = 'user' AND telegram_id = ?")
    .get(environment.bot.id);
  if (sender === null) throw new Error('Bot sender row is missing after upsert');
  const chat = environment.store.db
    .query<{ id: bigint }, [bigint]>('SELECT id FROM chats WHERE telegram_chat_id = ?')
    .get(environment.context.chatId);
  if (chat === null) throw new Error('Outgoing chat row does not exist');
  const created = environment.store.db
    .query(
      'INSERT INTO messages(conversation_id, chat_id, telegram_message_id, visible, sent_by_bot, telegram_date, received_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
    )
    .run(
      conversationId,
      chat.id,
      BigInt(response.message_id),
      new Date(response.date * 1000).toISOString(),
      recordedAt,
    );
  const messageId = BigInt(created.lastInsertRowid);
  const revision = environment.store.db
    .query(
      'INSERT INTO message_revisions(message_id, revision_no, sender_id, kind, text, reply_to_message_id, created_at, raw_fragment_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      messageId,
      sender.id,
      input.kind,
      input.kind === 'text' ? input.text : null,
      input.reply_to_message_id === undefined ? null : BigInt(input.reply_to_message_id),
      recordedAt,
      JSON.stringify({ message_id: response.message_id, kind: input.kind }),
    );
  const revisionId = BigInt(revision.lastInsertRowid);
  environment.store.db.query('UPDATE messages SET current_revision_id = ? WHERE id = ?').run(revisionId, messageId);
  if (input.kind === 'sticker' && stickerFileId !== null) {
    const sticker = environment.store.db
      .query<{ file_unique_id: string }, [string]>('SELECT file_unique_id FROM stickers WHERE file_id = ?')
      .get(stickerFileId);
    if (sticker !== null) {
      environment.store.db
        .query(
          "INSERT INTO media(revision_id, kind, file_id, file_unique_id, mime_type, telegram_json) VALUES (?, 'sticker', ?, ?, 'image/webp', ?)",
        )
        .run(revisionId, stickerFileId, sticker.file_unique_id, JSON.stringify({ sent: true }));
    }
  }
}

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import Type from 'typebox';
import Compile from 'typebox/compile';

/**
 * Codec between the Pi `AgentMessage` union and the `context_messages`
 * `payload_json` column.
 *
 * The canonical history must replay exactly (tool call IDs, arguments, thinking
 * signatures, model identity), so one row that will not decode makes the whole
 * retained window it belongs to unseedable and every later invocation of that
 * conversation fails before its first model call. Encode and decode therefore
 * agree for every message a provider can produce: structures copied verbatim
 * from the provider (`usage`) validate tolerantly, structures projected field by
 * field (`content` blocks, the message envelope) stay strict, where extra keys
 * really do mean corruption.
 *
 * Two things are deliberately dropped: inline image blocks — attachments belong
 * to the batch that introduced them, and the JSON keeps the `img_` / `figure_N`
 * references instead — and run-scoped handles (`deferred`, `diagnostics`).
 */

const Strict = { additionalProperties: false } as const;

const TextBlockSchema = Type.Object(
  { type: Type.Literal('text'), text: Type.String(), textSignature: Type.Optional(Type.String()) },
  Strict,
);
const ThinkingBlockSchema = Type.Object(
  {
    type: Type.Literal('thinking'),
    thinking: Type.String(),
    thinkingSignature: Type.Optional(Type.String()),
    redacted: Type.Optional(Type.Boolean()),
  },
  Strict,
);
const ToolCallBlockSchema = Type.Object(
  {
    type: Type.Literal('toolCall'),
    id: Type.String(),
    name: Type.String(),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    thoughtSignature: Type.Optional(Type.String()),
    namespace: Type.Optional(Type.String()),
  },
  Strict,
);
const UsageSchema = Type.Object(
  {
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    cacheWrite1h: Type.Optional(Type.Number()),
    reasoning: Type.Optional(Type.Number()),
    totalTokens: Type.Number(),
    cost: Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      total: Type.Number(),
    }),
  },
  // `usage` is copied from the provider verbatim, so this schema must not be
  // stricter than what a provider may report. It used to list only the five
  // counters plus `cost` and reject anything else, which made every persisted
  // assistant message undecodable the moment a provider reported a counter the
  // schema did not know (OpenRouter's `reasoning`): the transcript then failed
  // to seed, and every later invocation of that conversation failed instantly
  // until the history was cleared. Unknown metadata keys are therefore kept.
  { additionalProperties: true },
);
const UserMessageSchema = Type.Object(
  {
    role: Type.Literal('user'),
    content: Type.Union([Type.String(), Type.Array(TextBlockSchema)]),
    timestamp: Type.Number(),
  },
  Strict,
);
const AssistantMessageSchema = Type.Object(
  {
    role: Type.Literal('assistant'),
    content: Type.Array(Type.Union([TextBlockSchema, ThinkingBlockSchema, ToolCallBlockSchema])),
    api: Type.String(),
    provider: Type.String(),
    model: Type.String(),
    responseModel: Type.Optional(Type.String()),
    responseId: Type.Optional(Type.String()),
    usage: UsageSchema,
    stopReason: Type.String(),
    errorMessage: Type.Optional(Type.String()),
    timestamp: Type.Number(),
  },
  Strict,
);
const ToolResultMessageSchema = Type.Object(
  {
    role: Type.Literal('toolResult'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    content: Type.Array(TextBlockSchema),
    details: Type.Optional(Type.Unknown()),
    isError: Type.Boolean(),
    timestamp: Type.Number(),
  },
  Strict,
);

const userValidator = Compile(UserMessageSchema);
const assistantValidator = Compile(AssistantMessageSchema);
const toolResultValidator = Compile(ToolResultMessageSchema);

export type ContextMessageRole = 'user' | 'assistant' | 'toolResult';

type AssistantContentBlock =
  | { readonly type: 'text'; readonly text: string; readonly textSignature?: string }
  | {
      readonly type: 'thinking';
      readonly thinking: string;
      readonly thinkingSignature?: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: 'toolCall';
      readonly id: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      readonly thoughtSignature?: string;
      readonly namespace?: string;
    };

/** Stop reasons whose assistant messages are dropped instead of persisted. */
const DISCARDED_STOP_REASONS = new Set(['error', 'aborted']);

/**
 * Encodes one agent message for the canonical history, or returns `undefined`
 * when the message must not be persisted at all.
 *
 * A message is dropped when it is an assistant message that failed or was
 * aborted (`Agent.handleRunFailure` also pushes an empty assistant message on
 * failure) or when it carries no model-visible content. Persisting either kind
 * would accumulate rows that render as nothing, or worse, as a synthetic
 * mangled turn.
 */
export function encodeContextMessage(message: AgentMessage): { role: ContextMessageRole; json: string } | undefined {
  switch (message.role) {
    case 'user': {
      const content: string | { type: 'text'; text: string }[] =
        typeof message.content === 'string' ? message.content : textBlocksOnly(message.content);
      if (typeof content !== 'string' && content.every((block) => block.text.trim().length === 0)) {
        return undefined;
      }
      return {
        role: 'user',
        json: JSON.stringify({ role: 'user', content, timestamp: message.timestamp }),
      };
    }
    case 'assistant': {
      if (DISCARDED_STOP_REASONS.has(message.stopReason)) {
        return undefined;
      }
      const content: AssistantContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          content.push({
            type: 'text',
            text: block.text,
            ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
          });
          continue;
        }
        if (block.type === 'thinking') {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
            ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
          });
          continue;
        }
        content.push({
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
          ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
        });
      }
      const modelVisible = content.some(
        (block) =>
          (block.type === 'text' && block.text.trim().length > 0) ||
          (block.type === 'thinking' && block.thinking.trim().length > 0) ||
          block.type === 'toolCall',
      );
      if (!modelVisible) {
        return undefined;
      }
      return {
        role: 'assistant',
        json: JSON.stringify({
          role: 'assistant',
          content,
          api: message.api,
          provider: message.provider,
          model: message.model,
          ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
          ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
          usage: message.usage,
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
          timestamp: message.timestamp,
        }),
      };
    }
    case 'toolResult': {
      const content = textBlocksOnly(message.content);
      return {
        role: 'toolResult',
        json: JSON.stringify({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content,
          ...(message.details === undefined ? {} : { details: message.details }),
          isError: message.isError === true,
          timestamp: message.timestamp,
        }),
      };
    }
    default:
      return undefined;
  }
}

/** Decodes one canonical-history row back into the agent transcript. */
export function decodeContextMessage(json: string): AgentMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Stored context message contains invalid JSON');
  }
  if (userValidator.Check(parsed)) {
    return parsed as UserMessage;
  }
  if (assistantValidator.Check(parsed)) {
    return parsed as unknown as AssistantMessage;
  }
  if (toolResultValidator.Check(parsed)) {
    return parsed as unknown as ToolResultMessage;
  }
  throw new Error('Stored context message does not match its schema');
}

/**
 * Rough token estimate for one persisted message. Only used for the GC token
 * safety valve, so a 4-characters-per-token approximation is enough; the real
 * numbers come from provider usage on every model call.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  const encoded = encodeContextMessage(message);
  return encoded === undefined ? 0 : Math.ceil(encoded.json.length / 4);
}

function textBlocksOnly(content: readonly { type: string }[]): { type: 'text'; text: string }[] {
  const blocks: { type: 'text'; text: string }[] = [];
  for (const block of content as readonly { type?: unknown; text?: unknown }[]) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    blocks.push({ type: 'text', text: block.text });
  }
  return blocks;
}

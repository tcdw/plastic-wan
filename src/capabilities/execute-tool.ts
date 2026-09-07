import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { finishToolCall, rejectToolCall, startToolCall, type SqliteStore } from '../store/database.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import { safeJson, truncateUtf8 } from '../platform/truncate.ts';

const Strict = { additionalProperties: false } as const;
const ToolNamePattern = '^[A-Za-z0-9_-]{1,128}$';
const RESULT_MAX_BYTES = 32_768;
/** Leaves headroom for the envelope wrapper and refs inside RESULT_MAX_BYTES. */
const TEXT_MAX_BYTES = 30_720;
const INPUT_MAX_BYTES = 32_768;
const SEARCH_RESULT_LIMIT = 8;

const ExecuteInputSchema = Type.Union([
  Type.Object({ action: Type.Literal('search'), query: Type.String({ minLength: 1, maxLength: 200 }) }, Strict),
  Type.Object({ action: Type.Literal('help'), tool: Type.String({ pattern: ToolNamePattern }) }, Strict),
  Type.Object(
    {
      action: Type.Literal('call'),
      tool: Type.String({ pattern: ToolNamePattern }),
      input: Type.Record(Type.String(), Type.Unknown()),
    },
    Strict,
  ),
]);

/** Runtime primitives are registered by the runtime itself and never callable through execute. */
export const EXECUTE_PRIMITIVES: ReadonlySet<string> = new Set(['read', 'send', 'execute', 'zzz']);
const SIDE_EFFECTING_PRIMITIVES: ReadonlySet<string> = new Set(['send', 'zzz']);

/** Optional structured extras a capability may attach to its AgentToolResult details. */
export interface CapabilityToolDetails {
  readonly refs?: Readonly<Record<string, readonly string[]>>;
}

export interface ExecuteToolDetails {
  readonly action: 'search' | 'help' | 'call';
  readonly tool?: string;
  readonly matches?: number;
  readonly refs?: Readonly<Record<string, readonly string[]>>;
}

export interface ExecutableCapability {
  readonly tool: AgentTool;
  readonly sideEffect: boolean;
}

/** Wraps one runtime-internal tool as an execute-registry entry. */
export function capability(tool: AgentTool, sideEffect: boolean): ExecutableCapability {
  return { tool, sideEffect };
}

export interface ExecuteToolOptions {
  readonly store: SqliteStore;
  readonly context: InvocationContext;
  readonly capabilities: readonly ExecutableCapability[];
}

interface RegisteredCapability {
  readonly entry: ExecutableCapability;
  readonly validator: { Check(value: unknown): boolean };
}

/**
 * The `execute` runtime primitive: a controlled dispatch interface between
 * the model and runtime-internal capabilities. It does discovery, help,
 * validation, dispatch, and auditing — never reasoning on the model's behalf,
 * and never exposing the read/send/execute/zzz primitives or MCP tools.
 */
export function createExecuteTool(
  options: ExecuteToolOptions,
): AgentTool<typeof ExecuteInputSchema, ExecuteToolDetails> {
  const registered = new Map<string, RegisteredCapability>();
  for (const entry of options.capabilities) {
    if (EXECUTE_PRIMITIVES.has(entry.tool.name)) {
      throw new Error(`Runtime primitive ${entry.tool.name} cannot be registered as an execute capability`);
    }
    if (registered.has(entry.tool.name)) {
      throw new Error(`Duplicate execute capability name: ${entry.tool.name}`);
    }
    registered.set(entry.tool.name, { entry, validator: Compile(entry.tool.parameters) });
  }
  return {
    name: 'execute',
    label: 'Call a runtime capability',
    description:
      'Controlled gateway to runtime-internal capabilities (web fetching, sticker search, image analysis, memory notes, alarms). Actions: search finds capabilities for a need, e.g. query "fetch a web page", and returns [{name, summary}]; help returns one capability\'s full description and parameters; call invokes one capability with a JSON object input. Prefer the system skill index and skill documents for how to use a capability; use search only when no skill covers the need, and check help when unsure about the input contract. call returns an envelope {text, refs}: text is bounded evidence or structured data, refs holds invocation-scoped reference tokens (such as sticker_ref) that only their named consumer tool accepts after validation — never guess, reuse from other invocations, or fabricate them. The directly exposed tools (read, send, execute, zzz) and MCP tools are never callable through execute. On failure, do not invent results and do not blindly retry side effects.',
    parameters: ExecuteInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const startedAt = performance.now();
      if (input.action === 'search') {
        return executeSearch(options, registered, toolCallId, input.query, startedAt);
      }
      if (input.action === 'help') {
        return executeHelp(options, registered, toolCallId, input.tool, startedAt);
      }
      return executeCall(options, registered, toolCallId, input.tool, input.input, signal, startedAt);
    },
  };
}

function executeSearch(
  options: ExecuteToolOptions,
  registered: Map<string, RegisteredCapability>,
  toolCallId: string,
  query: string,
  startedAt: number,
): AgentToolResult<ExecuteToolDetails> {
  const auditId = startToolCall(
    options.store.orm,
    options.context.invocationId,
    toolCallId,
    'execute',
    JSON.stringify({ action: 'search', query }),
    false,
  );
  const results = searchCapabilities([...registered.values()], query);
  const text = JSON.stringify(results);
  finishToolCall(options.store.orm, auditId, 'success', text, null, { startedAt, pendingOnly: true });
  return {
    content: [{ type: 'text' as const, text }],
    details: { action: 'search', matches: results.length },
  };
}

function executeHelp(
  options: ExecuteToolOptions,
  registered: Map<string, RegisteredCapability>,
  toolCallId: string,
  toolName: string,
  startedAt: number,
): AgentToolResult<ExecuteToolDetails> {
  const target = registered.get(toolName);
  if (target === undefined) {
    rejectExecute(options, toolCallId, { action: 'help', tool: toolName }, unknownCapabilityCode(toolName));
    throw new Error(unknownCapabilityMessage(toolName));
  }
  const auditId = startToolCall(
    options.store.orm,
    options.context.invocationId,
    toolCallId,
    'execute',
    JSON.stringify({ action: 'help', tool: toolName }),
    false,
  );
  const payload = {
    name: target.entry.tool.name,
    label: target.entry.tool.label,
    description: target.entry.tool.description,
    parameters: target.entry.tool.parameters,
  };
  const text = truncateUtf8(JSON.stringify(payload), RESULT_MAX_BYTES);
  finishToolCall(options.store.orm, auditId, 'success', text, null, { startedAt, pendingOnly: true });
  return {
    content: [{ type: 'text' as const, text }],
    details: { action: 'help', tool: toolName },
  };
}

async function executeCall(
  options: ExecuteToolOptions,
  registered: Map<string, RegisteredCapability>,
  toolCallId: string,
  toolName: string,
  callInput: Record<string, unknown>,
  signal: AbortSignal | undefined,
  startedAt: number,
): Promise<AgentToolResult<ExecuteToolDetails>> {
  const argumentsJson = safeJson({ action: 'call', tool: toolName, input: callInput }, INPUT_MAX_BYTES);
  const target = registered.get(toolName);
  if (target === undefined) {
    rejectExecute(options, toolCallId, { action: 'call', tool: toolName }, unknownCapabilityCode(toolName));
    throw new Error(unknownCapabilityMessage(toolName));
  }
  if (
    Array.isArray(callInput) ||
    typeof callInput !== 'object' ||
    callInput === null ||
    Buffer.byteLength(JSON.stringify(callInput)) > INPUT_MAX_BYTES
  ) {
    rejectExecute(options, toolCallId, { action: 'call', tool: toolName, input: callInput }, 'arguments_too_large');
    throw new Error('execute.call input exceeds 32 KiB');
  }
  if (!target.validator.Check(callInput)) {
    rejectExecute(options, toolCallId, { action: 'call', tool: toolName, input: callInput }, 'invalid_arguments');
    throw new Error(`execute.call input does not match the schema of ${toolName}`);
  }
  const auditId = startToolCall(
    options.store.orm,
    options.context.invocationId,
    toolCallId,
    'execute',
    argumentsJson,
    target.entry.sideEffect,
  );
  try {
    const result = await target.entry.tool.execute(`${toolCallId}:${toolName}`, callInput, signal);
    // Text payload: bounded and truncated. Reference payload: non-text
    // artifacts only ever leave as invocation-scoped tokens from details.refs.
    const innerText = result.content
      .filter((entry) => entry.type === 'text')
      .map((entry) => entry.text)
      .join('\n');
    const refs = readCapabilityRefs(result.details);
    const envelope = JSON.stringify({
      text: truncateUtf8(innerText, TEXT_MAX_BYTES),
      ...(Object.keys(refs).length === 0 ? {} : { refs }),
    });
    const text = truncateUtf8(envelope, RESULT_MAX_BYTES);
    finishToolCall(options.store.orm, auditId, 'success', text, null, { startedAt, pendingOnly: true });
    return {
      content: [{ type: 'text' as const, text }],
      details: { action: 'call', tool: toolName, ...(Object.keys(refs).length === 0 ? {} : { refs }) },
    };
  } catch (error) {
    const code = signal?.aborted === true ? 'aborted' : 'capability_error';
    finishToolCall(options.store.orm, auditId, 'error', null, code, { startedAt, pendingOnly: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`execute.call ${toolName} failed: ${message}`);
  }
}

function rejectExecute(options: ExecuteToolOptions, toolCallId: string, input: unknown, errorCode: string): void {
  const toolName =
    typeof input === 'object' && input !== null && 'tool' in input && typeof input.tool === 'string' ? input.tool : '';
  rejectToolCall(
    options.store.orm,
    options.context.invocationId,
    toolCallId,
    'execute',
    safeJson(input, INPUT_MAX_BYTES),
    SIDE_EFFECTING_PRIMITIVES.has(toolName),
    errorCode,
  );
}

function unknownCapabilityCode(toolName: string): string {
  return EXECUTE_PRIMITIVES.has(toolName) ? 'execute_primitive_rejected' : 'unknown_capability';
}

function unknownCapabilityMessage(toolName: string): string {
  return EXECUTE_PRIMITIVES.has(toolName)
    ? `execute cannot dispatch the runtime primitive ${toolName}; call it directly`
    : `execute has no capability named ${toolName}`;
}

function readCapabilityRefs(details: unknown): Record<string, readonly string[]> {
  if (typeof details !== 'object' || details === null) {
    return {};
  }
  const refs = (details as CapabilityToolDetails).refs;
  if (refs === undefined || typeof refs !== 'object') {
    return {};
  }
  const result: Record<string, readonly string[]> = {};
  for (const [kind, tokens] of Object.entries(refs)) {
    if (Array.isArray(tokens) && tokens.every((token) => typeof token === 'string')) {
      result[kind] = tokens;
    }
  }
  return result;
}

function searchCapabilities(
  capabilities: readonly RegisteredCapability[],
  query: string,
): { name: string; summary: string }[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }
  const tokens = [
    ...new Set(
      normalizedQuery
        .split(/[^a-z0-9_]+/)
        .map((token) => token.replaceAll('_', ' '))
        .filter((token) => token.length >= 2),
    ),
  ];
  const scored = capabilities.flatMap(({ entry }) => {
    const name = entry.tool.name.toLowerCase();
    const splitName = name.replaceAll('_', ' ');
    const label = entry.tool.label.toLowerCase();
    const description = entry.tool.description.toLowerCase();
    let score = 0;
    if (`${name} ${label} ${description}`.includes(normalizedQuery)) {
      score += 10;
    }
    for (const token of tokens) {
      if (name.includes(token) || splitName.includes(token)) {
        score += 3;
      } else if (label.includes(token)) {
        score += 2;
      } else if (description.includes(token)) {
        score += 1;
      }
    }
    return score === 0 ? [] : [{ name: entry.tool.name, summary: entry.tool.label, score }];
  });
  scored.sort((left, right) => right.score - left.score || (left.name < right.name ? -1 : 1));
  return scored.slice(0, SEARCH_RESULT_LIMIT).map(({ name, summary }) => ({ name, summary }));
}

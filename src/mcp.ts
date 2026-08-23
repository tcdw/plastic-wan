import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolResult,
  type CompatibilityCallToolResult,
  ErrorCode,
  type JSONRPCMessage,
  McpError,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import Type, { type TUnsafe } from 'typebox';
import Compile from 'typebox/compile';
import { AsyncSemaphore } from './concurrency.ts';
import type { McpServerConfig, RawConfig, SecretRef } from './config.ts';
import { type InvocationContext, previewContext } from './context-builder.ts';
import type { SqliteStore } from './database.ts';
import type { SecretStore } from './secrets.ts';

const ARGUMENT_MAX_BYTES = 32_768;
const RECONNECT_MAX_MS = 60_000;
const TRUNCATION_MARKER = '\n[tool result truncated]';
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ToolPolicy {
  readonly readOnly: boolean;
  readonly timeoutMs: number;
  readonly perChatDailyCalls: number;
  readonly globalDailyCalls: number;
}

interface McpToolDefinition {
  readonly serverAlias: string;
  readonly originalName: string;
  readonly exposedName: string;
  readonly description: string;
  readonly parameters: TUnsafe<Record<string, unknown>>;
  readonly validator: { Check(value: unknown): value is Record<string, unknown> };
  readonly policy: ToolPolicy;
  readonly resultMaxBytes: number;
}

interface ManagedServer {
  readonly config: McpServerConfig;
  readonly semaphore: AsyncSemaphore;
  definitions: McpToolDefinition[];
  client: Client | undefined;
  generation: number;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | undefined;
  stderrBytes: number;
  state: 'starting' | 'ready' | 'degraded' | 'stopped';
}

interface StartedToolCall {
  readonly auditId: bigint;
  readonly blocked: boolean;
}

type RegistryValidator = (tools: readonly AgentTool[]) => void;
type McpCallResult = CallToolResult | CompatibilityCallToolResult;

export class McpManager {
  readonly #store: SqliteStore;
  readonly #secrets: SecretStore;
  readonly #servers = new Map<string, ManagedServer>();
  #registryValidator: RegistryValidator | undefined;
  #stopping = false;

  constructor(store: SqliteStore, config: RawConfig, secrets: SecretStore) {
    this.#store = store;
    this.#secrets = secrets;
    for (const serverConfig of config.mcp?.servers ?? []) {
      this.#servers.set(serverConfig.alias, {
        config: serverConfig,
        semaphore: new AsyncSemaphore(1),
        definitions: [],
        client: undefined,
        generation: 0,
        reconnectAttempt: 0,
        reconnectTimer: undefined,
        stderrBytes: 0,
        state: 'stopped',
      });
    }
  }

  async start(): Promise<void> {
    this.#stopping = false;
    for (const server of this.#servers.values()) {
      try {
        await this.#connect(server, true);
      } catch (error) {
        this.#setState(server, 'degraded', 'initialization_failed');
        if (server.config.required) {
          await this.stop();
          throw new Error(`Required MCP server ${server.config.alias} failed to initialize: ${safeErrorName(error)}`);
        }
        this.#scheduleReconnect(server);
      }
    }
  }

  setRegistryValidator(validator: RegistryValidator): void {
    validator(this.#createToolsForDefinitions(this.#allDefinitions(), previewContext(), Number.MAX_SAFE_INTEGER));
    this.#registryValidator = validator;
  }

  createTools(context: InvocationContext, invocationDeadline: number): readonly AgentTool[] {
    return this.#createToolsForDefinitions(this.#allDefinitions(), context, invocationDeadline);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const server of this.#servers.values()) {
      if (server.reconnectTimer !== undefined) clearTimeout(server.reconnectTimer);
      server.reconnectTimer = undefined;
      server.generation += 1;
      const client = server.client;
      server.client = undefined;
      if (client !== undefined) await client.close().catch(() => undefined);
      server.definitions = [];
      this.#setState(server, 'stopped', null);
    }
  }

  async #connect(server: ManagedServer, startup: boolean): Promise<void> {
    if (this.#stopping) return;
    this.#setState(server, 'starting', null);
    const oldClient = server.client;
    server.client = undefined;
    server.generation += 1;
    const generation = server.generation;
    if (oldClient !== undefined) await oldClient.close().catch(() => undefined);
    const client = new Client(
      { name: 'plasticwan', version: '0.1.0' },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listChanged: {
          tools: {
            onChanged: () => {
              void this.#refreshTools(server).catch(() => {
                this.#setState(server, 'degraded', 'registry_update_failed');
              });
            },
          },
        },
      },
    );
    const transport = new CompatibleTransport(await this.#createTransport(server));
    client.onclose = () => {
      if (this.#stopping || generation !== server.generation) return;
      server.client = undefined;
      const detail =
        server.config.transport === 'stdio' ? `transport_closed_stderr_${server.stderrBytes}` : 'transport_closed';
      this.#setState(server, 'degraded', detail);
      this.#scheduleReconnect(server);
    };
    client.onerror = () => {
      if (this.#stopping || generation !== server.generation) return;
      this.#setState(server, 'degraded', 'transport_error');
    };
    await client.connect(transport, { signal: AbortSignal.timeout(30_000), timeout: 30_000, maxTotalTimeout: 30_000 });
    const listed = await client.listTools(undefined, {
      signal: AbortSignal.timeout(30_000),
      timeout: 30_000,
      maxTotalTimeout: 30_000,
    });
    const definitions = this.#selectTools(server.config, listed.tools);
    const previousDefinitions = server.definitions;
    server.definitions = definitions;
    try {
      this.#validateCandidateRegistry();
    } catch (error) {
      server.definitions = previousDefinitions;
      await client.close().catch(() => undefined);
      throw error;
    }
    server.client = client;
    server.reconnectAttempt = 0;
    this.#setState(server, 'ready', null);
    if (!startup) this.#validateCandidateRegistry();
  }

  async #refreshTools(server: ManagedServer): Promise<void> {
    const release = await server.semaphore.acquire(new AbortController().signal);
    try {
      const client = server.client;
      if (client === undefined) throw new Error('MCP server is unavailable');
      const listed = await client.listTools(undefined, {
        signal: AbortSignal.timeout(30_000),
        timeout: 30_000,
        maxTotalTimeout: 30_000,
      });
      const candidate = this.#selectTools(server.config, listed.tools);
      const previous = server.definitions;
      server.definitions = candidate;
      try {
        this.#validateCandidateRegistry();
      } catch (error) {
        server.definitions = previous;
        throw error;
      }
      this.#setState(server, 'ready', null);
    } finally {
      release();
    }
  }

  async #createTransport(server: ManagedServer): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
    if (server.config.transport === 'stdio') {
      const [command, ...args] = server.config.command;
      if (command === undefined) throw new Error('MCP stdio command is empty');
      const env = {
        ...getDefaultEnvironment(),
        ...(await resolveSecretRecord(server.config.env ?? {}, this.#secrets)),
      };
      const transport = new StdioClientTransport({
        command,
        args,
        env,
        stderr: 'pipe',
        maxBufferSize: server.config.payload_max_bytes,
      });
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        server.stderrBytes += Buffer.byteLength(chunk);
      });
      return transport;
    }
    const headers = await resolveSecretRecord(server.config.headers ?? {}, this.#secrets);
    const maxBytes = server.config.payload_max_bytes;
    const boundedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input.toString(), { ...init, redirect: 'manual' });
      if (request.body !== null) {
        const body = await request.clone().arrayBuffer();
        if (body.byteLength > maxBytes) {
          this.#setState(server, 'degraded', 'payload_limit');
          throw new Error('MCP request exceeds payload limit');
        }
      }
      const response = await fetch(request);
      if (response.status >= 300 && response.status < 400) {
        this.#setState(server, 'degraded', 'redirect_rejected');
        await response.body?.cancel();
        throw new Error('MCP HTTP redirect rejected');
      }
      return limitResponseBody(response, maxBytes, () => this.#setState(server, 'degraded', 'payload_limit'));
    };
    return new StreamableHTTPClientTransport(new URL(server.config.url), {
      requestInit: { headers, redirect: 'manual' },
      fetch: boundedFetch,
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 3,
      },
    });
  }

  #selectTools(
    server: McpServerConfig,
    listed: readonly {
      readonly name: string;
      readonly description?: string | undefined;
      readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
      readonly execution?: { readonly taskSupport?: 'optional' | 'required' | 'forbidden' | undefined } | undefined;
    }[],
  ): McpToolDefinition[] {
    const byName = new Map<string, (typeof listed)[number]>();
    for (const tool of listed) {
      if (byName.has(tool.name)) throw new Error(`MCP server ${server.alias} returned duplicate tool ${tool.name}`);
      byName.set(tool.name, tool);
    }
    const selected =
      server.tools === '*'
        ? listed
        : server.tools.map((name) => {
            const tool = byName.get(name);
            if (tool === undefined) throw new Error(`MCP server ${server.alias} is missing configured tool ${name}`);
            return tool;
          });
    return selected.map((tool) => {
      if (tool.execution?.taskSupport === 'required')
        throw new Error(`MCP task-only tool ${server.alias}__${tool.name} is unsupported`);
      const exposedName = `${server.alias}__${tool.name}`;
      if (exposedName.length > 128 || !TOOL_NAME_PATTERN.test(exposedName)) {
        throw new Error(`MCP tool name is incompatible with model APIs: ${exposedName}`);
      }
      const configuredPolicy =
        server.tool_policies?.find((policy) => policy.name === tool.name) ?? server.default_tool_policy;
      if (configuredPolicy === undefined) throw new Error(`MCP tool ${exposedName} has no policy`);
      const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
      const validator = Compile(parameters);
      return {
        serverAlias: server.alias,
        originalName: tool.name,
        exposedName,
        description: tool.description ?? `Call ${tool.name} on MCP server ${server.alias}`,
        parameters,
        validator,
        policy: {
          readOnly: configuredPolicy.read_only,
          timeoutMs: Math.round(configuredPolicy.timeout_seconds * 1_000),
          perChatDailyCalls: configuredPolicy.per_chat_daily_calls,
          globalDailyCalls: configuredPolicy.global_daily_calls,
        },
        resultMaxBytes: server.result_max_bytes,
      };
    });
  }

  #createToolsForDefinitions(
    definitions: readonly McpToolDefinition[],
    context: InvocationContext,
    invocationDeadline: number,
  ): AgentTool[] {
    return definitions.map(
      (definition): AgentTool<TUnsafe<Record<string, unknown>>, { server: string; tool: string }> => ({
        name: definition.exposedName,
        label: definition.exposedName,
        description: definition.description,
        parameters: definition.parameters,
        executionMode: 'sequential',
        execute: async (toolCallId, input, signal) =>
          this.#executeTool(definition, context, invocationDeadline, toolCallId, input, signal),
      }),
    );
  }

  async #executeTool(
    definition: McpToolDefinition,
    context: InvocationContext,
    invocationDeadline: number,
    toolCallId: string,
    input: Record<string, unknown>,
    outerSignal?: AbortSignal,
  ): Promise<{ content: { type: 'text'; text: string }[]; details: { server: string; tool: string } }> {
    if (invocationDeadline <= Date.now()) {
      this.#recordRejectedCall(context.invocationId, toolCallId, definition, input, 'invocation_timeout');
      throw new Error('Invocation deadline reached before MCP tool call');
    }
    if (!definition.validator.Check(input)) {
      this.#recordRejectedCall(context.invocationId, toolCallId, definition, input, 'invalid_arguments');
      throw new Error('MCP tool arguments do not match the configured schema');
    }
    const argumentsJson = JSON.stringify(input);
    if (Buffer.byteLength(argumentsJson) > ARGUMENT_MAX_BYTES) {
      this.#recordRejectedCall(context.invocationId, toolCallId, definition, input, 'arguments_too_large');
      throw new Error('MCP tool arguments exceed 32 KiB');
    }
    const started = this.#reserveAndStart(context, toolCallId, definition, argumentsJson);
    if (started.blocked) throw new Error('MCP tool daily call budget reached');
    const server = this.#servers.get(definition.serverAlias);
    if (server === undefined) {
      this.#finishToolCall(started.auditId, 'error', null, 'server_unconfigured', performance.now());
      throw new Error('MCP server is not configured');
    }
    const startedAt = performance.now();
    let release: () => void;
    try {
      release = await server.semaphore.acquire(outerSignal ?? new AbortController().signal);
    } catch {
      this.#finishToolCall(started.auditId, 'error', null, 'aborted_before_request', startedAt);
      throw new Error('MCP tool call aborted before request');
    }
    try {
      const timeoutMs = Math.max(1, Math.min(definition.policy.timeoutMs, invocationDeadline - Date.now()));
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (outerSignal !== undefined) signals.push(outerSignal);
      const signal = AbortSignal.any(signals);
      let result: McpCallResult;
      try {
        result = await this.#call(server, definition, input, signal, timeoutMs);
      } catch (error) {
        if (!definition.policy.readOnly || !isTransient(error) || signal.aborted) throw error;
        await delay(100, undefined, { signal });
        result = await this.#call(server, definition, input, signal, timeoutMs);
      }
      const text = truncateUtf8(JSON.stringify(result), definition.resultMaxBytes);
      if ('isError' in result && result.isError === true) {
        this.#finishToolCall(started.auditId, 'error', text, 'mcp_tool_error', startedAt);
        throw new KnownToolError(text);
      }
      this.#finishToolCall(started.auditId, 'success', text, null, startedAt);
      return {
        content: [{ type: 'text', text }],
        details: { server: definition.serverAlias, tool: definition.originalName },
      };
    } catch (error) {
      if (error instanceof KnownToolError) throw new Error(error.message);
      const known =
        error instanceof McpError &&
        error.code !== ErrorCode.ConnectionClosed &&
        error.code !== ErrorCode.RequestTimeout;
      const state = known ? 'error' : 'outcome_unknown';
      this.#finishToolCall(started.auditId, state, null, classifyMcpError(error), startedAt);
      if (!known) {
        this.#setState(server, 'degraded', classifyMcpError(error));
        this.#scheduleReconnect(server);
      }
      throw new Error(`MCP tool ${definition.exposedName} failed: ${classifyMcpError(error)}`);
    } finally {
      release();
    }
  }

  async #call(
    server: ManagedServer,
    definition: McpToolDefinition,
    input: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    const client = server.client;
    if (client === undefined || server.state !== 'ready') throw new Error('MCP transport is unavailable');
    return client.callTool({ name: definition.originalName, arguments: input }, undefined, {
      signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });
  }

  #reserveAndStart(
    context: InvocationContext,
    toolCallId: string,
    definition: McpToolDefinition,
    argumentsJson: string,
  ): StartedToolCall {
    return this.#store.transaction(() => {
      const now = new Date().toISOString();
      const date = now.slice(0, 10);
      const chatResource = `${context.chatId}:${definition.exposedName}`;
      const globalResource = definition.exposedName;
      const chatUsed = this.#usage(date, 'mcp_chat', chatResource);
      const globalUsed = this.#usage(date, 'mcp_global', globalResource);
      const blocked =
        chatUsed >= BigInt(definition.policy.perChatDailyCalls) ||
        globalUsed >= BigInt(definition.policy.globalDailyCalls);
      const created = this.#store.db
        .query(
          'INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          context.invocationId,
          toolCallId,
          definition.exposedName,
          argumentsJson,
          blocked ? 'blocked_budget' : 'pending',
          definition.policy.readOnly ? 0 : 1,
          blocked ? 'blocked_budget' : null,
          now,
          blocked ? now : null,
        );
      const auditId = BigInt(created.lastInsertRowid);
      if (blocked) return { auditId, blocked: true };
      this.#incrementUsage(date, 'mcp_chat', chatResource, now);
      this.#incrementUsage(date, 'mcp_global', globalResource, now);
      return { auditId, blocked: false };
    });
  }

  #recordRejectedCall(
    invocationId: bigint,
    toolCallId: string,
    definition: McpToolDefinition,
    input: unknown,
    errorCode: string,
  ): void {
    const now = new Date().toISOString();
    const argumentsJson = safeJson(input, ARGUMENT_MAX_BYTES);
    this.#store.db
      .query(
        "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, state, side_effect, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, 'error', ?, ?, ?, ?)",
      )
      .run(
        invocationId,
        toolCallId,
        definition.exposedName,
        argumentsJson,
        definition.policy.readOnly ? 0 : 1,
        errorCode,
        now,
        now,
      );
  }

  #finishToolCall(
    auditId: bigint,
    state: 'success' | 'error' | 'outcome_unknown',
    result: string | null,
    errorCode: string | null,
    startedAt: number,
  ): void {
    this.#store.db
      .query(
        "UPDATE tool_calls SET state = ?, result_text = ?, error_code = ?, duration_ms = ?, finished_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(
        state,
        result,
        errorCode,
        BigInt(Math.max(0, Math.round(performance.now() - startedAt))),
        new Date().toISOString(),
        auditId,
      );
  }

  #usage(date: string, scope: string, resource: string): bigint {
    return (
      this.#store.db
        .query<{ amount: bigint }, [string, string, string]>(
          "SELECT amount FROM daily_usage WHERE utc_date = ? AND scope = ? AND resource = ? AND metric = 'tool_calls'",
        )
        .get(date, scope, resource)?.amount ?? 0n
    );
  }

  #incrementUsage(date: string, scope: string, resource: string, now: string): void {
    this.#store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, ?, ?, 'tool_calls', 1, ?) ON CONFLICT(utc_date, scope, resource, metric) DO UPDATE SET amount = amount + 1, updated_at = excluded.updated_at",
      )
      .run(date, scope, resource, now);
  }

  #scheduleReconnect(server: ManagedServer): void {
    if (this.#stopping || server.reconnectTimer !== undefined) return;
    const attempt = server.reconnectAttempt;
    const waitMs = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** Math.min(attempt, 6));
    server.reconnectAttempt += 1;
    const next = new Date(Date.now() + waitMs).toISOString();
    this.#store.db
      .query('UPDATE mcp_server_state SET reconnect_attempt = ?, next_reconnect_at = ?, updated_at = ? WHERE alias = ?')
      .run(BigInt(server.reconnectAttempt), next, new Date().toISOString(), server.config.alias);
    server.reconnectTimer = setTimeout(() => {
      server.reconnectTimer = undefined;
      void (async () => {
        const reconnectSignal = AbortSignal.timeout(30_000);
        const release = await server.semaphore.acquire(reconnectSignal);
        try {
          await this.#connect(server, false);
        } catch {
          this.#setState(server, 'degraded', 'reconnect_failed');
          this.#scheduleReconnect(server);
        } finally {
          release();
        }
      })().catch(() => {
        this.#setState(server, 'degraded', 'reconnect_failed');
        this.#scheduleReconnect(server);
      });
    }, waitMs);
  }

  #validateCandidateRegistry(): void {
    const tools = this.#createToolsForDefinitions(this.#allDefinitions(), previewContext(), Number.MAX_SAFE_INTEGER);
    if (tools.length > 61) throw new Error(`MCP registry has ${tools.length} tools; maximum alongside built-ins is 61`);
    this.#registryValidator?.(tools);
  }

  #allDefinitions(): McpToolDefinition[] {
    return [...this.#servers.values()].flatMap((server) => server.definitions);
  }

  #setState(server: ManagedServer, state: ManagedServer['state'], errorCode: string | null): void {
    server.state = state;
    const now = new Date().toISOString();
    const hash =
      state === 'ready'
        ? createHash('sha256')
            .update(
              JSON.stringify(
                server.definitions.map((tool) => ({
                  name: tool.exposedName,
                  parameters: tool.parameters,
                  policy: tool.policy,
                })),
              ),
            )
            .digest('hex')
        : null;
    this.#store.db
      .query(
        'INSERT INTO mcp_server_state(alias, state, registry_hash, reconnect_attempt, next_reconnect_at, error_code, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(alias) DO UPDATE SET state = excluded.state, registry_hash = COALESCE(excluded.registry_hash, mcp_server_state.registry_hash), reconnect_attempt = excluded.reconnect_attempt, next_reconnect_at = excluded.next_reconnect_at, error_code = excluded.error_code, updated_at = excluded.updated_at',
      )
      .run(server.config.alias, state, hash, BigInt(server.reconnectAttempt), errorCode, now);
  }
}

class CompatibleTransport implements Transport {
  readonly #inner: StdioClientTransport | StreamableHTTPClientTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(inner: StdioClientTransport | StreamableHTTPClientTransport) {
    this.#inner = inner;
  }

  async start(): Promise<void> {
    this.#inner.onclose = () => this.onclose?.();
    this.#inner.onerror = (error) => this.onerror?.(error);
    this.#inner.onmessage = (message) => this.onmessage?.(message);
    await this.#inner.start();
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.#inner instanceof StdioClientTransport) {
      await this.#inner.send(message);
      return;
    }
    const httpOptions =
      options === undefined
        ? undefined
        : {
            ...(options.resumptionToken === undefined ? {} : { resumptionToken: options.resumptionToken }),
            ...(options.onresumptiontoken === undefined ? {} : { onresumptiontoken: options.onresumptiontoken }),
          };
    await this.#inner.send(message, httpOptions);
  }

  setProtocolVersion(version: string): void {
    if (this.#inner instanceof StreamableHTTPClientTransport) this.#inner.setProtocolVersion(version);
  }
}

class KnownToolError extends Error {}

async function resolveSecretRecord(
  record: Readonly<Record<string, SecretRef>>,
  secrets: SecretStore,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(record)) resolved[name] = await secrets.resolve(reference);
  return resolved;
}

function limitResponseBody(response: Response, maxBytes: number, onLimit: () => void): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await reader.read();
      if (item.done) {
        controller.close();
        return;
      }
      bytes += item.value.byteLength;
      if (bytes > maxBytes) {
        onLimit();
        await reader.cancel();
        controller.error(new Error('MCP response exceeds payload limit'));
        return;
      }
      controller.enqueue(item.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  const marker = new TextEncoder().encode(TRUNCATION_MARKER);
  if (marker.byteLength >= maxBytes) return new TextDecoder().decode(marker.subarray(0, maxBytes));
  const available = Math.max(0, maxBytes - marker.byteLength);
  let end = available;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1;
  const prefix = new TextDecoder().decode(encoded.subarray(0, end));
  return `${prefix}${TRUNCATION_MARKER}`;
}

function safeJson(value: unknown, maxBytes: number): string {
  try {
    return truncateUtf8(JSON.stringify(value), maxBytes);
  } catch {
    return 'null';
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof StreamableHTTPError)
    return error.code === 429 || error.code === 502 || error.code === 503 || error.code === 504;
  return (
    error instanceof McpError && (error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout)
  );
}

function classifyMcpError(error: unknown): string {
  if (error instanceof McpError) {
    if (error.code === ErrorCode.ConnectionClosed) return 'connection_closed';
    if (error.code === ErrorCode.RequestTimeout) return 'timeout';
    return `mcp_${error.code}`;
  }
  if (error instanceof StreamableHTTPError) return error.code === undefined ? 'http_error' : `http_${error.code}`;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'transport_error';
}

function safeErrorName(error: unknown): string {
  if (error instanceof McpError) return `mcp_${error.code}`;
  if (error instanceof Error) return error.name;
  return 'unknown_error';
}

import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type Usage,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { RawConfig } from "./config.ts";
import { KeyedSemaphore } from "./concurrency.ts";
import { ContextBuilder, type InvocationContext } from "./context-builder.ts";
import type { SqliteStore } from "./database.ts";
import type { ModelRegistry } from "./providers.ts";
import { AgentModelSwitcher } from "./model-switch.ts";
import { createSendTool, type TelegramSendApi } from "./send-tool.ts";
import type { InvocationOutcome } from "./scheduler.ts";

export interface ToolRuntimeState {
  readonly stickerCapabilities: Map<string, string>;
}

export type AdditionalToolFactory = (
  context: InvocationContext,
  state: ToolRuntimeState,
  deadline: number,
) => readonly AgentTool[];
export type DirectImageLoader = (
  context: InvocationContext,
  signal: AbortSignal,
) => Promise<readonly ImageContent[]>;

export interface AgentRuntimeOptions {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly registry: ModelRegistry;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly telegramApi: TelegramSendApi;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
  readonly additionalTools?: AdditionalToolFactory;
  readonly directImageLoader?: DirectImageLoader;
  readonly modelGate?: KeyedSemaphore;
}

/**
 * Safety net for models that draft a group-facing reply as ordinary assistant
 * text and then stop without calling send. Ordinary assistant text is private
 * and never published, so such a reply is silently lost. When the agent is
 * about to stop after producing substantial private text without ever calling
 * send, inject one harness-level reminder to use send. Fires at most once per
 * invocation; if the model still does not send, we stop and let it stay silent.
 */
const SEND_NUDGE_MIN_TEXT_CHARS = 40;
const SEND_NUDGE_TEXT =
  "You produced a reply as ordinary assistant text. Ordinary assistant text is private and is never published to Telegram. If that text is meant for the chat, call the send tool to publish it now. You will not be reminded again.";

export class AgentRuntime {
  readonly #store: SqliteStore;
  readonly #config: RawConfig;
  readonly #models: Models;
  readonly #model: Model<Api>;
  readonly #modelSwitcher: AgentModelSwitcher;
  readonly #telegramApi: TelegramSendApi;
  readonly #bot: AgentRuntimeOptions["bot"];
  readonly #additionalTools: AdditionalToolFactory | undefined;
  readonly #directImageLoader: DirectImageLoader | undefined;
  readonly #contextBuilder: ContextBuilder;
  readonly #modelGate: KeyedSemaphore;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#models = options.registry.models;
    this.#model = options.registry.agentModel;
    this.#modelSwitcher = options.modelSwitcher;
    this.#telegramApi = options.telegramApi;
    this.#bot = options.bot;
    this.#additionalTools = options.additionalTools;
    this.#directImageLoader = options.directImageLoader;
    this.#modelGate = options.modelGate ?? new KeyedSemaphore();
    this.#contextBuilder = new ContextBuilder(options.store, options.config);
  }
  validateAdditionalTools(context: InvocationContext, additionalTools: readonly AgentTool[]): void {
    const send = createSendTool({
      store: this.#store,
      api: this.#telegramApi,
      context,
      stickerCapabilities: new Map(),
      maxSends: this.#config.agent.max_sends,
      deadline: Number.MAX_SAFE_INTEGER,
      bot: this.#bot,
    });
    validateToolRegistry([send, ...additionalTools], this.#model.contextWindow);
  }

  async run(invocationId: bigint, schedulerSignal: AbortSignal): Promise<InvocationOutcome> {
    // Resolved at session start: a runtime model switch applies from here on,
    // never to an invocation already in flight.
    const model = this.#modelSwitcher.model();
    const state: ToolRuntimeState = { stickerCapabilities: new Map() };
    const provisionalContext = this.#contextBuilder.build(
      invocationId,
      model.contextWindow,
      0,
      model.maxTokens,
      model.input.includes("image"),
    );
    const deadline = Date.now() + this.#config.agent.timeout_seconds * 1000;
    const preliminarySend = createSendTool({
      store: this.#store,
      api: this.#telegramApi,
      context: provisionalContext,
      stickerCapabilities: state.stickerCapabilities,
      maxSends: this.#config.agent.max_sends,
      deadline,
      bot: this.#bot,
    });
    const preliminaryTools = [preliminarySend, ...(this.#additionalTools?.(provisionalContext, state, deadline) ?? [])];
    const schemaCharacters = preliminaryTools.reduce((total, tool) => total + JSON.stringify(tool.parameters).length, 0);
    const context = this.#contextBuilder.build(
      invocationId,
      model.contextWindow,
      schemaCharacters,
      model.maxTokens,
      model.input.includes("image"),
    );
    const send = createSendTool({
      store: this.#store,
      api: this.#telegramApi,
      context,
      stickerCapabilities: state.stickerCapabilities,
      maxSends: this.#config.agent.max_sends,
      deadline,
      bot: this.#bot,
    });
    const tools = [send, ...(this.#additionalTools?.(context, state, deadline) ?? [])];
    validateToolRegistry(tools, model.contextWindow);
    const toolRegistryHash = createHash("sha256")
      .update(tools.map((tool) => `${tool.name}:${JSON.stringify(tool.parameters)}`).join("\n"))
      .digest("hex");
    // Auditable snapshot of exactly what the model could see: name, label and
    // description are the tool surface the provider serializes into every request.
    const toolRegistry = tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description }));
    this.#store.db
      .query("UPDATE invocations SET tool_registry_hash = ?, tool_registry_json = ? WHERE id = ?")
      .run(toolRegistryHash, JSON.stringify(toolRegistry), invocationId);
    const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const signal = AbortSignal.any([schedulerSignal, timeoutSignal]);
    let turns = 0;
    let toolCalls = 0;
    let estimatedInputTokens = Math.ceil((context.systemPrompt.length + context.userPrompt.length + schemaCharacters) / 4);
    let closing = false;
    let modelBudgetBlocked = false;
    let sendUsed = false;
    let nudged = false;
    const agent = new Agent({
      initialState: {
        systemPrompt: context.systemPrompt,
        model,
        thinkingLevel: this.#config.agent.thinking_level,
        tools,
      },
      streamFn: async (model, modelContext, options) => {
        if (this.#tokenBudgetReached(context.chatId)) {
          modelBudgetBlocked = true;
          return errorStream(model, "chat_token_budget");
        }
        const release = await this.#modelGate.acquire(context.chatId.toString(), signal);
        // Per-request visibility audit: the exact tool names this llmContext
        // carried (the loop can trim tools to send-only near the context limit).
        const callId = this.#startModelCall(invocationId, model, modelContext.tools?.map((tool) => tool.name) ?? []);
        try {
          const stream = this.#models.streamSimple(model, modelContext, {
            ...options,
            signal,
            maxTokens: model.maxTokens,
            maxRetries: 2,
            maxRetryDelayMs: Math.max(0, deadline - Date.now()),
          });
          void stream.result().then(
            (message) => {
              estimatedInputTokens = Math.max(estimatedInputTokens, message.usage.input);
              this.#finishModelCall(callId, context.chatId, message);
            },
            () => this.#failModelCall(callId, "stream_rejected"),
          ).finally(release);
          return stream;
        } catch (error) {
          release();
          this.#failModelCall(callId, "model_setup_error");
          return errorStream(model, error instanceof Error ? error.name : "model_setup_error");
        }
      },
      toolExecution: "sequential",
      maxRetryDelayMs: Math.max(0, deadline - Date.now()),
      beforeToolCall: async () => {
        toolCalls += 1;
        if (toolCalls > this.#config.agent.max_tool_calls) return { block: true, reason: "Invocation tool-call limit reached", terminate: true };
        this.#store.db.query("UPDATE invocations SET tool_calls_used = ? WHERE id = ?").run(BigInt(toolCalls), invocationId);
        return undefined;
      },
      shouldStopAfterTurn: async (turn) => {
        if (turns >= this.#config.agent.max_turns || closing) return true;
        const stopThreshold = Math.floor(model.contextWindow * this.#config.agent.context_stop_ratio);
        if (estimatedInputTokens + model.maxTokens >= model.contextWindow && estimatedInputTokens >= stopThreshold) {
          return true;
        }
        // Safety net: the agent is about to stop naturally. If it drafted a
        // group-facing reply as private text and never called send, remind it
        // once. Only when this turn produced no tool calls (a would-be final
        // message), so we never interrupt an in-progress tool workflow.
        if (this.#config.agent.send_nudge_enabled === true && !sendUsed && !nudged) {
          const hasToolCalls = turn.message.content.some((entry) => entry.type === "toolCall");
          const text = turn.message.content
            .filter((entry) => entry.type === "text")
            .map((entry) => entry.text)
            .join("");
          if (!hasToolCalls && text.length >= SEND_NUDGE_MIN_TEXT_CHARS) {
            nudged = true;
            agent.steer({ role: "user", content: [{ type: "text", text: SEND_NUDGE_TEXT }], timestamp: Date.now() });
            this.#recordAgentMessage(invocationId, "harness_nudge", SEND_NUDGE_TEXT);
          }
        }
        return false;
      },
      prepareNextTurnWithContext: async (turn) => {
        const stopThreshold = Math.floor(model.contextWindow * this.#config.agent.context_stop_ratio);
        if (estimatedInputTokens < stopThreshold) return undefined;
        closing = true;
        const sendOnly = turn.context.tools?.filter((tool) => tool.name === "send");
        return { context: { ...turn.context, ...(sendOnly === undefined ? {} : { tools: sendOnly }) } };
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_end") {
        turns += 1;
        this.#store.db.query("UPDATE invocations SET turns_used = ? WHERE id = ?").run(BigInt(turns), invocationId);
      }
      if (event.type === "tool_execution_end" && event.toolName === "send") {
        sendUsed = true;
      }
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant") {
        const text = event.message.content
          .filter((entry) => entry.type === "text")
          .map((entry) => entry.text)
          .join("");
        this.#recordAgentMessage(invocationId, "assistant", text);
      } else if (event.message.role === "toolResult") {
        const text = event.message.content
          .filter((entry) => entry.type === "text")
          .map((entry) => entry.text)
          .join("");
        estimatedInputTokens += Math.ceil(text.length / 4);
        this.#recordAgentMessage(invocationId, "tool_result", text);
      }
    });
    const abortAgent = (): void => agent.abort();
    signal.addEventListener("abort", abortAgent, { once: true });
    try {
      const directImages = await this.#directImageLoader?.(context, signal) ?? [];
      await agent.prompt(context.userPrompt, [...directImages]);
    } finally {
      signal.removeEventListener("abort", abortAgent);
    }
    if (signal.aborted) {
      const unknown = this.#store.db
        .query<{ present: bigint }, [bigint]>(
          "SELECT 1 AS present FROM tool_calls WHERE invocation_id = ? AND state = 'outcome_unknown' LIMIT 1",
        )
        .get(invocationId) !== null;
      return { state: unknown ? "outcome_unknown" : "aborted", reason: timeoutSignal.aborted ? "timeout" : "aborted" };
    }
    if (modelBudgetBlocked) return { state: "failed", reason: "chat_token_budget" };
    if (agent.state.errorMessage !== undefined) return { state: "failed", reason: "model_error" };
    return { state: "completed", reason: closing ? "context_limit" : "completed" };
  }

  #startModelCall(invocationId: bigint, model: Model<Api>, tools: readonly string[]): bigint {
    const created = this.#store.db
      .query("INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, tools_json, created_at) VALUES (?, 'agent', ?, ?, 1, 'pending', ?, ?)")
      .run(invocationId, model.provider, model.id, JSON.stringify(tools), new Date().toISOString());
    return BigInt(created.lastInsertRowid);
  }

  #finishModelCall(callId: bigint, chatId: bigint, message: AssistantMessage): void {
    this.#store.transaction(() => {
      const usage = message.usage;
      const now = new Date().toISOString();
      this.#store.db
        .query("UPDATE model_calls SET state = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?, cost = ?, finished_at = ? WHERE id = ?")
        .run(
          message.stopReason === "error" || message.stopReason === "aborted" ? "error" : "success",
          BigInt(usage.input),
          BigInt(usage.output),
          BigInt(usage.cacheRead),
          BigInt(usage.cacheWrite),
          BigInt(usage.totalTokens),
          usage.cost.total,
          now,
          callId,
        );
      this.#store.db
        .query("INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?) ON CONFLICT(utc_date, scope, resource, metric) DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at")
        .run(now.slice(0, 10), chatId.toString(), BigInt(usage.totalTokens), now);
    });
  }

  #failModelCall(callId: bigint, errorCode: string): void {
    this.#store.db
      .query("UPDATE model_calls SET state = 'error', error_code = ?, finished_at = ? WHERE id = ? AND state = 'pending'")
      .run(errorCode, new Date().toISOString(), callId);
  }

  #tokenBudgetReached(chatId: bigint): boolean {
    let chat = this.#config.telegram.chats.find((candidate) => BigInt(candidate.id) === chatId);
    if (chat === undefined) {
      const migration = this.#store.db
        .query<{ old_chat_id: bigint }, [bigint]>("SELECT old_chat_id FROM chat_migrations WHERE new_chat_id = ?")
        .get(chatId);
      if (migration !== null) {
        chat = this.#config.telegram.chats.find((candidate) => BigInt(candidate.id) === migration.old_chat_id);
      }
    }
    if (chat === undefined) return true;
    const date = new Date().toISOString().slice(0, 10);
    const amount = this.#store.db
      .query<{ amount: bigint }, [string, string]>(
        "SELECT amount FROM daily_usage WHERE utc_date = ? AND scope = 'chat' AND resource = ? AND metric = 'model_tokens'",
      )
      .get(date, chatId.toString())?.amount ?? 0n;
    return amount >= BigInt(chat.budget.max_tokens_per_day);
  }

  #recordAgentMessage(invocationId: bigint, role: "assistant" | "tool_result" | "harness_nudge", text: string): void {
    const sequence = this.#store.db
      .query<{ value: bigint }, [bigint]>("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS value FROM agent_messages WHERE invocation_id = ?")
      .get(invocationId)?.value ?? 1n;
    this.#store.db
      .query("INSERT INTO agent_messages(invocation_id, sequence_no, role, text, thinking_text, created_at) VALUES (?, ?, ?, ?, '', ?)")
      .run(invocationId, sequence, role, text, new Date().toISOString());
  }
}

function validateToolRegistry(tools: readonly AgentTool[], contextWindow: number): void {
  if (tools.length > 64) throw new Error(`Tool registry has ${tools.length} tools; maximum is 64`);
  const characters = tools.reduce((total, tool) => total + JSON.stringify(tool.parameters).length, 0);
  if (characters / 4 > contextWindow * 0.1) throw new Error("Tool registry exceeds 10% of the model context window");
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
}

function errorStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

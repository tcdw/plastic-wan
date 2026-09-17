import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileConfig, RawConfig } from '../src/platform/config.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, SystemResources } from '../src/platform/system-resources.ts';
import type {
  DirectImage,
  InvocationContext,
  CapabilityRefResolver,
  VisibleSender,
} from '../src/platform/invocation-context.ts';
import type { PromptTemplateModel } from '../src/platform/prompt-template.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { ContextRefStore, createCapabilityResolver } from '../src/context/context-refs.ts';
import { ConversationContextStore, type ContextHeader } from '../src/context/context-store.ts';
import type { SqliteStore } from '../src/store/database.ts';
import { invocations } from '../src/store/schema.ts';
import { eq } from 'drizzle-orm';

/**
 * Reference resolver bound to one Conversation Context, exactly as the runtime
 * builds it. Tests use it to authorize `img_` / `stk_` / reply refs without
 * hand-rolling a resolver per file.
 */
export function invocationCapabilities(
  store: SqliteStore,
  config: RawConfig,
  header: ContextHeader,
): CapabilityRefResolver {
  const refs = new ContextRefStore(store, { ttlHours: config.agent.context.ref_ttl_hours });
  return createCapabilityResolver(refs, header);
}

/** Loads the real bundled system:/// resource tree for integration-style tests. */
export function bundledSystemResources(): Promise<SystemResources> {
  return SystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR);
}

export interface TestContextOptions {
  readonly contextWindow?: number;
  readonly toolDefinitionCharacters?: number;
  readonly maxOutputTokens?: number;
  readonly supportsImages?: boolean;
  readonly agentModel?: PromptTemplateModel;
  readonly sleepy?: boolean;
  /** Render the batch of another bucket attached to the same invocation. */
  readonly bucketId?: bigint;
  /** Telegram message IDs the retained transcript already carries. */
  readonly injectedMessageIds?: ReadonlySet<string>;
  /** The sticker catalog the retained transcript already carries. */
  readonly carriedStickerCatalog?: string | null;
  readonly skills?: SystemResources;
}

export interface TestInvocationContext extends InvocationContext {
  readonly conversationId: bigint;
  readonly header: ContextHeader;
  readonly imageCapabilities: ReadonlyMap<string, bigint>;
  readonly replyTargets: ReadonlyMap<string, { readonly conversationId: bigint; readonly threadId: bigint }>;
  readonly directImages: readonly DirectImage[];
  readonly visibleSenders: ReadonlyMap<string, VisibleSender>;
  readonly callerUserId: bigint | null;
  readonly omittedNewMessages: number;
}

/**
 * Assembles the two halves of a run's prompt the way the runtime does — the
 * stable system prompt and one injected batch — for tests that assert on
 * rendered context instead of driving a full invocation.
 */
export function renderInvocationContext(
  store: SqliteStore,
  config: RawConfig,
  invocationId: bigint,
  options: TestContextOptions = {},
): TestInvocationContext {
  const refs = new ContextRefStore(store, { ttlHours: config.agent.context.ref_ttl_hours });
  const builder = new ContextBuilder(store, config, refs, options.skills?.skills ?? []);
  const identity = builder.identity(invocationId);
  const supportsImages = options.supportsImages ?? false;
  const stable = builder.buildSystemPrompt(
    identity,
    supportsImages,
    options.agentModel ?? {
      provider: config.agent.provider,
      model: config.agent.model,
    },
  );
  const contexts = new ConversationContextStore(store);
  const { header } = contexts.open(identity.conversationId, stable.systemPromptHash);
  const bucketId =
    options.bucketId ??
    store.orm.select({ bucketId: invocations.bucketId }).from(invocations).where(eq(invocations.id, invocationId)).get()
      ?.bucketId;
  if (bucketId === undefined) {
    throw new Error(`Invocation ${invocationId} has no bucket`);
  }
  const injection = builder.renderInjection({
    header,
    identity,
    bucketId,
    seq: header.nextSeq,
    injectedMessageIds: options.injectedMessageIds ?? new Set<string>(),
    sleepy: options.sleepy ?? false,
    supportsImages,
    contextWindow: options.contextWindow ?? 200_000,
    toolDefinitionCharacters: options.toolDefinitionCharacters ?? 0,
    maxOutputTokens: options.maxOutputTokens ?? 32_768,
    transcriptCharacters: 0,
    carriedStickerCatalog: options.carriedStickerCatalog ?? null,
    agentModel: options.agentModel ?? { provider: config.agent.provider, model: config.agent.model },
  });
  const replyTargets = new Map(
    [...refsReplyTargets(store, header)].map(
      (entry) => [entry.messageId, { conversationId: entry.conversationId, threadId: entry.threadId }] as const,
    ),
  );
  return {
    invocationId,
    chatId: identity.chatId,
    threadId: identity.threadId,
    alarm: identity.alarm,
    systemPrompt: stable.systemPrompt,
    userPrompt: injection.text,
    conversationId: identity.conversationId,
    header,
    imageCapabilities: injection.mediaRefs,
    replyTargets,
    directImages: injection.directImages,
    visibleSenders: new Map(injection.visibleSenders.map((sender) => [sender.userId.toString(), sender])),
    callerUserId: injection.callerUserId,
    omittedNewMessages: injection.omittedNewMessages,
  };
}

/** Reply refs registered for a context, resolved back into their targets. */
function refsReplyTargets(
  store: SqliteStore,
  header: ContextHeader,
): { messageId: string; conversationId: bigint; threadId: bigint }[] {
  return store.db
    .query<{ ref: string; target_conversation_id: bigint; target_thread_id: bigint }, [bigint]>(
      "SELECT ref, target_conversation_id, target_thread_id FROM context_refs WHERE context_id = ? AND kind = 'reply'",
    )
    .all(header.id)
    .map((row) => ({
      messageId: row.ref.slice('reply:'.length),
      conversationId: row.target_conversation_id,
      threadId: row.target_thread_id,
    }));
}

export function testConfigJsonc(directory: string, transform?: (config: FileConfig) => void): string {
  const path = (name: string) => join(directory, name).replaceAll('\\', '/');
  const config: FileConfig = {
    version: 1,
    data_dir: path('data'),
    timezone: 'UTC',
    telegram: {
      token: 'telegram-secret',
      process_bot_messages: false,
      bucket_window_seconds: 15,
      chats: [
        {
          id: 123456789,
          instructions_file: 'chat-instructions.md',
        },
      ],
    },
    providers: {
      agent: {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: 'agent-secret',
        models: [
          {
            id: 'agent-model',
            name: 'Agent Model',
            reasoning: true,
            compat: { supports_developer_role: false },
            input: ['text', 'image'],
            context_window: 200000,
            max_tokens: 32768,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          },
        ],
      },
      vision: {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: 'vision-secret',
        models: [
          {
            id: 'vision-model',
            name: 'Vision Model',
            reasoning: false,
            input: ['text', 'image'],
            context_window: 128000,
            max_tokens: 8192,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          },
        ],
      },
    },
    agent: {
      provider: 'agent',
      model: 'agent-model',
      daily_budget: { max_tokens: 300000 },
      thinking_level: 'low',
      system_prompt_file: 'agent-system-prompt.md',
      max_concurrency: 4,
      context_stop_ratio: 0.8,
      history_messages: 20,
      send_nudge_enabled: true,
      context: {
        retained_sends_target: 2,
        retained_sends_max: 3,
        hard_token_ratio: 0.6,
        ref_ttl_hours: 72,
        idle_grace_seconds: 0,
        max_wall_clock_seconds: 900,
        agent_cache_size: 8,
      },
      rate_limits: {
        sends_per_window: 6,
        window_seconds: 300,
        turns_per_injection: 8,
      },
    },
    vision: {
      provider: 'vision',
      model: 'vision-model',
      max_output_tokens: 2048,
      max_concurrency: 2,
      background_sticker_concurrency: 1,
      prompt_version: 1,
      daily_budget: {
        max_tokens: 200000,
        max_images: 200,
      },
    },
    retention: {
      online_days: 30,
      backup_copies: 7,
    },
    paths: {
      database: path('plasticwan.sqlite'),
      media_cache: path('media'),
      backups: path('backups'),
    },
  };
  transform?.(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function writeTestConfig(
  directory: string,
  configPath: string,
  jsonc: string = testConfigJsonc(directory),
  systemPrompt = 'Participate safely.',
  chatInstructions = 'private',
): Promise<void> {
  await writeFile(join(directory, 'agent-system-prompt.md'), systemPrompt);
  await writeFile(join(directory, 'chat-instructions.md'), chatInstructions);
  await writeFile(configPath, jsonc);
}

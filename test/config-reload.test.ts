import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BotCommandService, type CommandSender } from '../src/orchestration/bot-commands.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler, type InvocationOutcome } from '../src/orchestration/scheduler.ts';
import { type FileConfig, type LoadedConfig, loadConfig } from '../src/platform/config.ts';
import { readConfigRevision } from '../src/platform/config-file.ts';
import { ConfigReloader } from '../src/platform/config-reload.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { createModelRegistry, type ModelRegistry } from '../src/platform/providers.ts';
import { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SystemResources } from '../src/platform/system-resources.ts';
import { seedConfigAdmins } from '../src/store/admins.ts';
import { SqliteStore } from '../src/store/database.ts';
import type { TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { sleep, testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const CHAT_ID = 123456789;
const ADMIN: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
const AGENT_MODEL = 'deepseek-v4-flash';
const SECOND_MODEL = 'agent-model-2';
const captured: string[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn> | undefined;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

afterEach(() => {
  consoleSpy?.mockRestore();
  consoleSpy = undefined;
  captured.length = 0;
});

function logEvents(event: string): Record<string, unknown>[] {
  return captured
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type ProviderEntry = FileConfig['providers'][string];
type ModelEntry = Extract<ProviderEntry, { kind: 'custom' }>['models'][number];

function customProvider(
  providers: Readonly<Record<string, ProviderEntry>>,
  alias: string,
): Extract<ProviderEntry, { kind: 'custom' }> {
  const provider = providers[alias];
  if (provider === undefined || provider.kind !== 'custom') {
    throw new Error(`Expected a custom provider fixture: ${alias}`);
  }
  return provider;
}

function builtinProvider(
  providers: Readonly<Record<string, ProviderEntry>>,
  alias: string,
): Extract<ProviderEntry, { kind: 'builtin' }> {
  const provider = providers[alias];
  if (provider === undefined || provider.kind !== 'builtin') {
    throw new Error(`Expected a builtin provider fixture: ${alias}`);
  }
  return provider;
}

function model(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    ...overrides,
  };
}

/** Counts SecretRef resolutions so a reload can be shown not to run one again. */
class CountingSecrets extends SecretStore {
  resolutions = 0;

  override async resolve(reference: Parameters<SecretStore['resolve']>[0]): Promise<string> {
    this.resolutions += 1;
    return await super.resolve(reference);
  }
}

/**
 * The agent runs on a faux provider registered under a builtin alias: the file
 * declares that alias's models (a builtin provider registers exactly the models
 * the configuration enables) and the tests then swap in the faux provider, so
 * the registry owns the streaming behavior while the custom `agent` / `vision`
 * providers stay available for the provider-level reload cases.
 */
function baseConfig(config: FileConfig): void {
  config.telegram.admins = [42];
  config.agent.send_nudge_enabled = false;
  config.providers.faux = {
    kind: 'builtin',
    provider: 'deepseek',
    api_key: 'faux-secret',
    models: [
      model(AGENT_MODEL, { reasoning: true, input: ['text', 'image'], context_window: 200_000, max_tokens: 32_768 }),
      model(SECOND_MODEL, { reasoning: true }),
    ],
  };
  config.agent.provider = 'faux';
  config.agent.model = AGENT_MODEL;
  config.agent.thinking_level = 'low';
}

function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'faux',
    models: [
      { id: AGENT_MODEL, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768, reasoning: true },
      { id: SECOND_MODEL, input: ['text'], contextWindow: 128_000, maxTokens: 8_192, reasoning: true },
    ],
  });
}

interface Fixture {
  readonly directory: string;
  readonly configPath: string;
  readonly loaded: LoadedConfig;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly registry: ModelRegistry;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly reloader: ConfigReloader;
  readonly ingestion: TelegramIngestion;
  readonly conversationRuntime: ConversationRuntime;
  readonly commands: BotCommandService;
  readonly scheduler: BucketScheduler;
  readonly sendApi: TelegramSendApi;
  readonly sends: string[];
  file(): FileConfig;
  /** Rewrites the file from the current one with `transform` applied. */
  patch(transform: (config: FileConfig) => void): Promise<void>;
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  /** Builds a runtime over `faux`, replacing the registry's `faux` provider. */
  runtimeWith(faux: ReturnType<typeof fauxProvider>): AgentRuntime;
}

async function setup(
  options: {
    readonly transform?: (config: FileConfig) => void;
    readonly secrets?: SecretStore;
    /** Extra files written before the configuration is loaded. */
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-reload-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      baseConfig(config);
      options.transform?.(config);
    }),
  );
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(directory, name), content);
  }
  const loaded = await loadConfig(configPath);
  let fileConfig = structuredClone(loaded.fileConfig);
  const store = await SqliteStore.open(loaded.config);
  seedConfigAdmins(store.orm, loaded.config.telegram.admins ?? []);
  const configStore = new RuntimeConfigurationStore(loaded);
  // One store for the registry and the reloader, exactly as the composition root
  // wires it: credentials are resolved once, at startup.
  const secrets = options.secrets ?? new SecretStore();
  const registry = await createModelRegistry(loaded.config, secrets);
  const modelSwitcher = new AgentModelSwitcher(configStore, registry.models);
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: loaded.config.agent.context.agent_cache_size,
  });
  const sends: string[] = [];
  let messageId = 900;
  const sendApi: TelegramSendApi = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_ID } }),
  };
  let runtime: AgentRuntime | undefined;
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    models: registry.models,
    modelSwitcher,
    secrets,
    // The pipeline tests build a runtime; without one there is no tool registry
    // to fit into a context window, so the check has nothing to reject.
    validateAgentModel: (candidate) => runtime?.validateAdditionalTools(previewContext(), [], candidate),
    onPublished: () => undefined,
  });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const commands = new BotCommandService(store, configStore, scheduler, modelSwitcher, conversationRuntime, reloader);
  consoleSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    captured.push(String(line));
  });
  return {
    directory,
    configPath,
    loaded,
    store,
    configStore,
    registry,
    modelSwitcher,
    reloader,
    ingestion,
    conversationRuntime,
    commands,
    scheduler,
    sendApi,
    sends,
    file: () => fileConfig,
    patch: async (transform) => {
      const next = structuredClone(fileConfig);
      transform(next);
      fileConfig = next;
      await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
      await restrictConfig(configPath);
    },
    writeText: async (text) => {
      await writeFile(configPath, text);
      await restrictConfig(configPath);
    },
    readText: () => readFile(configPath, 'utf8'),
    runtimeWith: (faux) => {
      registry.models.setProvider(faux.provider);
      runtime = new AgentRuntime({
        store,
        configStore,
        secrets,
        registry,
        telegramApi: sendApi,
        bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
        systemResources: SystemResources.empty(),
        conversationRuntime,
      });
      return runtime;
    },
  };
}

/** `serve` and the reload path demand mode 0600; Windows has no such check. */
async function restrictConfig(configPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o600);
  }
}

function contextRows(
  store: SqliteStore,
): { readonly seq: bigint; readonly role: string; readonly payload_json: string }[] {
  return store.db
    .prepare<[], { seq: bigint; role: string; payload_json: string }>(
      'SELECT seq, role, payload_json FROM context_messages ORDER BY seq',
    )
    .all();
}

function transcript(store: SqliteStore): string {
  return contextRows(store)
    .map((row) => `${row.seq}:${row.role}:${row.payload_json}`)
    .join('\n');
}

/** Marks an invocation and its bucket terminal, as the scheduler would. */
function settle(fixture: Fixture, invocationId: bigint): void {
  fixture.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  fixture.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
}

/** Runs one invocation outside the scheduler and closes it out. */
async function runDirect(fixture: Fixture, runtime: AgentRuntime, invocationId: bigint): Promise<InvocationOutcome> {
  const outcome = await runtime.run(invocationId, fixture.configStore.beginInvocation(), new AbortController().signal);
  settle(fixture, invocationId);
  return outcome;
}

test('applies a hot field and reports both hashes', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.agent.thinking_level = 'high';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.thinking_level']);
    expect(result.restartRequired).toEqual([]);
    expect(result.outsideServe).toEqual([]);
    expect(result.status.generation).toBe(2);
    expect(fixture.configStore.current().config.agent.thinking_level).toBe('high');
    const event = logEvents('config_reloaded').at(-1);
    expect(event).toMatchObject({
      generation: 2,
      applied: 'agent.thinking_level',
      restart_required: '',
      outside_serve: '',
    });
    expect(event?.active_hash).toBe(result.status.activeHash);
    expect(event?.file_hash).toBe(result.status.fileHash);
    // Nothing is pending, so the active configuration is exactly the file and
    // its hash stays comparable with `check-config` output.
    expect(result.status.activeHash).toBe(result.status.fileHash);
    expect(result.status.activeHash).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    fixture.store.close();
  }
});

test('keeps the active configuration when the file is invalid', async () => {
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    const cases: readonly (readonly [string, () => Promise<void>])[] = [
      ['jsonc', () => fixture.writeText('{ "version": 1, ')],
      [
        'schema',
        () =>
          fixture.patch((config) => {
            config.telegram.bucket_window_seconds = 301;
          }),
      ],
      [
        'prompt',
        () =>
          fixture.patch((config) => {
            config.agent.system_prompt_file = 'missing-prompt.md';
          }),
      ],
    ];
    for (const [label, write] of cases) {
      await write();
      const result = await fixture.reloader.reloadFromFile();
      expect(result.ok, label).toBe(false);
      if (result.ok) {
        throw new Error(`Expected ${label} to fail`);
      }
      expect(result.code, label).toBe('config_invalid');
      expect(fixture.configStore.current(), label).toBe(before);
      expect(fixture.reloader.status().lastError?.code, label).toBe('config_invalid');
    }
    expect(logEvents('config_reload_failed')).toHaveLength(3);
    expect(fixture.reloader.status().generation).toBe(1);
  } finally {
    fixture.store.close();
  }
});

test('refuses a candidate whose model cannot run the tool registry', async () => {
  const fixture = await setup();
  try {
    const faux = fauxProvider({
      provider: 'faux',
      models: [
        { id: AGENT_MODEL, input: ['text'], contextWindow: 200_000, maxTokens: 32_768 },
        { id: 'tiny-model', input: ['text'], contextWindow: 1_000, maxTokens: 512 },
      ],
    });
    fixture.runtimeWith(faux);
    await fixture.patch((config) => {
      builtinProvider(config.providers, 'faux').models.push(
        model('tiny-model', { context_window: 1_000, max_tokens: 512 }),
      );
      config.agent.model = 'tiny-model';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the tiny model to be refused');
    }
    expect(result.code).toBe('model_unusable');
    expect(result.message).toMatch(/10% of the model context window/);
    expect(fixture.configStore.current().config.agent.model).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});

test('refuses a builtin model the file does not list', async () => {
  const fixture = await setup();
  try {
    // A builtin provider's models come from the file, so an unregistered
    // reference is a file error: `check-config` rejects it before a reload does.
    await fixture.patch((config) => {
      config.agent.model = 'no-such-model';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the unknown model to be refused');
    }
    expect(result.code).toBe('config_invalid');
    expect(result.message).toContain('no-such-model');
    expect(fixture.configStore.current().config.agent.model).toBe(AGENT_MODEL);
  } finally {
    fixture.store.close();
  }
});

test('rejects a candidate that is only invalid together with a pending restart field', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 30;
      config.agent.context.idle_grace_seconds = 30;
    },
  });
  try {
    // Both values are valid in the file (10 >= 5), but the running process keeps
    // bucket_window_seconds = 30 until it restarts, so 10 < 30 is invalid here.
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent.context.idle_grace_seconds = 10;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the candidate to be rejected');
    }
    expect(result.code).toBe('candidate_invalid');
    expect(result.message).toContain('after a restart');
    expect(result.message).toContain('telegram.bucket_window_seconds');
    expect(fixture.configStore.current().config.telegram.bucket_window_seconds).toBe(30);
    expect(fixture.configStore.current().config.agent.context.idle_grace_seconds).toBe(30);
  } finally {
    fixture.store.close();
  }
});

test('removing a chat and its instructions file together still reloads', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.chats = [
        { id: CHAT_ID, instructions_file: 'chat-instructions.md' },
        { id: 111, instructions_file: 'second-chat.md' },
      ];
    },
    files: { 'second-chat.md': 'second chat instructions' },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.chats = [{ id: CHAT_ID, instructions_file: 'chat-instructions.md' }];
      config.agent.thinking_level = 'high';
    });
    await rm(join(fixture.directory, 'second-chat.md'), { force: true });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.thinking_level']);
    expect(result.restartRequired).toEqual(['telegram.chats[111]']);
    // The removed chat waits for a restart and keeps the active instructions.
    expect(fixture.configStore.current().config.telegram.chats.map((chat) => chat.id)).toEqual([CHAT_ID, 111]);
  } finally {
    fixture.store.close();
  }
});

test('applies hot fields while restart-only fields wait, and keeps waiting afterwards', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.agent.thinking_level = 'high';
      config.telegram.bucket_window_seconds = 30;
    });
    const first = await fixture.reloader.reloadFromFile();
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.message);
    }
    expect(first.applied).toEqual(['agent.thinking_level']);
    expect(first.restartRequired).toEqual(['telegram.bucket_window_seconds']);
    expect(first.status.generation).toBe(2);
    expect(fixture.configStore.current().config.telegram.bucket_window_seconds).toBe(15);
    expect(fixture.configStore.current().hash).not.toBe(first.status.fileHash);

    await fixture.patch((config) => {
      config.agent.thinking_level = 'medium';
    });
    const second = await fixture.reloader.reloadFromFile();
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.message);
    }
    expect(second.applied).toEqual(['agent.thinking_level']);
    expect(second.restartRequired).toEqual(['telegram.bucket_window_seconds']);
    expect(second.status.generation).toBe(3);
    expect(fixture.configStore.current().config.agent.thinking_level).toBe('medium');
  } finally {
    fixture.store.close();
  }
});

test('reverting a pending restart field brings the active hash back to the file hash', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.agent.thinking_level = 'high';
      config.telegram.bucket_window_seconds = 30;
    });
    const pending = await fixture.reloader.reloadFromFile();
    expect(pending.ok).toBe(true);
    if (!pending.ok) {
      throw new Error(pending.message);
    }
    expect(pending.status.activeHash).not.toBe(pending.status.fileHash);

    // The active configuration already equals this file: only its identity moves.
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 15;
    });
    const reverted = await fixture.reloader.reloadFromFile();
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) {
      throw new Error(reverted.message);
    }
    expect(reverted.applied).toEqual([]);
    expect(reverted.restartRequired).toEqual([]);
    expect(reverted.status.activeHash).toBe(reverted.status.fileHash);
    expect(reverted.status.generation).toBe(3);
    expect(fixture.configStore.current().config.agent.thinking_level).toBe('high');
  } finally {
    fixture.store.close();
  }
});

test('a comment-only edit moves the active hash to the new file hash', async () => {
  const fixture = await setup();
  try {
    await fixture.writeText(`// operator note\n${await fixture.readText()}`);
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.status.fileHash).not.toBe(fixture.loaded.hash);
    expect(result.status.activeHash).toBe(result.status.fileHash);
  } finally {
    fixture.store.close();
  }
});

test('a model switch refused before writing leaves the apply status alone', async () => {
  const fixture = await setup();
  try {
    const result = await fixture.reloader.setAgentModel('agent', 'ghost-model');
    expect(result).toMatchObject({ ok: false, code: 'unknown_model', fileWritten: false });
    // No reload ran, so the status keeps describing the last apply.
    expect(fixture.reloader.status().lastError).toBeNull();
    expect(logEvents('model_switch_failed').at(-1)).toMatchObject({ code: 'unknown_model' });
    expect(logEvents('config_reload_failed')).toEqual([]);
  } finally {
    fixture.store.close();
  }
});

test('treats a new chat as restart-only and an instructions edit as hot', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.telegram.chats = [
        { id: CHAT_ID, instructions_file: 'chat-instructions.md' },
        { id: 111, instructions_file: 'chat-instructions.md' },
      ];
    });
    const added = await fixture.reloader.reloadFromFile();
    expect(added.ok).toBe(true);
    if (!added.ok) {
      throw new Error(added.message);
    }
    expect(added.restartRequired).toEqual(['telegram.chats[111]']);
    expect(added.applied).toEqual([]);
    expect(fixture.configStore.current().config.telegram.chats.map((chat) => chat.id)).toEqual([CHAT_ID]);
    expect(fixture.reloader.status().generation).toBe(1);

    await fixture.patch((config) => {
      config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
    });
    const chatField = await fixture.reloader.reloadFromFile();
    expect(chatField.ok).toBe(true);
    if (!chatField.ok) {
      throw new Error(chatField.message);
    }
    expect(chatField.restartRequired).toEqual(['telegram.chats[111]', 'telegram.chats[123456789].timezone']);
    expect(fixture.configStore.current().config.telegram.chats[0]?.timezone).toBeUndefined();

    // Only the instructions file changes; the configuration file is untouched.
    await writeFile(join(fixture.directory, 'chat-instructions.md'), 'updated instructions');
    const instructions = await fixture.reloader.reloadFromFile();
    expect(instructions.ok).toBe(true);
    if (!instructions.ok) {
      throw new Error(instructions.message);
    }
    expect(instructions.applied).toEqual(['telegram.chats[123456789].instructions_file']);
    expect(fixture.configStore.current().config.telegram.chats[0]?.instructions).toBe('updated instructions');
  } finally {
    fixture.store.close();
  }
});

test('a reload during a run does not reach that run', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent.send_max_text_length = 10;
    },
  });
  try {
    const faux = fauxAgent();
    const prompts: string[] = [];
    faux.setResponses([
      async (context) => {
        prompts.push(context.systemPrompt ?? '');
        await writeFile(join(fixture.directory, 'agent-system-prompt.md'), 'A prompt for later runs.');
        await fixture.patch((config) => {
          config.agent.send_max_text_length = 1_000;
        });
        const reloaded = await fixture.reloader.reloadFromFile();
        expect(reloaded.ok).toBe(true);
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'x'.repeat(20) }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('done');
      },
    ]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    const outcome = await runDirect(fixture, runtime, invocationId);
    expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
    expect(prompts).toHaveLength(2);
    // The published prompt never reaches the run that is already in flight.
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).toContain('Participate safely.');
    expect(prompts[1]).not.toContain('A prompt for later runs.');
    // The send limit comes from the snapshot too.
    expect(
      fixture.store.db
        .prepare<[bigint], { error_code: string | null }>(
          "SELECT error_code FROM tool_calls WHERE invocation_id = ? AND tool_name = 'send'",
        )
        .all(invocationId)
        .map((row) => row.error_code),
    ).toEqual(['send_text_too_long']);
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_sends').get()?.count,
    ).toBe(0n);
    // The reload did happen: the next run gets the new prompt and limit.
    expect(fixture.configStore.current().config.agent.send_max_text_length).toBe(1_000);
    expect(fixture.configStore.current().config.agent.system_prompt).toBe('A prompt for later runs.');
  } finally {
    fixture.store.close();
  }
});

test('the next invocation uses the reloaded configuration', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    const levels: (string | undefined)[] = [];
    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('first answer');
      },
    ]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    const [first] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (first === undefined) {
      throw new Error('Expected a queued invocation');
    }
    await runDirect(fixture, runtime, first);
    expect(levels).toEqual(['low']);
    await fixture.patch((config) => {
      config.agent.thinking_level = 'high';
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);

    faux.setResponses([
      (_context, options) => {
        levels.push(options?.reasoning);
        return fauxAssistantMessage('second answer');
      },
    ]);
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date(Date.now() + 120_000));
    const [second] = fixture.scheduler.processDue(new Date(Date.now() + 180_000));
    if (second === undefined) {
      throw new Error('Expected a second queued invocation');
    }
    await runDirect(fixture, runtime, second);
    expect(levels).toEqual(['low', 'high']);
  } finally {
    fixture.store.close();
  }
});

test('a bucket attached to a long-lived invocation keeps its snapshot', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 1;
      config.agent.context.idle_grace_seconds = 3;
      config.agent.context.max_wall_clock_seconds = 60;
    },
  });
  const faux = fauxAgent();
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  faux.setResponses([
    async (context) => {
      prompts.push(context.systemPrompt ?? '');
      await gate;
      return fauxAssistantMessage('first answer');
    },
    (context) => {
      prompts.push(context.systemPrompt ?? '');
      return fauxAssistantMessage('');
    },
  ]);
  const runtime = fixture.runtimeWith(faux);
  const scheduler = new BucketScheduler(
    fixture.store,
    fixture.configStore,
    (invocationId, snapshot, signal) => runtime.run(invocationId, snapshot, signal),
    fixture.conversationRuntime,
  );
  try {
    scheduler.start();
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    scheduler.wake();
    await until(() => prompts.length === 1, 'the first model call');

    // A second message collects its own window and attaches to the running run.
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date());
    scheduler.wake();
    await sleep(1_200);
    await writeFile(join(fixture.directory, 'agent-system-prompt.md'), 'A prompt for later runs.');
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    release();

    await until(() => prompts.length === 2, 'the attached batch');
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).not.toContain('A prompt for later runs.');
    expect(
      fixture.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocation_buckets').get()?.count,
    ).toBe(2n);
    expect(fixture.configStore.current().config.agent.system_prompt).toBe('A prompt for later runs.');
  } finally {
    release();
    await scheduler.stop();
    fixture.store.close();
  }
}, 30_000);

test('a prompt change rebuilds the Conversation Context on the next run', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    faux.setResponses([() => fauxAssistantMessage('first answer')]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    const [first] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (first === undefined) {
      throw new Error('Expected a queued invocation');
    }
    await runDirect(fixture, runtime, first);
    expect(transcript(fixture.store)).toContain('first answer');

    await writeFile(join(fixture.directory, 'agent-system-prompt.md'), 'A completely different system prompt.');
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      throw new Error(reloaded.message);
    }
    expect(reloaded.applied).toEqual(['agent.system_prompt_file']);

    faux.setResponses([() => fauxAssistantMessage('second answer')]);
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date(Date.now() + 120_000));
    const [second] = fixture.scheduler.processDue(new Date(Date.now() + 180_000));
    if (second === undefined) {
      throw new Error('Expected a second queued invocation');
    }
    await runDirect(fixture, runtime, second);
    const rows = transcript(fixture.store);
    expect(rows).not.toContain('first answer');
    expect(rows).toContain('second answer');
    expect(logEvents('context_rebuilt').length).toBeGreaterThan(0);
  } finally {
    fixture.store.close();
  }
});

test('a budget lowered during a run blocks the next model call', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    faux.setResponses([
      async () => {
        await fixture.patch((config) => {
          config.agent.daily_budget.max_tokens = 100_000;
        });
        const reloaded = await fixture.reloader.reloadFromFile();
        expect(reloaded.ok).toBe(true);
        return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'hello' }), { stopReason: 'toolUse' });
      },
      () => fauxAssistantMessage('done'),
    ]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    // Another chat already spent 200k tokens of the shared daily budget.
    const now = new Date().toISOString();
    fixture.store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?)",
      )
      .run(now.slice(0, 10), '987654321', 200_000, now);
    const outcome = await runDirect(fixture, runtime, invocationId);
    // The turn boundary notices the exhausted budget before the next model call
    // is even attempted: the run ends, and no second call reaches the provider.
    expect(outcome).toEqual({ state: 'completed', reason: 'budget' });
    expect(
      fixture.store.db
        .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM model_calls WHERE invocation_id = ?')
        .get(invocationId)?.count,
    ).toBe(1n);
  } finally {
    fixture.store.close();
  }
});

test('a reloaded model and thinking level show up in /status and the admin API', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
    },
  });
  try {
    fixture.runtimeWith(fauxAgent());
    await fixture.patch((config) => {
      config.agent.model = SECOND_MODEL;
      config.agent.thinking_level = 'high';
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);

    const status = await fixture.commands.run({ name: 'status' }, BigInt(CHAT_ID), ADMIN);
    expect(status).toContain(`当前模型: faux / ${SECOND_MODEL}`);
    expect(status).toContain('思考强度: high');

    const server = new AdminServer({
      store: fixture.store,
      configStore: fixture.configStore,
      modelSwitcher: fixture.modelSwitcher,
      configReloader: fixture.reloader,
      secrets: new SecretStore(),
      models: fixture.registry.models,
    });
    const created = await server.handle(
      new Request('http://127.0.0.1:8899/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
      }),
    );
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const view = (await (
      await server.handle(new Request('http://127.0.0.1:8899/api/providers', { headers: { cookie } }))
    ).json()) as { agent: { provider: string; model: string } };
    expect(view.agent).toMatchObject({ provider: 'faux', model: SECOND_MODEL });
  } finally {
    fixture.store.close();
  }
});

test('/model writes the file, keeps its comments and applies from the next run', async () => {
  const fixture = await setup();
  try {
    const faux = fauxAgent();
    const runtime = fixture.runtimeWith(faux);
    const jsonc = await fixture.readText();
    await fixture.writeText(`// Keep this comment.\n${jsonc}`);

    const options = fixture.modelSwitcher.list();
    const index = options.findIndex((option) => option.provider === 'faux' && option.model === SECOND_MODEL) + 1;
    expect(index).toBeGreaterThan(0);
    const reply = await fixture.commands.run({ name: 'model', argument: String(index) }, BigInt(CHAT_ID), ADMIN);
    expect(reply).toBe(`已切换: faux / ${SECOND_MODEL}，已写入 config.jsonc，将在下一次 agent session 生效。`);

    const text = await fixture.readText();
    expect(text).toContain('// Keep this comment.');
    expect(text).toContain(`"${SECOND_MODEL}"`);
    if (process.platform !== 'win32') {
      const { mode } = await stat(fixture.configPath);
      expect(mode & 0o777).toBe(0o600);
    }
    // A restart sees the same model: the file is the desired configuration.
    const reloaded = await loadConfig(fixture.configPath);
    expect(reloaded.config.agent.model).toBe(SECOND_MODEL);
    expect(fixture.configStore.current().config.agent.model).toBe(SECOND_MODEL);

    faux.setResponses([() => fauxAssistantMessage('answer')]);
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date());
    const [invocationId] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    await runDirect(fixture, runtime, invocationId);
    expect(
      fixture.store.db
        .prepare<[bigint], { model: string }>('SELECT model FROM model_calls WHERE invocation_id = ?')
        .all(invocationId)
        .map((row) => row.model),
    ).toEqual([SECOND_MODEL]);
  } finally {
    fixture.store.close();
  }
});

test('/model reports a write failure without touching the file or the active configuration', async () => {
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 301;
    });
    const broken = await fixture.readText();
    const reply = await fixture.commands.run({ name: 'model', argument: '1' }, BigInt(CHAT_ID), ADMIN);
    expect(reply.startsWith('切换失败: ')).toBe(true);
    expect(await fixture.readText()).toBe(broken);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('/model reports a config symlink instead of replacing it', async () => {
  const fixture = await setup();
  try {
    const linkPath = join(fixture.directory, 'link.jsonc');
    try {
      await symlink(fixture.configPath, linkPath);
    } catch {
      // Windows without Developer Mode refuses to create symlinks; the check
      // below covers the same code path on every other platform.
      return;
    }
    const linkLoader = new ConfigReloader({
      loaded: { ...fixture.loaded, configPath: linkPath },
      store: fixture.configStore,
      models: fixture.registry.models,
      modelSwitcher: fixture.modelSwitcher,
      secrets: new SecretStore(),
      validateAgentModel: () => undefined,
      onPublished: () => undefined,
    });
    const result = await linkLoader.setAgentModel('agent', 'agent-model');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the symlinked config to be rejected');
    }
    expect(result.code).toBe('config_symlink');
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  } finally {
    fixture.store.close();
  }
});

test('/model reports a read-only configuration directory', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const fixture = await setup();
  const before = fixture.configStore.current();
  const original = await fixture.readText();
  try {
    await chmod(fixture.directory, 0o500);
    const reply = await fixture.commands.run({ name: 'model', argument: '1' }, BigInt(CHAT_ID), ADMIN);
    expect(reply.startsWith('切换失败: ')).toBe(true);
    await chmod(fixture.directory, 0o700);
    expect(await fixture.readText()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    await chmod(fixture.directory, 0o700).catch(() => undefined);
    fixture.store.close();
  }
});

test('/model reports a written file that could not be applied', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.telegram.bucket_window_seconds = 30;
      config.agent.context.idle_grace_seconds = 30;
    },
  });
  try {
    await fixture.patch((config) => {
      config.telegram.bucket_window_seconds = 5;
      config.agent.context.idle_grace_seconds = 10;
    });
    const reply = await fixture.commands.run({ name: 'model', argument: '1' }, BigInt(CHAT_ID), ADMIN);
    expect(reply.startsWith('已写入 config.jsonc，但应用失败: ')).toBe(true);
    // The write happened, the application did not.
    const written = await loadConfig(fixture.configPath);
    expect(written.config.agent.provider).toBe('agent');
    expect(fixture.configStore.current().config.agent.provider).toBe('faux');
  } finally {
    fixture.store.close();
  }
});

test('invocations.config_hash records the hash that was active when the run started', async () => {
  const fixture = await setup();
  try {
    // A bucket whose deadline already passed when the scheduler starts.
    fixture.ingestion.ingest(textUpdate(1, 10, 'hello'), new Date(Date.now() - 60_000));
    const [invocationId] = fixture.scheduler.processDue(new Date());
    if (invocationId === undefined) {
      throw new Error('Expected a queued invocation');
    }
    const queued = fixture.store.db
      .prepare<[bigint], { config_hash: string }>('SELECT config_hash FROM invocations WHERE id = ?')
      .get(invocationId);
    expect(queued?.config_hash).toBe(fixture.configStore.current().hash);

    await fixture.patch((config) => {
      config.agent.thinking_level = 'high';
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      throw new Error(reloaded.message);
    }

    fixture.scheduler.start();
    await until(
      () =>
        fixture.store.db
          .prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?')
          .get(invocationId)?.state === 'completed',
      'the invocation to finish',
    );
    const running = fixture.store.db
      .prepare<[bigint], { config_hash: string }>('SELECT config_hash FROM invocations WHERE id = ?')
      .get(invocationId);
    expect(running?.config_hash).toBe(reloaded.status.activeHash);
    expect(running?.config_hash).not.toBe(queued?.config_hash);
  } finally {
    await fixture.scheduler.stop();
    fixture.store.close();
  }
}, 30_000);

test('redacts secrets from reload errors and logs', async () => {
  const secrets = new SecretStore();
  await secrets.resolve('secret-prompt-name');
  const fixture = await setup({ secrets });
  try {
    await fixture.patch((config) => {
      config.agent.system_prompt_file = 'secret-prompt-name.md';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the missing prompt to fail');
    }
    expect(result.code).toBe('config_invalid');
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('secret-prompt-name');
    expect(fixture.reloader.status().lastError?.message).not.toContain('secret-prompt-name');
    const failed = logEvents('config_reload_failed').at(-1);
    expect(String(failed?.error)).not.toContain('secret-prompt-name');
  } finally {
    fixture.store.close();
  }
});

test('a reloaded history_messages applies to new invocations only', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent.history_messages = 1;
    },
  });
  try {
    const start = Date.now();
    const historyCount = (invocationId: bigint): number =>
      Number(
        fixture.store.db
          .prepare<[bigint], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? AND section = 'history'",
          )
          .get(invocationId)?.count ?? 0n,
      );
    fixture.ingestion.ingest(textUpdate(1, 10, 'm1'), new Date(start));
    fixture.ingestion.ingest(textUpdate(2, 11, 'm2'), new Date(start + 1_000));
    fixture.ingestion.ingest(textUpdate(3, 12, 'm3'), new Date(start + 2_000));
    const [first] = fixture.scheduler.processDue(new Date(start + 20_000));
    if (first === undefined) {
      throw new Error('Expected the first invocation');
    }
    expect(historyCount(first)).toBe(0);
    settle(fixture, first);

    fixture.ingestion.ingest(textUpdate(4, 13, 'm4'), new Date(start + 30_000));
    const [second] = fixture.scheduler.processDue(new Date(start + 50_000));
    if (second === undefined) {
      throw new Error('Expected the second invocation');
    }
    expect(historyCount(second)).toBe(1);
    settle(fixture, second);

    await fixture.patch((config) => {
      config.agent.history_messages = 20;
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      throw new Error(reloaded.message);
    }
    expect(reloaded.applied).toEqual(['agent.history_messages']);
    // The invocation that was already queued keeps the history it snapshotted.
    expect(historyCount(second)).toBe(1);

    fixture.ingestion.ingest(textUpdate(5, 14, 'm5'), new Date(start + 60_000));
    const [third] = fixture.scheduler.processDue(new Date(start + 80_000));
    if (third === undefined) {
      throw new Error('Expected the third invocation');
    }
    expect(historyCount(third)).toBe(4);
  } finally {
    fixture.store.close();
  }
});

test('admin config endpoints apply the file and report status', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
    },
  });
  try {
    const server = new AdminServer({
      store: fixture.store,
      configStore: fixture.configStore,
      modelSwitcher: fixture.modelSwitcher,
      configReloader: fixture.reloader,
      secrets: new SecretStore(),
      models: fixture.registry.models,
    });
    const call = (path: string, init: RequestInit = {}): Request => new Request(`http://127.0.0.1:8899${path}`, init);
    const json = async (response: Response): Promise<any> => await response.json();

    expect((await server.handle(call('/api/config/status'))).status).toBe(401);
    const created = await server.handle(
      call('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
      }),
    );
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const before = await json(await server.handle(call('/api/config/status', { headers: { cookie } })));
    expect(before).toEqual({
      generation: 1,
      active_hash: fixture.configStore.current().hash,
      file_hash: fixture.loaded.hash,
      restart_required: [],
      last_error: null,
    });

    // Cross-origin writes are rejected on both endpoints.
    const crossOrigin = { 'content-type': 'application/json', cookie, origin: 'http://evil.test' };
    const rejectedApply = await server.handle(call('/api/config/apply', { method: 'POST', headers: crossOrigin }));
    expect(rejectedApply.status).toBe(403);
    expect(await json(rejectedApply)).toMatchObject({ error: 'bad_origin' });
    const rejectedModel = await server.handle(
      call('/api/model', {
        method: 'PUT',
        headers: crossOrigin,
        body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
      }),
    );
    expect(rejectedModel.status).toBe(403);

    await fixture.patch((config) => {
      config.agent.thinking_level = 'high';
    });
    const applied = await json(await server.handle(call('/api/config/apply', { method: 'POST', headers: { cookie } })));
    expect(applied).toMatchObject({
      status: 'applied',
      applied: ['agent.thinking_level'],
      restart_required: [],
      outside_serve: [],
      generation: 2,
    });
    expect(applied.active_hash).toBe(applied.file_hash);

    await fixture.writeText('{ broken');
    const failed = await server.handle(call('/api/config/apply', { method: 'POST', headers: { cookie } }));
    expect(failed.status).toBe(422);
    expect(await json(failed)).toMatchObject({ error: 'config_invalid' });
    const afterFailure = await json(await server.handle(call('/api/config/status', { headers: { cookie } })));
    expect(afterFailure.last_error).toMatchObject({ code: 'config_invalid' });
    expect(afterFailure.generation).toBe(2);

    // Put a valid file back; the failed write above never touched the model.
    await fixture.patch(() => undefined);

    const unknown = await server.handle(
      call('/api/model', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie,
          'if-match': await readConfigRevision(fixture.configPath),
        },
        body: JSON.stringify({ provider: 'ghost', model: 'agent-model' }),
      }),
    );
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ error: 'unknown_provider' });

    const switched = await json(
      await server.handle(
        call('/api/model', {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            cookie,
            'if-match': await readConfigRevision(fixture.configPath),
          },
          body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
        }),
      ),
    );
    expect(switched.current).toMatchObject({ provider: 'agent', model: 'agent-model' });
    expect(switched.apply).toEqual({ applied: ['agent.model', 'agent.provider'], restart_required: [] });

    // There is no default to restore: the request falls through to the 405.
    const removed = await server.handle(call('/api/model', { method: 'DELETE', headers: { cookie } }));
    expect(removed.status).toBe(405);
  } finally {
    fixture.store.close();
  }
});

test('rejects a configuration file that is not 0600 or whose directory is not 0700', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    await chmod(fixture.configPath, 0o644);
    const fileResult = await fixture.reloader.reloadFromFile();
    expect(fileResult.ok).toBe(false);
    if (fileResult.ok) {
      throw new Error('Expected the file mode to be rejected');
    }
    expect(fileResult.code).toBe('config_permissions');
    expect(fixture.configStore.current()).toBe(before);

    await chmod(fixture.configPath, 0o600);
    await chmod(fixture.directory, 0o755);
    const directoryResult = await fixture.reloader.reloadFromFile();
    expect(directoryResult.ok).toBe(false);
    if (directoryResult.ok) {
      throw new Error('Expected the directory mode to be rejected');
    }
    expect(directoryResult.code).toBe('config_permissions');
  } finally {
    await chmod(fixture.directory, 0o700).catch(() => undefined);
    await chmod(fixture.configPath, 0o600).catch(() => undefined);
    fixture.store.close();
  }
});

test('a write with a stale revision is refused and leaves the file unchanged', async () => {
  const fixture = await setup();
  try {
    const revision = await readConfigRevision(fixture.configPath);
    const before = await fixture.readText();

    const stale = await fixture.reloader.writeAndApply(
      [{ path: ['agent', 'thinking_level'], value: 'high' }],
      'f'.repeat(64),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      throw new Error('Expected the stale revision to be refused');
    }
    expect(stale.code).toBe('config_conflict');
    expect(await fixture.readText()).toBe(before);
    expect(fixture.configStore.current().config.agent.thinking_level).toBe('low');

    const applied = await fixture.reloader.writeAndApply(
      [{ path: ['agent', 'thinking_level'], value: 'high' }],
      revision,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    expect(applied.applied).toEqual(['agent.thinking_level']);
    expect(fixture.configStore.current().config.agent.thinking_level).toBe('high');
    // Leaf edits keep the comments the test configuration was written with.
    expect(await fixture.readText()).toBe(before.replace('"thinking_level": "low"', '"thinking_level": "high"'));
  } finally {
    fixture.store.close();
  }
});

test('setAgentModel refuses a stale revision before writing', async () => {
  const fixture = await setup({
    transform: (config) => {
      customProvider(config.providers, 'agent').models.push(model('agent-extra'));
    },
  });
  try {
    const before = await fixture.readText();
    const result = await fixture.reloader.setAgentModel('agent', 'agent-extra', 'f'.repeat(64));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the stale revision to be refused');
    }
    expect(result.code).toBe('config_conflict');
    expect(result.fileWritten).toBe(false);
    expect(await fixture.readText()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('a new model on an existing builtin provider is hot, rebuilds the registry, and re-resolves no secret', async () => {
  const secrets = new CountingSecrets();
  const fixture = await setup({ secrets });
  try {
    const resolvedAtStartup = secrets.resolutions;
    expect(resolvedAtStartup).toBeGreaterThan(0);
    // Pi's catalog knows this id, the file does not: it must stay unreachable.
    expect(fixture.registry.models.getModel('faux', 'deepseek-reasoner')).toBeUndefined();

    await fixture.patch((config) => {
      builtinProvider(config.providers, 'faux').models.push(model('deepseek-reasoner'));
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.faux.models[deepseek-reasoner]']);
    expect(fixture.registry.models.getModel('faux', 'deepseek-reasoner')).toBeDefined();
    expect(fixture.registry.models.getModel('faux', AGENT_MODEL)).toBeDefined();
    // Rebuilding a builtin provider reuses the auth the registry already holds;
    // a `command` SecretRef must not run again on reload.
    expect(secrets.resolutions).toBe(resolvedAtStartup);
  } finally {
    fixture.store.close();
  }
});

test('editing a builtin model in use waits for a restart', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      const agentModel = builtinProvider(config.providers, 'faux').models[0];
      if (agentModel === undefined) {
        throw new Error('Expected the faux agent model');
      }
      agentModel.context_window = 100_000;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.restartRequired).toEqual([`providers.faux.models[${AGENT_MODEL}]`]);
    expect(builtinProvider(fixture.configStore.current().config.providers, 'faux').models[0]?.context_window).toBe(
      200_000,
    );
    expect(fixture.registry.models.getModel('faux', AGENT_MODEL)?.contextWindow).toBe(200_000);
  } finally {
    fixture.store.close();
  }
});

test('a new model on an existing custom provider is hot and immediately selectable', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      customProvider(config.providers, 'agent').models.push(model('agent-extra'));
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.agent.models[agent-extra]']);
    expect(fixture.modelSwitcher.list().map((option) => `${option.provider}/${option.model}`)).toContain(
      'agent/agent-extra',
    );

    const switched = await fixture.reloader.setAgentModel('agent', 'agent-extra');
    expect(switched.ok).toBe(true);
    expect(fixture.configStore.current().config.agent).toMatchObject({ provider: 'agent', model: 'agent-extra' });

    await fixture.patch((config) => {
      customProvider(config.providers, 'agent').base_url = 'https://other.test/v1';
    });
    const connection = await fixture.reloader.reloadFromFile();
    expect(connection.ok).toBe(true);
    if (!connection.ok) {
      throw new Error(connection.message);
    }
    expect(connection.restartRequired).toEqual(['providers.agent.base_url']);
    expect(fixture.configStore.current().config.providers.agent).toMatchObject({
      base_url: 'https://example.test/v1',
    });
  } finally {
    fixture.store.close();
  }
});

test('editing the model in use waits for a restart', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent.provider = 'agent';
      config.agent.model = 'agent-model';
    },
  });
  try {
    await fixture.patch((config) => {
      customProvider(config.providers, 'agent').models[0]!.context_window = 100_000;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual(['providers.agent.models[agent-model]']);
    expect(customProvider(fixture.configStore.current().config.providers, 'agent').models[0]?.context_window).toBe(
      200_000,
    );
  } finally {
    fixture.store.close();
  }
});

test('editing a model the agent just left is hot', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent.provider = 'agent';
      config.agent.model = 'agent-model';
    },
  });
  try {
    await fixture.patch((config) => {
      config.agent.provider = 'vision';
      config.agent.model = 'vision-model';
      customProvider(config.providers, 'agent').models[0]!.context_window = 100_000;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.model', 'agent.provider', 'providers.agent.models[agent-model]']);
    expect(result.restartRequired).toEqual([]);
    expect(customProvider(fixture.configStore.current().config.providers, 'agent').models[0]?.context_window).toBe(
      100_000,
    );
  } finally {
    fixture.store.close();
  }
});

test('editing the vision model waits for a restart', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      customProvider(config.providers, 'vision').models[0]!.max_tokens = 4_096;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual(['providers.vision.models[vision-model]']);
    expect(customProvider(fixture.configStore.current().config.providers, 'vision').models[0]?.max_tokens).toBe(8_192);
  } finally {
    fixture.store.close();
  }
});

test('an agent pointing at a brand new provider waits for a restart', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.providers.extra = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: 'extra-secret',
        models: [model('extra-model')],
      };
      config.agent.provider = 'extra';
      config.agent.model = 'extra-model';
      config.agent.thinking_level = 'high';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.thinking_level']);
    expect(result.restartRequired).toEqual(['agent.model', 'agent.provider', 'providers.extra']);
    expect(fixture.configStore.current().config.agent).toMatchObject({ provider: 'faux', model: AGENT_MODEL });
  } finally {
    fixture.store.close();
  }
});

test('reports retention fields as outside serve, not as pending a restart', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.retention.online_days = 7;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual([]);
    expect(result.outsideServe).toEqual(['retention.online_days']);
    // Only fields `serve` never reads changed, so the file still becomes the
    // active configuration and both hashes agree.
    expect(result.status.generation).toBe(2);
    expect(result.status.activeHash).toBe(result.status.fileHash);
  } finally {
    fixture.store.close();
  }
});

test('a reload with no changes keeps the generation', async () => {
  const fixture = await setup();
  try {
    await fixture.patch(() => undefined);
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual([]);
    expect(result.outsideServe).toEqual([]);
    expect(result.status.generation).toBe(1);
    expect(result.status.activeHash).toBe(result.status.fileHash);
  } finally {
    fixture.store.close();
  }
});

test('two concurrent model switches both complete and agree on the last one', async () => {
  const fixture = await setup();
  try {
    const [first, second] = await Promise.all([
      fixture.reloader.setAgentModel('agent', 'agent-model'),
      fixture.reloader.setAgentModel('vision', 'vision-model'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fixture.configStore.current().config.agent).toMatchObject({ provider: 'vision', model: 'vision-model' });
    const written = JSON.parse(await fixture.readText()) as FileConfig;
    expect(written.agent).toMatchObject({ provider: 'vision', model: 'vision-model' });
  } finally {
    fixture.store.close();
  }
});

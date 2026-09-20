import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import {
  builtinProviderApi,
  findBuiltinProvider,
  isSupportedBuiltinPreset,
  SUPPORTED_PROVIDER_APIS,
} from './builtin-providers.ts';
import { stripHtmlComments } from './prompt-markdown.ts';
import { validatePromptTemplate } from './prompt-template.ts';

const Strict = { additionalProperties: false } as const;
const PositiveInteger = Type.Integer({ minimum: 1 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
/** Provider aliases appear in Admin API paths and in `restart_required` strings. */
export const PROVIDER_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Which compat overrides each API adapter honours; anything else is rejected. */
const COMPAT_FIELDS_BY_API: Readonly<Record<ProviderApi, readonly string[]>> = {
  'openai-completions': [
    'supports_developer_role',
    'thinking_format',
    'max_tokens_field',
    'requires_reasoning_content',
    'cache_control_format',
  ],
  'openai-responses': ['supports_developer_role'],
  'anthropic-messages': [],
  'google-generative-ai': [],
};
export const SecretRefSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object({ env: Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }) }, Strict),
  Type.Object({ command: Type.Array(Type.String(), { minItems: 1 }) }, Strict),
]);
const CostSchema = Type.Object(
  {
    input: NonNegativeNumber,
    output: NonNegativeNumber,
    cache_read: NonNegativeNumber,
    cache_write: NonNegativeNumber,
  },
  Strict,
);
/**
 * Selected Pi compat overrides. Every field is optional, and omitting one leaves
 * Pi's own detection in charge — the panel therefore shows "automatic" rather
 * than freezing a detected value into the file.
 *
 * `thinking_format` only lists the values that need no extra kwargs;
 * `cache_control_format` only has the one value Pi can force, because Pi merges
 * compat with `??` and has no way to switch the detected default off.
 */
export const ModelCompatSchema = Type.Object(
  {
    supports_developer_role: Type.Optional(Type.Boolean()),
    thinking_format: Type.Optional(
      Type.Union([
        Type.Literal('openai'),
        Type.Literal('openrouter'),
        Type.Literal('deepseek'),
        Type.Literal('together'),
        Type.Literal('zai'),
        Type.Literal('qwen'),
        Type.Literal('string-thinking'),
      ]),
    ),
    max_tokens_field: Type.Optional(Type.Union([Type.Literal('max_completion_tokens'), Type.Literal('max_tokens')])),
    requires_reasoning_content: Type.Optional(Type.Boolean()),
    cache_control_format: Type.Optional(Type.Literal('anthropic')),
  },
  Strict,
);
export const ModelConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Boolean(),
    compat: Type.Optional(ModelCompatSchema),
    input: Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]), {
      minItems: 1,
      uniqueItems: true,
    }),
    context_window: PositiveInteger,
    max_tokens: PositiveInteger,
    cost: CostSchema,
  },
  Strict,
);
const BuiltinProviderSchema = Type.Object(
  {
    kind: Type.Literal('builtin'),
    provider: Type.String({ minLength: 1 }),
    api_key: SecretRefSchema,
    models: Type.Array(ModelConfigSchema, { minItems: 1 }),
  },
  Strict,
);
const CustomProviderApiSchema = Type.Union([
  Type.Literal('openai-responses'),
  Type.Literal('openai-completions'),
  Type.Literal('anthropic-messages'),
  Type.Literal('google-generative-ai'),
]);
const CustomProviderSchema = Type.Object(
  {
    kind: Type.Literal('custom'),
    base_url: Type.String({ minLength: 1 }),
    api: CustomProviderApiSchema,
    api_key: SecretRefSchema,
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    models: Type.Array(ModelConfigSchema, { minItems: 1 }),
  },
  Strict,
);
// Local wall-clock times, resolved against the chat's timezone. `24:00` is the
// end of the day, so `00:00-24:00` covers a full day.
const ParticipationWindowSchema = Type.Object(
  {
    start: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
    end: Type.String({ pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' }),
    days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, uniqueItems: true })),
  },
  Strict,
);
// `active_windows` and `trigger_keywords` are admin-authored lists whose length
// carries no behavioral meaning, so they stay unbounded like every other list in
// this file. An empty list is meaningful: no scheduled periods means the chat is
// reachable only through a trigger, and no keywords means only mentions and
// replies trigger it.
const ParticipationSchema = Type.Object(
  {
    active_windows: Type.Optional(Type.Array(ParticipationWindowSchema)),
    trigger_keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
    attention_window_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
  },
  Strict,
);
const ChatSchema = Type.Object(
  {
    id: Type.Integer(),
    topic_ids: Type.Optional(Type.Array(PositiveInteger, { minItems: 1, uniqueItems: true })),
    ignored_user_ids: Type.Optional(Type.Array(PositiveInteger, { uniqueItems: true })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    instructions_file: Type.Optional(Type.String({ minLength: 1 })),
    participation: Type.Optional(ParticipationSchema),
  },
  Strict,
);
const StickerSetSchema = Type.Object(
  {
    alias: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    name: Type.String({ minLength: 1 }),
  },
  Strict,
);
const ToolPolicyFields = {
  read_only: Type.Boolean(),
  timeout_seconds: Type.Number({ exclusiveMinimum: 0 }),
};
const ToolPolicySchema = Type.Object({ name: Type.String({ minLength: 1 }), ...ToolPolicyFields }, Strict);
const DefaultToolPolicySchema = Type.Object(ToolPolicyFields, Strict);
const StdioMcpSchema = Type.Object(
  {
    alias: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    transport: Type.Literal('stdio'),
    command: Type.Array(Type.String(), { minItems: 1 }),
    required: Type.Boolean(),
    tools: Type.Union([Type.Literal('*'), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })]),
    payload_max_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    result_max_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
    env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    tool_policies: Type.Optional(Type.Array(ToolPolicySchema)),
    default_tool_policy: Type.Optional(DefaultToolPolicySchema),
  },
  Strict,
);
const HttpMcpSchema = Type.Object(
  {
    alias: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    transport: Type.Literal('streamable_http'),
    url: Type.String({ minLength: 1 }),
    follow_redirects: Type.Literal(false),
    required: Type.Boolean(),
    tools: Type.Union([Type.Literal('*'), Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })]),
    payload_max_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    result_max_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    tool_policies: Type.Optional(Type.Array(ToolPolicySchema)),
    default_tool_policy: Type.Optional(DefaultToolPolicySchema),
  },
  Strict,
);
const AdminSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    session_ttl_hours: Type.Integer({ minimum: 1, maximum: 720 }),
    static_dir: Type.Optional(Type.String({ minLength: 1 })),
  },
  Strict,
);

export const ConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    data_dir: Type.String({ minLength: 1 }),
    timezone: Type.String({ minLength: 1 }),
    telegram: Type.Object(
      {
        token: SecretRefSchema,
        process_bot_messages: Type.Boolean(),
        sticker_trigger_enabled: Type.Optional(Type.Boolean()),
        bucket_window_seconds: Type.Integer({ minimum: 0, maximum: 300 }),
        participation: Type.Optional(ParticipationSchema),
        chats: Type.Array(ChatSchema, { minItems: 1 }),
        admins: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true })),
        sticker_sets: Type.Optional(Type.Array(StickerSetSchema)),
      },
      Strict,
    ),
    providers: Type.Record(Type.String({ minLength: 1 }), Type.Union([BuiltinProviderSchema, CustomProviderSchema])),
    agent: Type.Object(
      {
        provider: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
        daily_budget: Type.Object({ max_tokens: PositiveInteger }, Strict),
        thinking_level: Type.Union([
          Type.Literal('off'),
          Type.Literal('minimal'),
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high'),
          Type.Literal('xhigh'),
        ]),
        system_prompt_file: Type.String({ minLength: 1 }),
        send_max_text_length: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
        send_disallow_blank_lines: Type.Optional(Type.Boolean()),
        max_concurrency: PositiveInteger,
        context_stop_ratio: Type.Number({ exclusiveMinimum: 0, maximum: 0.8 }),
        history_messages: Type.Integer({ minimum: 1 }),
        memory_ttl_warning_days: Type.Optional(PositiveInteger),
        send_nudge_enabled: Type.Optional(Type.Boolean()),
        context: Type.Object(
          {
            retained_sends_target: Type.Integer({ minimum: 1 }),
            retained_sends_max: Type.Integer({ minimum: 2 }),
            hard_token_ratio: Type.Number({ exclusiveMinimum: 0, maximum: 0.8 }),
            ref_ttl_hours: Type.Integer({ minimum: 1, maximum: 720 }),
            idle_grace_seconds: Type.Integer({ minimum: 0, maximum: 3_600 }),
            max_wall_clock_seconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
            agent_cache_size: Type.Integer({ minimum: 1, maximum: 1_024 }),
          },
          Strict,
        ),
        rate_limits: Type.Object(
          {
            sends_per_window: Type.Integer({ minimum: 1, maximum: 100 }),
            window_seconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
            turns_per_injection: Type.Integer({ minimum: 1, maximum: 100 }),
          },
          Strict,
        ),
      },
      Strict,
    ),
    vision: Type.Object(
      {
        provider: Type.String({ minLength: 1 }),
        model: Type.String({ minLength: 1 }),
        max_output_tokens: PositiveInteger,
        max_concurrency: PositiveInteger,
        background_sticker_concurrency: Type.Literal(1),
        prompt_version: PositiveInteger,
        daily_budget: Type.Object({ max_tokens: PositiveInteger, max_images: PositiveInteger }, Strict),
      },
      Strict,
    ),
    retention: Type.Object({ online_days: PositiveInteger, backup_copies: PositiveInteger }, Strict),
    paths: Type.Object(
      {
        database: Type.String({ minLength: 1 }),
        media_cache: Type.String({ minLength: 1 }),
        backups: Type.String({ minLength: 1 }),
      },
      Strict,
    ),
    mcp: Type.Optional(Type.Object({ servers: Type.Array(Type.Union([StdioMcpSchema, HttpMcpSchema])) }, Strict)),
    admin: Type.Optional(AdminSchema),
  },
  Strict,
);

export type SecretRef = Static<typeof SecretRefSchema>;
export type ProviderApi = Static<typeof CustomProviderApiSchema>;
export type ModelCompatConfig = Static<typeof ModelCompatSchema>;
export type ModelFileConfig = Static<typeof ModelConfigSchema>;
export type FileConfig = Static<typeof ConfigSchema>;
export type FileChat = FileConfig['telegram']['chats'][number];
export type ParticipationConfig = Static<typeof ParticipationSchema>;
export type ParticipationWindowConfig = Static<typeof ParticipationWindowSchema>;
export type RawConfig = Omit<FileConfig, 'agent' | 'telegram'> & {
  agent: Omit<FileConfig['agent'], 'system_prompt_file'> & { system_prompt: string };
  telegram: Omit<FileConfig['telegram'], 'chats'> & {
    chats: Array<Omit<FileChat, 'instructions_file'> & { instructions: string }>;
  };
};
export type ProviderConfig = RawConfig['providers'][string];
export type McpServerConfig = NonNullable<RawConfig['mcp']>['servers'][number];

export interface LoadedConfig {
  readonly config: RawConfig;
  readonly fileConfig: FileConfig;
  readonly configPath: string;
  readonly hash: string;
}

const validator = Compile(ConfigSchema);

function describeOffset(source: string, offset: number): string {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return `line ${line + 1}, column ${offset - lineStart + 1}`;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const configPath = resolve(path);
  const text = await readFile(configPath, 'utf8');
  // jsonc-parser records a UTF-8 BOM as an invalid symbol, so strip it before
  // parsing. The hash below still covers the raw text.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(source, parseErrors, { allowTrailingComma: true }) as unknown;
  if (parsed === undefined || parseErrors.length > 0) {
    const details = parseErrors
      .slice(0, 10)
      .map((error) => `${printParseErrorCode(error.error)} at ${describeOffset(source, error.offset)}`)
      .join('; ');
    throw new Error(`Invalid JSONC: ${details || 'empty document'}`);
  }
  if (!validator.Check(parsed)) {
    const details = validator
      .Errors(parsed)
      .slice(0, 10)
      .map((error) => `${error.instancePath || '/'}: ${formatValidationError(error)}`)
      .join('; ');
    throw new Error(`Invalid config: ${details}`);
  }
  validateSemantics(parsed);
  const { config, promptFiles } = await resolvePrompts(parsed, dirname(configPath));
  const hash = createHash('sha256');
  hash.update(text);
  for (const file of promptFiles) {
    hash.update(`\u0000${file.content}`);
  }
  return { config, fileConfig: parsed, configPath, hash: hash.digest('hex') };
}

/**
 * TypeBox reports an unexpected key as a bare "must not have additional properties", which forces
 * callers to diff their file against the schema by hand. The offending names live in `params`.
 */
function formatValidationError(error: TLocalizedValidationError): string {
  if (error.keyword === 'additionalProperties') {
    return `${error.message}: ${error.params.additionalProperties.join(', ')}`;
  }
  return error.message;
}

interface PromptFile {
  readonly content: string;
}

async function resolvePrompts(
  fileConfig: FileConfig,
  directory: string,
): Promise<{ config: RawConfig; promptFiles: PromptFile[] }> {
  const promptFiles: PromptFile[] = [];
  const systemPrompt = await readPromptFile(
    resolve(directory, fileConfig.agent.system_prompt_file),
    'agent.system_prompt_file',
    promptFiles,
  );
  if (systemPrompt.length === 0) {
    throw new Error(
      `agent.system_prompt_file is empty or contains only HTML comments: ${fileConfig.agent.system_prompt_file}`,
    );
  }
  validatePromptTemplate(systemPrompt, 'agent.system_prompt_file');
  const instructionsByChatId = new Map<number, string>();
  for (const chat of fileConfig.telegram.chats) {
    const instructions =
      chat.instructions_file === undefined
        ? ''
        : await readPromptFile(
            resolve(directory, chat.instructions_file),
            `chat ${chat.id} instructions_file`,
            promptFiles,
          );
    validatePromptTemplate(instructions, `chat ${chat.id} instructions_file`);
    instructionsByChatId.set(chat.id, instructions);
  }
  return { promptFiles, config: assembleRawConfig(fileConfig, systemPrompt, instructionsByChatId) };
}

/**
 * Combines a validated `FileConfig` with already-read prompt texts.
 *
 * The result shares every nested object it is not asked to replace with
 * `fileConfig`; callers that keep a `FileConfig` and a `RawConfig` of the same
 * configuration (as `LoadedConfig` does) therefore hold aliases, not copies, and
 * must never mutate either side. The reload path builds both layers from a
 * `structuredClone` for exactly that reason.
 */
export function assembleRawConfig(
  fileConfig: FileConfig,
  systemPrompt: string,
  instructionsByChatId: ReadonlyMap<number, string>,
): RawConfig {
  const { system_prompt_file, ...agent } = fileConfig.agent;
  const chats = fileConfig.telegram.chats.map((chat) => {
    const { instructions_file, ...rest } = chat;
    return { ...rest, instructions: instructionsByChatId.get(chat.id) ?? '' };
  });
  return {
    ...fileConfig,
    agent: { ...agent, system_prompt: systemPrompt },
    telegram: { ...fileConfig.telegram, chats },
  };
}

async function readPromptFile(path: string, label: string, sink: PromptFile[]): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${label} file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A UTF-8 BOM must not reach the prompt text; the hash still covers the raw
  // bytes.
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  if (raw.includes('\u0000')) {
    throw new Error(`${label} file ${path} contains a NUL character`);
  }
  // The hash keeps covering the raw file, so a comment-only edit still changes
  // config_hash; the prompt itself sees only the text outside HTML comments.
  sink.push({ content: raw });
  return stripHtmlComments(raw);
}

export async function assertConfigPermissions(configPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const file = await stat(configPath);
  const parent = await stat(resolve(configPath, '..'));
  if ((file.mode & 0o777) !== 0o600) {
    throw new Error(`Config must have mode 0600: ${configPath}`);
  }
  if ((parent.mode & 0o777) !== 0o700) {
    throw new Error(`Config parent must have mode 0700: ${resolve(configPath, '..')}`);
  }
}

export function validateSemantics(config: FileConfig): void {
  validateTimezone(config.timezone, 'timezone');
  validateParticipation(config.telegram.participation, 'telegram.participation');
  validateContextConfig(config);
  const chatIds = new Set<number>();
  for (const chat of config.telegram.chats) {
    if (!Number.isSafeInteger(chat.id) || chat.id === 0) {
      throw new Error(`Invalid Telegram chat ID: ${chat.id}`);
    }
    if (chatIds.has(chat.id)) {
      throw new Error(`Duplicate Telegram chat ID: ${chat.id}`);
    }
    chatIds.add(chat.id);
    if (chat.participation !== undefined) {
      if (chat.id > 0) {
        throw new Error(`Chat ${chat.id} is a private chat and cannot configure participation`);
      }
      validateParticipation(chat.participation, `chat ${chat.id} participation`);
    }
    if (chat.timezone !== undefined) {
      validateTimezone(chat.timezone, `chat ${chat.id} timezone`);
    }
    for (const ignoredUserId of chat.ignored_user_ids ?? []) {
      if (!Number.isSafeInteger(ignoredUserId) || ignoredUserId === 0) {
        throw new Error(`Invalid ignored Telegram user ID in chat ${chat.id}: ${ignoredUserId}`);
      }
    }
  }
  for (const adminId of config.telegram.admins ?? []) {
    if (!Number.isSafeInteger(adminId) || adminId === 0) {
      throw new Error(`Invalid Telegram admin user ID: ${adminId}`);
    }
  }
  assertUnique(config.telegram.sticker_sets ?? [], (item) => item.alias, 'sticker set alias');
  assertUnique(config.telegram.sticker_sets ?? [], (item) => item.name, 'sticker set name');
  const providerAliases = new Set(Object.keys(config.providers));
  validateModelReference(config, config.agent.provider, config.agent.model, 'agent', ['text']);
  validateModelReference(config, config.vision.provider, config.vision.model, 'vision', ['image']);
  if (!providerAliases.has(config.agent.provider) || !providerAliases.has(config.vision.provider)) {
    throw new Error('Agent and vision providers must reference configured aliases');
  }
  for (const [alias, provider] of Object.entries(config.providers)) {
    if (!PROVIDER_ALIAS_PATTERN.test(alias)) {
      throw new Error(
        `Provider alias ${JSON.stringify(alias)} must match ${PROVIDER_ALIAS_PATTERN.source}: the alias is a URL path segment and part of restart path strings`,
      );
    }
    const api = resolveProviderApi(alias, provider);
    assertUnique(provider.models, (model) => model.id, `provider ${alias} model ID`);
    for (const model of provider.models) {
      assertModelConfig(api, model, `Provider ${alias} model ${model.id}`);
    }
    if (provider.kind === 'custom') {
      validateEndpoint(provider.base_url, `provider ${alias} base_url`);
    }
  }
  const servers = config.mcp?.servers ?? [];
  assertUnique(servers, (server) => server.alias, 'MCP server alias');
  for (const server of servers) {
    if (server.transport === 'streamable_http') {
      validateEndpoint(server.url, `MCP server ${server.alias} URL`, { allowQuery: true });
    }
    if (server.tools === '*' && server.default_tool_policy === undefined) {
      throw new Error(`MCP server ${server.alias} wildcard tools require default_tool_policy`);
    }
    const policies = server.tool_policies ?? [];
    assertUnique(policies, (policy) => policy.name, `MCP server ${server.alias} tool policy`);
    if (server.tools !== '*') {
      const allowed = new Set(server.tools);
      for (const policy of policies) {
        if (!allowed.has(policy.name)) {
          throw new Error(`MCP server ${server.alias} policy references unlisted tool ${policy.name}`);
        }
      }
      for (const tool of server.tools) {
        if (!policies.some((policy) => policy.name === tool)) {
          throw new Error(`MCP server ${server.alias} tool ${tool} has no policy`);
        }
      }
    }
  }
}

function validateModelReference(
  config: FileConfig,
  providerAlias: string,
  modelId: string,
  role: string,
  requiredInputs: readonly ('text' | 'image')[],
): void {
  const provider = config.providers[providerAlias];
  if (provider === undefined) {
    throw new Error(`${role}.provider references unknown alias ${providerAlias}`);
  }
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    throw new Error(`${role}.model ${modelId} is absent from provider ${providerAlias}`);
  }
  for (const requiredInput of requiredInputs) {
    if (!model.input.includes(requiredInput)) {
      throw new Error(`${role}.model ${modelId} lacks ${requiredInput} input capability`);
    }
  }
}

/**
 * The API a provider's models speak. A custom provider states it; a builtin one
 * inherits it from Pi's catalog, which is also what decides whether the provider
 * may be configured at all.
 */
function resolveProviderApi(alias: string, provider: ProviderConfig): ProviderApi {
  if (provider.kind === 'custom') {
    return provider.api;
  }
  const source = findBuiltinProvider(provider.provider);
  if (source === undefined) {
    throw new Error(`Provider ${alias} references unknown built-in provider ${provider.provider}`);
  }
  const api = builtinProviderApi(source);
  if (api === null || !SUPPORTED_PROVIDER_APIS.includes(api)) {
    throw new Error(
      `Provider ${alias} built-in ${provider.provider} does not expose a single supported API (${SUPPORTED_PROVIDER_APIS.join(', ')})`,
    );
  }
  if (!isSupportedBuiltinPreset(source)) {
    throw new Error(`Provider ${alias} built-in ${provider.provider} cannot be driven from a configured API key`);
  }
  return api as ProviderApi;
}

/**
 * The model invariants a provider's API imposes, shared by the configuration
 * validator and the Admin Panel so a rejected edit is reported as a user error
 * before the file is rewritten.
 */
export function assertModelConfig(api: ProviderApi, model: ModelFileConfig, label: string): void {
  if (model.max_tokens > model.context_window) {
    throw new Error(`${label} max_tokens exceeds context_window`);
  }
  for (const field of Object.keys(model.compat ?? {})) {
    if (!COMPAT_FIELDS_BY_API[api].includes(field)) {
      throw new Error(`${label} cannot set ${field} for api ${api}`);
    }
  }
}

function validateEndpoint(value: string, label: string, options: { allowQuery?: boolean } = {}): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const invalidQuery = !options.allowQuery && url.search.length > 0;
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    invalidQuery ||
    url.hash
  ) {
    const forbiddenParts = options.allowQuery ? 'credentials or fragment' : 'credentials, query, or fragment';
    throw new Error(`${label} must be an HTTP(S) URL without ${forbiddenParts}`);
  }
}

// A zero-length window can never match, so it is a configuration mistake
// rather than a quiet way to disable one entry.
function validateParticipation(participation: ParticipationConfig | undefined, label: string): void {
  for (const window of participation?.active_windows ?? []) {
    if (window.start === window.end) {
      throw new Error(`${label} has an empty active window: ${window.start}-${window.end}`);
    }
  }
}

/**
 * Conversation Context invariants. `idle_grace_seconds = 0` is the supported way
 * to turn long-lived invocations off, but a grace shorter than one bucket
 * window would look enabled while every run ends before the next bucket is due:
 * a silent degradation, rejected here instead of at 3 a.m. in production.
 */
function validateContextConfig(config: FileConfig): void {
  const context = config.agent.context;
  if (context.retained_sends_target >= context.retained_sends_max) {
    throw new Error('agent.context.retained_sends_target must be smaller than retained_sends_max');
  }
  if (context.hard_token_ratio > config.agent.context_stop_ratio) {
    throw new Error('agent.context.hard_token_ratio must not exceed agent.context_stop_ratio');
  }
  if (context.idle_grace_seconds > 0 && context.idle_grace_seconds < config.telegram.bucket_window_seconds) {
    throw new Error(
      'agent.context.idle_grace_seconds must be 0 (long-lived invocations off) or at least telegram.bucket_window_seconds',
    );
  }
  if (context.max_wall_clock_seconds <= context.idle_grace_seconds) {
    throw new Error('agent.context.max_wall_clock_seconds must exceed idle_grace_seconds');
  }
}

function validateTimezone(value: string, label: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertUnique<T>(items: readonly T[], select: (item: T) => string, label: string): void {
  const values = new Set<string>();
  for (const item of items) {
    const value = select(item);
    if (values.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    values.add(value);
  }
}

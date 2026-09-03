import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { validatePromptTemplate } from './prompt-template.ts';

const Strict = { additionalProperties: false } as const;
const PositiveInteger = Type.Integer({ minimum: 1 });
const NonNegativeNumber = Type.Number({ minimum: 0 });
const ADMIN_HOSTS = ['127.0.0.1', '::1', 'localhost'];
const SecretRefSchema = Type.Union([
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
const ModelCompatSchema = Type.Object(
  {
    supports_developer_role: Type.Boolean(),
  },
  Strict,
);
const ModelSchema = Type.Object(
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
  },
  Strict,
);
const CustomProviderSchema = Type.Object(
  {
    kind: Type.Literal('custom'),
    base_url: Type.String({ minLength: 1 }),
    api: Type.Union([
      Type.Literal('openai-responses'),
      Type.Literal('openai-completions'),
      Type.Literal('anthropic-messages'),
    ]),
    api_key: SecretRefSchema,
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretRefSchema)),
    models: Type.Array(ModelSchema, { minItems: 1 }),
  },
  Strict,
);
const ChatBudgetSchema = Type.Object({ max_invocations_per_day: PositiveInteger }, Strict);
const ChatSchema = Type.Object(
  {
    id: Type.Integer(),
    topic_ids: Type.Optional(Type.Array(PositiveInteger, { minItems: 1, uniqueItems: true })),
    ignored_user_ids: Type.Optional(Type.Array(PositiveInteger, { uniqueItems: true })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    instructions_file: Type.Optional(Type.String({ minLength: 1 })),
    budget: ChatBudgetSchema,
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
  per_chat_daily_calls: PositiveInteger,
  global_daily_calls: PositiveInteger,
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
        max_turns: Type.Integer({ minimum: 1, maximum: 8 }),
        max_tool_calls: Type.Integer({ minimum: 1, maximum: 12 }),
        max_sends: Type.Integer({ minimum: 1, maximum: 6 }),
        send_max_text_length: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
        send_disallow_blank_lines: Type.Optional(Type.Boolean()),
        timeout_seconds: Type.Number({ exclusiveMinimum: 0, maximum: 90 }),
        max_concurrency: PositiveInteger,
        context_stop_ratio: Type.Number({ exclusiveMinimum: 0, maximum: 0.8 }),
        history_messages: Type.Integer({ minimum: 1 }),
        memory_ttl_warning_days: Type.Optional(PositiveInteger),
        send_nudge_enabled: Type.Optional(Type.Boolean()),
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
export type FileConfig = Static<typeof ConfigSchema>;
export type FileChat = FileConfig['telegram']['chats'][number];
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

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const configPath = resolve(path);
  const text = await readFile(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSONC: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validator.Check(parsed)) {
    const details = validator
      .Errors(parsed)
      .slice(0, 10)
      .map((error) => `${error.instancePath || '/'}: ${error.message}`)
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
    throw new Error(`agent.system_prompt_file is empty: ${fileConfig.agent.system_prompt_file}`);
  }
  validatePromptTemplate(systemPrompt, 'agent.system_prompt_file');
  const chats: Array<Omit<FileChat, 'instructions_file'> & { instructions: string }> = [];
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
    const { instructions_file, ...rest } = chat;
    chats.push({ ...rest, instructions });
  }
  const { system_prompt_file, ...agent } = fileConfig.agent;
  return {
    promptFiles,
    config: {
      ...fileConfig,
      agent: { ...agent, system_prompt: systemPrompt },
      telegram: { ...fileConfig.telegram, chats },
    },
  };
}

async function readPromptFile(path: string, label: string, sink: PromptFile[]): Promise<string> {
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch (error) {
    throw new Error(`Cannot read ${label} file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  sink.push({ content });
  return content;
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

function validateSemantics(config: FileConfig): void {
  validateTimezone(config.timezone, 'timezone');
  const chatIds = new Set<number>();
  for (const chat of config.telegram.chats) {
    if (!Number.isSafeInteger(chat.id) || chat.id === 0) {
      throw new Error(`Invalid Telegram chat ID: ${chat.id}`);
    }
    if (chatIds.has(chat.id)) {
      throw new Error(`Duplicate Telegram chat ID: ${chat.id}`);
    }
    chatIds.add(chat.id);
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
    if (provider.kind === 'custom') {
      validateEndpoint(provider.base_url, `provider ${alias} base_url`);
      assertUnique(provider.models, (model) => model.id, `provider ${alias} model ID`);
      for (const model of provider.models) {
        if (model.max_tokens > model.context_window) {
          throw new Error(`Provider ${alias} model ${model.id} max_tokens exceeds context_window`);
        }
        if (model.compat !== undefined && provider.api === 'anthropic-messages') {
          throw new Error(`Provider ${alias} model ${model.id} supports_developer_role requires an OpenAI API adapter`);
        }
      }
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
  if (config.admin !== undefined && !ADMIN_HOSTS.includes(config.admin.host)) {
    throw new Error(
      `admin.host must be a loopback address (${ADMIN_HOSTS.join(', ')}); place a reverse proxy in front for remote access`,
    );
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
  if (provider.kind === 'builtin') {
    return;
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

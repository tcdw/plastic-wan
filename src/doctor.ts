import { Database } from "bun:sqlite";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Context, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { Bot } from "grammy";
import sharp from "sharp";
import Type from "typebox";
import { AgentRuntime } from "./agent-runtime.ts";
import { assertConfigPermissions, loadConfig } from "./config.ts";
import { renderPromptTemplate, type PromptTemplateValues } from "./prompt-template.ts";
import type { McpServerConfig, ProviderConfig, RawConfig, SecretRef } from "./config.ts";
import { KeyedSemaphore } from "./concurrency.ts";
import type { InvocationContext } from "./context-builder.ts";
import { SqliteStore } from "./database.ts";
import { McpManager } from "./mcp.ts";
import { createLottieCommand, MediaService, TelegramMediaClient } from "./media.ts";
import { AgentModelSwitcher } from "./model-switch.ts";
import { createModelRegistry, type ModelRegistry } from "./providers.ts";
import { SecretStore } from "./secrets.ts";
import { StickerService } from "./stickers.ts";

export async function runDoctor(configPath: string, outputAgentPrompt = false): Promise<void> {
  const loaded = await loadConfig(configPath);
  await assertConfigPermissions(loaded.configPath);
  const secrets = new SecretStore();
  try {
    await runDoctorChecks(loaded.config, loaded.hash, secrets, outputAgentPrompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(secrets.redact(message));
  }
}
export function renderDoctorAgentPrompt(config: RawConfig): string {
  const values: PromptTemplateValues = {
    agent: { provider: config.agent.provider, model: config.agent.model },
    vision: { provider: config.vision.provider, model: config.vision.model },
    timezone: config.timezone,
  };
  return renderPromptTemplate(config.agent.system_prompt, values);
}
async function runDoctorChecks(
  config: RawConfig,
  configHash: string,
  secrets: SecretStore,
  outputAgentPrompt: boolean,
): Promise<void> {
  await resolveAllSecrets(config.telegram.token, config.providers, config.mcp?.servers ?? [], secrets);
  await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(config.paths.database), { recursive: true, mode: 0o700 });
  await mkdir(config.paths.media_cache, { recursive: true, mode: 0o700 });
  await mkdir(config.paths.backups, { recursive: true, mode: 0o700 });
  const dataDirectory = await stat(config.data_dir);
  if (!dataDirectory.isDirectory()) throw new Error(`Data path is not a directory: ${config.data_dir}`);
  if (process.platform !== "win32" && (dataDirectory.mode & 0o077) !== 0) throw new Error("Data directory must not grant group or other permissions");
  const filesystem = await statfs(config.data_dir);
  if (filesystem.bavail * filesystem.bsize < 100 * 1024 * 1024) throw new Error("Data filesystem has less than 100 MiB available");
  verifyFtsTrigram();
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await runDependency(["ffmpeg", "-version"]);
  await runDependency(["ffprobe", "-version"]);
  await verifyLottie(config.data_dir);

  const registry = await createModelRegistry(config, secrets);
  const store = await SqliteStore.open(config);
  let mcp: McpManager | undefined;
  try {
    for (const [alias, provider] of Object.entries(config.providers)) {
      if (provider.kind !== "custom") continue;
      const model = registry.models.getModels(alias).find((candidate) => candidate.input.includes("text"));
      if (model === undefined) throw new Error(`Custom provider ${alias} has no text-capable model for doctor probe`);
      await completeDoctorCall(store, registry, model, {
        systemPrompt: "This is a connectivity probe. Return a short plain-text acknowledgement.",
        messages: [{ role: "user", content: [{ type: "text", text: "Reply OK." }], timestamp: Date.now() }],
      }, doctorReasoning(model, "low"));
    }
    const probeSchema = Type.Object({}, { additionalProperties: false });
    const agentResponse = await completeDoctorCall(
      store,
      registry,
      registry.agentModel,
      {
        systemPrompt: "Call doctor_probe exactly once with an empty object. Do not answer with text.",
        messages: [{ role: "user", content: [{ type: "text", text: "Run the required probe." }], timestamp: Date.now() }],
        tools: [{
          name: "doctor_probe",
          description: "A no-side-effect doctor probe",
          parameters: probeSchema,
        }],
      },
      doctorReasoning(registry.agentModel, config.agent.thinking_level),
    );
    if (!agentResponse.content.some((entry) => entry.type === "toolCall" && entry.name === "doctor_probe")) {
      throw new Error("Agent model did not produce the required strict Tool Call");
    }
    const pixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    await completeDoctorCall(store, registry, registry.visionModel, {
      systemPrompt: "Describe the image in one word.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: pixel.toString("base64"), mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      }],
    }, doctorReasoning(registry.visionModel, "low"));

    const telegramToken = await secrets.resolve(config.telegram.token);
    const bot = new Bot(telegramToken);
    const me = await bot.api.getMe();
    const requiredConfig: RawConfig = {
      ...config,
      mcp: { servers: (config.mcp?.servers ?? []).filter((server) => server.required) },
    };
    const modelGate = new KeyedSemaphore();
    const media = new MediaService({
      store,
      config,
      registry,
      mediaClient: new TelegramMediaClient(bot.api, telegramToken),
      modelGate,
    });
    const stickers = new StickerService({ store, config, api: bot.api, media });
    const manager = new McpManager(store, requiredConfig, secrets);
    mcp = manager;
    const runtime = new AgentRuntime({
      store,
      config,
      registry,
      modelSwitcher: new AgentModelSwitcher(config, registry.models),
      telegramApi: bot.api,
      bot: {
        id: BigInt(me.id),
        displayName: [me.first_name, me.last_name].filter((part) => part !== undefined).join(" "),
        username: me.username ?? null,
      },
      modelGate,
      directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
      additionalTools: (context, state, deadline) => [
        media.createReadImageTool(context, deadline),
        stickers.createSearchTool(context, state.stickerCapabilities),
        ...manager.createTools(context, deadline),
      ],
    });
    const preview = previewContext();
    manager.setRegistryValidator((mcpTools) => runtime.validateAdditionalTools(preview, [
      media.createReadImageTool(preview, Number.MAX_SAFE_INTEGER),
      stickers.createSearchTool(preview, new Map()),
      ...mcpTools,
    ]));
    await manager.start();
    console.log(JSON.stringify({
      status: "ok",
      bun: Bun.version,
      fts5_trigram: true,
      sharp: true,
      ffmpeg: true,
      ffprobe: true,
      lottie: true,
      providers: Object.keys(config.providers).length,
      required_mcp: requiredConfig.mcp?.servers.length ?? 0,
      telegram_bot_id: String(me.id),
      config_hash: configHash,
      ...(outputAgentPrompt ? { agent_prompt: renderDoctorAgentPrompt(config) } : {}),
    }));
  } finally {
    await mcp?.stop();
    store.close();
  }
}

function doctorReasoning(model: Model<Api>, level: ModelThinkingLevel): ThinkingLevel | undefined {
  if (!model.reasoning) return undefined;
  return level === "off" ? "low" : level;
}

async function completeDoctorCall(
  store: SqliteStore,
  registry: ModelRegistry,
  model: Model<Api>,
  context: Context,
  reasoning: ThinkingLevel | undefined,
): Promise<AssistantMessage> {
  const startedAt = performance.now();
  const now = new Date().toISOString();
  const created = store.db
    .query("INSERT INTO model_calls(invocation_id, media_analysis_id, role, provider, model, attempt, state, created_at) VALUES (NULL, NULL, 'doctor', ?, ?, 1, 'pending', ?)")
    .run(model.provider, model.id, now);
  const callId = BigInt(created.lastInsertRowid);
  try {
    const response = await registry.models.completeSimple(model, context, {
      ...(reasoning === undefined ? {} : { reasoning }),
      signal: AbortSignal.timeout(30_000),
      maxTokens: Math.min(128, model.maxTokens),
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    const usage = response.usage;
    const state = response.stopReason === "error" || response.stopReason === "aborted" ? "error" : "success";
    store.db
      .query("UPDATE model_calls SET state = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?, cost = ?, duration_ms = ?, error_code = ?, finished_at = ? WHERE id = ?")
      .run(
        state,
        BigInt(usage.input),
        BigInt(usage.output),
        BigInt(usage.cacheRead),
        BigInt(usage.cacheWrite),
        BigInt(usage.totalTokens),
        usage.cost.total,
        BigInt(Math.max(0, Math.round(performance.now() - startedAt))),
        state === "success" ? null : "doctor_model_error",
        new Date().toISOString(),
        callId,
      );
    if (state === "error") throw new Error(`Doctor model probe failed for ${model.provider}/${model.id}`);
    return response;
  } catch (error) {
    store.db
      .query("UPDATE model_calls SET state = 'error', error_code = 'doctor_model_error', duration_ms = ?, finished_at = ? WHERE id = ? AND state = 'pending'")
      .run(BigInt(Math.max(0, Math.round(performance.now() - startedAt))), new Date().toISOString(), callId);
    throw error;
  }
}

async function resolveAllSecrets(
  telegramToken: SecretRef,
  providers: Readonly<Record<string, ProviderConfig>>,
  servers: readonly McpServerConfig[],
  secrets: SecretStore,
): Promise<void> {
  await secrets.resolve(telegramToken);
  for (const provider of Object.values(providers)) {
    await secrets.resolve(provider.api_key);
    if (provider.kind === "custom") {
      for (const reference of Object.values(provider.headers ?? {})) await secrets.resolve(reference);
    }
  }
  for (const server of servers) {
    const references = server.transport === "stdio" ? server.env ?? {} : server.headers ?? {};
    for (const reference of Object.values(references)) await secrets.resolve(reference);
  }
}

function verifyFtsTrigram(): void {
  const database = new Database(":memory:", { strict: true, safeIntegers: true });
  try {
    database.exec("CREATE VIRTUAL TABLE probe USING fts5(value, tokenize='trigram');");
    database.query("INSERT INTO probe(value) VALUES (?)").run("telegram sticker");
    const result = database.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM probe WHERE probe MATCH 'stick'").get();
    if (result?.count !== 1n) throw new Error("SQLite FTS5 trigram probe returned an invalid result");
  } finally {
    database.close();
  }
}

async function verifyLottie(dataDir: string): Promise<void> {
  const directory = await mkdtemp(join(dataDir, "doctor-lottie-"));
  try {
    const input = join(directory, "fixture.tgs");
    const output = join(directory, "fixture.svg");
    const fixture = JSON.stringify({
      v: "5.7.4",
      fr: 30,
      ip: 0,
      op: 1,
      w: 1,
      h: 1,
      nm: "doctor",
      ddd: 0,
      assets: [],
      layers: [],
    });
    await Bun.write(input, gzipSync(fixture));
    await runDependency(createLottieCommand([input, output]));
    const rendered = await sharp(output).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.format !== "png") throw new Error("lottie_convert.py did not produce a renderable SVG");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runDependency(argv: readonly string[]): Promise<void> {
  const processHandle = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: minimalDependencyEnvironment(),
  });
  const timeout = setTimeout(() => processHandle.kill(), 10_000);
  try {
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) throw new Error(`${argv[0] ?? "Dependency"} probe failed with exit code ${exitCode}`);
  } finally {
    clearTimeout(timeout);
  }
}

function minimalDependencyEnvironment(): Record<string, string> {
  const names = process.platform === "win32"
    ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    : ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function previewContext(): InvocationContext {
  return {
    invocationId: 0n,
    conversationId: 0n,
    chatId: 0n,
    threadId: 0n,
    systemPrompt: "",
    userPrompt: "",
    imageCapabilities: new Map(),
    directImages: [],
    replyTargets: new Map(),
    omittedNewMessages: 0,
  };
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { loadConfig } from "../src/config.ts";
import { SecretStore } from "../src/secrets.ts";
import { testConfigToml, writeTestConfig } from "./helpers.ts";
import {
  extractInputCapabilities,
  extractReasoningEffortOptions,
  toModelDefaults,
  type ModelsDevModel,
} from "../src/tui/models-dev.ts";
import { fetchProviderModels, modelsEndpoint } from "../src/tui/provider-models.ts";
import { filterSearchChoices } from "../src/tui/provider-wizard.ts";
import { renderDoctorAgentPrompt } from "../src/doctor.ts";
import { parseCli } from "../src/cli-options.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await writeTestConfig(directory, configPath);
  return { directory, configPath };
}

describe("configure TOML round-trip", () => {
  test("smol-toml output is accepted by loadConfig", async () => {
    const { configPath } = await fixture();
    const { toml } = await loadConfig(configPath);
    const outPath = configPath.replace("config.toml", "out.toml");
    await Bun.write(outPath, stringify(toml as Record<string, unknown>));
    const { config: reparsed } = await loadConfig(outPath);
    expect(reparsed.version).toBe(1);
    expect(reparsed.providers.agent?.kind).toBe("custom");
    expect(reparsed.agent.thinking_level).toBe("low");
  });
});

describe("models.dev client", () => {
  test("extracts text/image capabilities from modalities", () => {
    const model: ModelsDevModel = {
      id: "test-model",
      name: "Test Model",
      reasoning: false,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 128000, output: 4096 },
      cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1 },
    };
    expect(extractInputCapabilities(model)).toEqual(["text", "image"]);
  });

  test("falls back to text when no known capabilities are present", () => {
    const model: ModelsDevModel = {
      id: "audio-model",
      name: "Audio Model",
      reasoning: false,
      modalities: { input: ["audio"], output: ["audio"] },
    };
    expect(extractInputCapabilities(model)).toEqual(["text"]);
  });

  test("extracts reasoning effort options", () => {
    const model: ModelsDevModel = {
      id: "reasoning-model",
      name: "Reasoning Model",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      modalities: { input: ["text"], output: ["text"] },
    };
    expect(extractReasoningEffortOptions(model)).toEqual(["low", "medium", "high"]);
  });

  test("toModelDefaults maps limit and cost", () => {
    const model: ModelsDevModel = {
      id: "test-model",
      name: "Test Model",
      reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 100000, input: 80000, output: 8192 },
      cost: { input: 3, output: 9, cache_read: 1.5, cache_write: 3 },
    };
    const defaults = toModelDefaults(model);
    expect(defaults.name).toBe("Test Model");
    expect(defaults.reasoning).toBe(true);
    expect(defaults.input).toEqual(["text", "image"]);
    expect(defaults.context_window).toBe(100000);
    expect(defaults.max_tokens).toBe(8192);
    expect(defaults.cost).toEqual({ input: 3, output: 9, cache_read: 1.5, cache_write: 3 });
  });
});

describe("provider wizard discovery", () => {
  test("filters choices by case-insensitive keywords", () => {
    const choices = [
      { value: "openai", name: "OpenAI (openai)", description: "GPT models" },
      { value: "anthropic", name: "Claude Sonnet (anthropic)", description: "Reasoning models" },
      { value: "google", name: "Google Gemini (google)" },
    ];
    expect(filterSearchChoices(choices, "CLAUDE anthropic").map((choice) => choice.value)).toEqual(["anthropic"]);
    expect(filterSearchChoices(choices, "reasoning").map((choice) => choice.value)).toEqual(["anthropic"]);
    expect(filterSearchChoices(choices, "   ")).toBe(choices);
  });

  test("appends models to the configured API root", () => {
    expect(modelsEndpoint("https://example.test/v1/")).toBe("https://example.test/v1/models");
    expect(() => modelsEndpoint("https://user@example.test/v1")).toThrow("without credentials");
    expect(() => modelsEndpoint("https://example.test/v1?tenant=a")).toThrow("query");
  });

  test("fetches, authenticates, validates, and deduplicates provider models", async () => {
    let observedPath = "";
    let observedAuthorization = "";
    let observedRoute = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        observedPath = new URL(request.url).pathname;
        observedAuthorization = request.headers.get("authorization") ?? "";
        observedRoute = request.headers.get("x-route") ?? "";
        if (observedPath === "/invalid/models") return Response.json({ models: [] });
        return Response.json({
          object: "list",
          data: [
            { id: "zeta", object: "model" },
            { id: "alpha", name: "Alpha", object: "model" },
            { id: "zeta", object: "model" },
          ],
        });
      },
    });
    try {
      const baseUrl = server.url.toString().replace(/\/$/, "");
      const models = await fetchProviderModels(
        {
          baseUrl: `${baseUrl}/v1`,
          api: "openai-responses",
          apiKey: "provider-secret",
          headers: { "x-route": "route-secret" },
        },
        new SecretStore(),
      );
      expect(observedPath).toBe("/v1/models");
      expect(observedAuthorization).toBe("Bearer provider-secret");
      expect(observedRoute).toBe("route-secret");
      expect(models).toEqual([{ id: "alpha", name: "Alpha" }, { id: "zeta" }]);

      await expect(fetchProviderModels(
        {
          baseUrl: `${baseUrl}/invalid`,
          api: "openai-completions",
          apiKey: "provider-secret",
        },
        new SecretStore(),
      )).rejects.toThrow("invalid OpenAI models response");
    } finally {
      await server.stop(true);
    }
  });
});

describe("configure CLI option", () => {
  test("parses configure command with config path", () => {
    const options = parseCli(["configure", "--config", "dev-data/config.toml"]);
    expect(options.command).toBe("configure");
    expect(options.configPath).toBe("dev-data/config.toml");
  });

  test("accepts doctor agent prompt output option", () => {
    const options = parseCli(["doctor", "--config", "dev-data/config.toml", "--output-agent-prompt"]);
    expect(options.command).toBe("doctor");
    expect(options.outputAgentPrompt).toBe(true);
  });
  test("renders the configured agent prompt templates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plasticwan-doctor-prompt-"));
    directories.push(directory);
    const configPath = join(directory, "config.toml");
    await writeTestConfig(
      directory,
      configPath,
      testConfigToml(directory),
      "Using {{ agent.provider }}/{{ agent.model }} with {{ vision.model }}",
    );
    const loaded = await loadConfig(configPath);
    expect(renderDoctorAgentPrompt(loaded.config)).toBe("Using agent/agent-model with vision-model");
  });
});

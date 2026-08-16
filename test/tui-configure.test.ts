import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { loadConfig } from "../src/config.ts";
import { testConfigToml } from "./helpers.ts";
import {
  extractInputCapabilities,
  extractReasoningEffortOptions,
  toModelDefaults,
  type ModelsDevModel,
} from "../src/tui/models-dev.ts";
import { parseCli } from "../src/cli-options.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "plasticwan-"));
  directories.push(directory);
  const configPath = join(directory, "config.toml");
  await Bun.write(configPath, testConfigToml(directory));
  return { directory, configPath };
}

describe("configure TOML round-trip", () => {
  test("smol-toml output is accepted by loadConfig", async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const outPath = configPath.replace("config.toml", "out.toml");
    await Bun.write(outPath, stringify(config as Record<string, unknown>));
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

describe("configure CLI option", () => {
  test("parses configure command with config path", () => {
    const options = parseCli(["configure", "--config", "dev-data/config.toml"]);
    expect(options.command).toBe("configure");
    expect(options.configPath).toBe("dev-data/config.toml");
  });
});

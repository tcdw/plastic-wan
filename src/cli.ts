#!/usr/bin/env bun
import { serve } from "./application.ts";
import { loadConfig } from "./config.ts";
import { backupDatabase } from "./database.ts";
import { parseCli } from "./cli-options.ts";
import { runDoctor } from "./doctor.ts";
import { runConfigure } from "./tui/configure.ts";

try {
  const options = parseCli(Bun.argv.slice(2));
  switch (options.command) {
    case "check-config": {
      const loaded = await loadConfig(options.configPath);
      console.log(JSON.stringify({ status: "ok", config_hash: loaded.hash }));
      break;
    }
    case "backup": {
      const loaded = await loadConfig(options.configPath);
      const path = await backupDatabase(loaded.config);
      console.log(JSON.stringify({ status: "ok", backup: path }));
      break;
    }
    case "doctor":
      await runDoctor(options.configPath, options.outputAgentPrompt);
      break;
    case "serve":
      await serve(options.configPath);
      break;
    case "configure":
      await runConfigure(options.configPath);
      break;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "error", error: message }));
  process.exitCode = 1;
}

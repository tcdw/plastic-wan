import { stringify } from "smol-toml";
import type { RawConfig } from "../config.ts";

export async function readConfigToml(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  return file.text();
}

export async function writeConfigToml(path: string, config: RawConfig): Promise<void> {
  const text = stringify(config as Record<string, unknown>);
  await Bun.write(path, text);
}

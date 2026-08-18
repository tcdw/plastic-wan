import { join } from "node:path";

export function testConfigToml(directory: string): string {
  const path = (name: string) => JSON.stringify(join(directory, name).replaceAll("\\", "/"));
  return `version = 1
data_dir = ${path("data")}
timezone = "UTC"

[telegram]
token = "telegram-secret"
process_bot_messages = false
bucket_window_seconds = 15

[[telegram.chats]]
id = 123456789
instructions_file = "chat-instructions.md"
budget = { max_invocations_per_day = 100, max_tokens_per_day = 300000 }

[providers.agent]
kind = "custom"
base_url = "https://example.test/v1"
api = "openai-responses"
api_key = "agent-secret"

[[providers.agent.models]]
id = "agent-model"
name = "Agent Model"
reasoning = true
compat = { supports_developer_role = false }
input = ["text", "image"]
context_window = 200000
max_tokens = 32768
cost = { input = 1, output = 2, cache_read = 0.1, cache_write = 1 }

[providers.vision]
kind = "custom"
base_url = "https://example.test/v1"
api = "openai-responses"
api_key = "vision-secret"

[[providers.vision.models]]
id = "vision-model"
name = "Vision Model"
reasoning = false
input = ["text", "image"]
context_window = 128000
max_tokens = 8192
cost = { input = 1, output = 2, cache_read = 0.1, cache_write = 1 }

[agent]
provider = "agent"
model = "agent-model"
max_output_tokens = 4096
thinking_level = "low"
system_prompt_file = "agent-system-prompt.md"
max_turns = 8
max_tool_calls = 12
max_sends = 6
timeout_seconds = 90
max_concurrency = 4
context_stop_ratio = 0.8
history_messages = 20

[vision]
provider = "vision"
model = "vision-model"
max_output_tokens = 2048
max_concurrency = 2
background_sticker_concurrency = 1
prompt_version = 1

[vision.daily_budget]
max_tokens = 200000
max_images = 200

[retention]
online_days = 30
backup_copies = 7

[paths]
database = ${path("plasticwan.sqlite")}
media_cache = ${path("media")}
backups = ${path("backups")}
`;
}

export async function writeTestConfig(directory: string, configPath: string, toml: string = testConfigToml(directory)): Promise<void> {
  await Bun.write(join(directory, "agent-system-prompt.md"), "Participate safely.");
  await Bun.write(join(directory, "chat-instructions.md"), "private");
  await Bun.write(configPath, toml);
}

import { join } from 'node:path';
import type { FileConfig } from '../src/platform/config.ts';

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
          budget: { max_invocations_per_day: 100 },
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
      max_turns: 8,
      max_tool_calls: 12,
      max_sends: 6,
      timeout_seconds: 90,
      max_concurrency: 4,
      context_stop_ratio: 0.8,
      history_messages: 20,
      send_nudge_enabled: true,
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

export async function writeTestConfig(
  directory: string,
  configPath: string,
  jsonc: string = testConfigJsonc(directory),
  systemPrompt = 'Participate safely.',
  chatInstructions = 'private',
): Promise<void> {
  await Bun.write(join(directory, 'agent-system-prompt.md'), systemPrompt);
  await Bun.write(join(directory, 'chat-instructions.md'), chatInstructions);
  await Bun.write(configPath, jsonc);
}

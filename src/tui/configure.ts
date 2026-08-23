import { confirm, select } from '@inquirer/prompts';
import { stringify } from 'smol-toml';
import { loadConfig, type TomlConfig } from '../config.ts';
import { runProviderWizard } from './provider-wizard.ts';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export async function runConfigure(configPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(JSON.stringify({ status: 'error', error: 'configure requires an interactive terminal' }));
    process.exitCode = 1;
    return;
  }
  let config: TomlConfig;
  let originalToml: string;
  try {
    const loaded = await loadConfig(configPath);
    config = loaded.toml;
    const file = Bun.file(configPath);
    originalToml = (await file.exists()) ? await file.text() : '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load config: ${message}`);
    process.exitCode = 1;
    return;
  }

  type MainAction = 'providers' | 'thinking' | 'save' | 'discard';
  let exit = false;
  while (!exit) {
    const action = await select<MainAction>({
      message: 'Plastic Wan configuration',
      choices: [
        { value: 'providers', name: 'Configure providers' },
        { value: 'thinking', name: `Configure agent thinking level (${config.agent.thinking_level})` },
        { value: 'save', name: 'Save and exit' },
        { value: 'discard', name: 'Exit without saving' },
      ],
    });
    switch (action) {
      case 'providers':
        config = await runProviderWizard(config);
        break;
      case 'thinking': {
        const level = await select<(typeof THINKING_LEVELS)[number]>({
          message: 'Agent thinking level',
          choices: THINKING_LEVELS.map((value) => ({ value, name: value })),
        });
        config = { ...config, agent: { ...config.agent, thinking_level: level } };
        break;
      }
      case 'save': {
        const saved = await saveConfig(configPath, config, originalToml);
        if (saved) {
          exit = true;
        }
        break;
      }
      default: {
        const ok = await confirm({ message: 'Discard changes?', default: false });
        if (ok) {
          exit = true;
        }
        break;
      }
    }
  }
}

async function saveConfig(path: string, config: TomlConfig, originalToml: string): Promise<boolean> {
  try {
    await Bun.write(path, stringify(config as Record<string, unknown>));
    const loaded = await loadConfig(path);
    console.log(`Config saved and validated. Hash: ${loaded.hash}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to save config: ${message}`);
    const restore = await confirm({ message: 'Restore previous config?', default: true });
    if (restore) {
      await Bun.write(path, originalToml);
      console.log('Previous config restored.');
    }
    return false;
  }
}

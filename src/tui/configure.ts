import { confirm, select } from '@inquirer/prompts';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig, type FileConfig, type ThinkingLevelConfig } from '../platform/config.ts';
import { supportedThinkingLevels } from '../platform/thinking-levels.ts';
import { runProviderWizard } from './provider-wizard.ts';

export async function runConfigure(configPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(JSON.stringify({ status: 'error', error: 'configure requires an interactive terminal' }));
    process.exitCode = 1;
    return;
  }
  let config: FileConfig;
  let originalSource: string;
  try {
    const loaded = await loadConfig(configPath);
    config = loaded.fileConfig;
    originalSource = await readFile(configPath, 'utf8');
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
        const level = await select<ThinkingLevelConfig>({
          message: `Agent thinking level (${config.agent.provider}/${config.agent.model})`,
          choices: agentThinkingLevels(config).map((value) => ({ value, name: value })),
        });
        config = { ...config, agent: { ...config.agent, thinking_level: level } };
        break;
      }
      case 'save': {
        const saved = await saveConfig(configPath, config, originalSource);
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

/** Only the levels the agent model accepts are offered; saving validates the rest. */
function agentThinkingLevels(config: FileConfig): readonly ThinkingLevelConfig[] {
  const model = config.providers[config.agent.provider]?.models.find(
    (candidate) => candidate.id === config.agent.model,
  );
  return model === undefined ? [config.agent.thinking_level] : supportedThinkingLevels(model);
}

async function saveConfig(path: string, config: FileConfig, originalSource: string): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    const loaded = await loadConfig(path);
    console.log(`Config saved and validated. Hash: ${loaded.hash}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to save config: ${message}`);
    const restore = await confirm({ message: 'Restore previous config?', default: true });
    if (restore) {
      await writeFile(path, originalSource);
      console.log('Previous config restored.');
    }
    return false;
  }
}

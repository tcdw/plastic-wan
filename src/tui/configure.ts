import { confirm, select } from '@inquirer/prompts';
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
import { loadConfig, type FileConfig, type ThinkingLevelConfig } from '../platform/config.ts';
import { keyJarPath, readKeyJar, referencedJarNames, updateKeyJar } from '../platform/key-jar.ts';
import { supportedThinkingLevels } from '../platform/thinking-levels.ts';
import { runProviderWizard } from './provider-wizard.ts';

export async function runConfigure(configPath: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(JSON.stringify({ status: 'error', error: 'configure requires an interactive terminal' }));
    process.exitCode = 1;
    return;
  }
  const keyJar = keyJarPath(configPath);
  let config: FileConfig;
  let originalSource: string;
  let jarBefore: ReadonlySet<string>;
  try {
    const loaded = await loadConfig(configPath);
    config = loaded.fileConfig;
    originalSource = await readFile(configPath, 'utf8');
    jarBefore = new Set(Object.keys((await readKeyJar(keyJar)) ?? {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load config: ${message}`);
    process.exitCode = 1;
    return;
  }

  type MainAction = 'providers' | 'thinking' | 'save' | 'discard';
  try {
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
          config = await runProviderWizard(config, keyJar);
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
  } finally {
    // Also after Ctrl+C, which surfaces as a rejected prompt.
    await pruneKeyJar(configPath, keyJar, jarBefore, jarNamesIn(originalSource));
  }
}

/**
 * Secrets typed during the session are stored as soon as they are entered, so a
 * discarded session, a failed save or a replaced key would leave entries behind.
 * Whatever this session added or the original file used goes once the file on
 * disk no longer references it; entries the jar already had for other reasons
 * stay.
 */
async function pruneKeyJar(
  configPath: string,
  keyJar: string,
  before: ReadonlySet<string>,
  original: ReadonlySet<string>,
): Promise<void> {
  const jar = await readKeyJar(keyJar);
  if (jar === null) {
    return;
  }
  const onDisk = jarNamesIn(await readFile(configPath, 'utf8'));
  const remove = Object.keys(jar).filter((name) => !onDisk.has(name) && (original.has(name) || !before.has(name)));
  if (remove.length > 0) {
    await updateKeyJar(keyJar, { remove });
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

function jarNamesIn(source: string): Set<string> {
  return referencedJarNames(parse(source.replace(/^\uFEFF/, ''), [], { allowTrailingComma: true }));
}

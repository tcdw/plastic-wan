type Command = 'serve' | 'check-config' | 'doctor' | 'backup' | 'configure';

interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
  readonly outputAgentPrompt: boolean;
}

const COMMANDS: readonly string[] = ['serve', 'check-config', 'doctor', 'backup', 'configure'];

export function parseCli(argv: readonly string[]): CliOptions {
  const [commandValue, ...argumentsList] = argv;
  if (commandValue === undefined || !isCommand(commandValue)) {
    throw new Error(usage());
  }
  let configPath: string | undefined;
  let outputAgentPrompt = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--output-agent-prompt' && commandValue === 'doctor' && !outputAgentPrompt) {
      outputAgentPrompt = true;
      continue;
    }
    if (argument !== '--config' || configPath !== undefined) {
      throw new Error(usage());
    }
    configPath = argumentsList[index + 1];
    if (configPath === undefined || configPath.startsWith('--')) {
      throw new Error(usage());
    }
    index += 1;
  }
  if (configPath === undefined) {
    throw new Error(usage());
  }
  return { command: commandValue, configPath, outputAgentPrompt };
}

function isCommand(value: string): value is Command {
  return COMMANDS.includes(value);
}

function usage(): string {
  return 'Usage: plasticwan <serve|check-config|doctor|backup|configure> --config <path> [--output-agent-prompt]';
}

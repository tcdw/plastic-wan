export type Command = "serve" | "check-config" | "doctor" | "backup";

export interface CliOptions {
  readonly command: Command;
  readonly configPath: string;
}

const COMMANDS: Record<Command, true> = {
  serve: true,
  "check-config": true,
  doctor: true,
  backup: true,
};

export function parseCli(argv: readonly string[]): CliOptions {
  const [commandValue, ...argumentsList] = argv;
  if (commandValue === undefined || !isCommand(commandValue)) throw new Error(usage());
  let configPath: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument !== "--config" || configPath !== undefined) throw new Error(usage());
    configPath = argumentsList[index + 1];
    if (configPath === undefined || configPath.startsWith("--")) throw new Error(usage());
    index += 1;
  }
  if (configPath === undefined) throw new Error(usage());
  return { command: commandValue, configPath };
}

function isCommand(value: string): value is Command {
  return value in COMMANDS;
}

export function usage(): string {
  return "Usage: plasticwan <serve|check-config|doctor|backup> --config <path>";
}

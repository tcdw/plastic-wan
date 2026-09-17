import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export function pickEnv(names: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

export interface SpawnedProcess {
  readonly stdout: Readable | null;
  /** Resolves with the close code (null when killed by a signal), rejects when the command cannot start. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

/**
 * Spawns an external command with stdin and stderr ignored. Node reports a
 * missing executable (ENOENT) through the 'error' event instead of throwing,
 * so `exited` rejects in that case rather than hanging forever.
 */
export function spawnProcess(
  argv: readonly string[],
  options: { env: Record<string, string>; stdout: 'pipe' | 'ignore' },
): SpawnedProcess {
  const [command, ...args] = argv;
  if (command === undefined || command.length === 0) {
    throw new Error('Cannot spawn an empty command');
  }
  const child = spawn(command, args, {
    stdio: ['ignore', options.stdout, 'ignore'],
    env: options.env,
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return {
    stdout: child.stdout,
    exited,
    kill: () => {
      child.kill();
    },
  };
}

export async function readBoundedOutput(stream: Readable, limit: number, onOverflow: () => Error): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.byteLength;
    if (size > limit) {
      throw onOverflow();
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

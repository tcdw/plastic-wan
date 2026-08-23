import type { SecretRef } from './config.ts';
import { pickEnv, readBoundedOutput } from './subprocess.ts';

const MAX_SECRET_BYTES = 4_096;
const SECRET_TIMEOUT_MS = 5_000;

export class SecretStore {
  readonly #values = new Set<string>();

  async resolve(reference: SecretRef): Promise<string> {
    let value: string;
    if (typeof reference === 'string') {
      value = reference;
    } else if ('env' in reference) {
      const resolved = process.env[reference.env];
      if (resolved === undefined) throw new Error(`Secret environment variable is not set: ${reference.env}`);
      value = resolved;
    } else {
      value = await resolveCommand(reference.command);
    }
    if (value.length === 0) throw new Error('Resolved secret is empty');
    this.#values.add(value);
    return value;
  }

  redact(text: string): string {
    let redacted = text;
    for (const value of this.#values) redacted = redacted.replaceAll(value, '[REDACTED]');
    return redacted;
  }
}

async function resolveCommand(argv: readonly string[]): Promise<string> {
  const processHandle = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    env: pickEnv(
      process.platform === 'win32'
        ? ['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP']
        : ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'],
    ),
  });
  const timeout = setTimeout(() => processHandle.kill(), SECRET_TIMEOUT_MS);
  try {
    const stdout = await readBoundedOutput(processHandle.stdout, MAX_SECRET_BYTES, () => {
      processHandle.kill();
      return new Error(`Secret command stdout exceeds ${MAX_SECRET_BYTES} bytes`);
    });
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) throw new Error(`Secret command failed with exit code ${exitCode}`);
    return stdout.replace(/\r?\n$/, '');
  } finally {
    clearTimeout(timeout);
  }
}

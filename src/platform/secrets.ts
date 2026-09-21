import type { SecretRef } from './config.ts';
import { pickEnv, readBoundedOutput, spawnProcess } from './subprocess.ts';

const MAX_SECRET_BYTES = 4_096;
const SECRET_TIMEOUT_MS = 5_000;
/**
 * Redaction replaces every occurrence of a known value, so a very short one
 * would mask ordinary words and digits and make the output useless without
 * protecting anything: nothing that short is a credential.
 */
const MIN_REDACTED_LENGTH = 6;
/**
 * How many plaintext values submitted through an API may be remembered. A
 * configured SecretRef lives as long as the process, but submissions arrive with
 * requests and must not accumulate without limit.
 */
const MAX_SUBMITTED_SECRETS = 64;

/**
 * A SecretRef that cannot be turned into a value: a missing environment
 * variable, a failing command, or an empty result. Callers that can report it as
 * a configuration problem rather than a crash distinguish it by type.
 */
export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretResolutionError';
  }
}

export class SecretStore {
  readonly #values = new Set<string>();
  readonly #submitted: string[] = [];

  async resolve(reference: SecretRef): Promise<string> {
    let value: string;
    if (typeof reference === 'string') {
      value = reference;
    } else if ('env' in reference) {
      const resolved = process.env[reference.env];
      if (resolved === undefined) {
        throw new SecretResolutionError(`Secret environment variable is not set: ${reference.env}`);
      }
      value = resolved;
    } else {
      value = await resolveCommand(reference.command);
    }
    if (value.length === 0) {
      throw new SecretResolutionError('Resolved secret is empty');
    }
    this.#values.add(value);
    return value;
  }

  /**
   * Remembers plaintext that arrived with a request (the Admin Panel's API key
   * and header fields) so it can be redacted before it is written or sent
   * anywhere. The oldest entry is dropped once the bound is reached, which keeps
   * repeated submissions — a mistyped key, a probing session — from growing the
   * store and slowing every later redaction down.
   */
  remember(value: string): void {
    const existing = this.#submitted.indexOf(value);
    if (existing >= 0) {
      this.#submitted.splice(existing, 1);
    }
    this.#submitted.push(value);
    if (this.#submitted.length > MAX_SUBMITTED_SECRETS) {
      this.#submitted.shift();
    }
  }

  redact(text: string): string {
    let redacted = text;
    for (const value of [...this.#values, ...this.#submitted]) {
      if (value.length < MIN_REDACTED_LENGTH) {
        continue;
      }
      redacted = redacted.replaceAll(value, '[REDACTED]');
    }
    return redacted;
  }

  redactError(error: unknown): string {
    return this.redact(formatErrorDetail(error));
  }
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const detail = error.stack ?? `${error.name}: ${error.message}`;
    return error.cause === undefined ? detail : `${detail}\nCaused by: ${formatErrorDetail(error.cause)}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

async function resolveCommand(argv: readonly string[]): Promise<string> {
  const processHandle = spawnProcess(argv, {
    env: pickEnv(
      process.platform === 'win32'
        ? ['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP']
        : ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'],
    ),
    stdout: 'pipe',
  });
  if (processHandle.stdout === null) {
    throw new Error('Secret command stdout is unavailable');
  }
  const timeout = setTimeout(() => processHandle.kill(), SECRET_TIMEOUT_MS);
  try {
    const stdout = await readBoundedOutput(processHandle.stdout, MAX_SECRET_BYTES, () => {
      processHandle.kill();
      return new Error(`Secret command stdout exceeds ${MAX_SECRET_BYTES} bytes`);
    });
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) {
      throw new SecretResolutionError(`Secret command failed with exit code ${exitCode}`);
    }
    return stdout.replace(/\r?\n$/, '');
  } finally {
    clearTimeout(timeout);
  }
}

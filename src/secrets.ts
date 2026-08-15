import type { SecretRef } from "./config.ts";

const MAX_SECRET_BYTES = 4_096;
const SECRET_TIMEOUT_MS = 5_000;

export class SecretStore {
  readonly #values = new Set<string>();

  async resolve(reference: SecretRef): Promise<string> {
    let value: string;
    if (typeof reference === "string") {
      value = reference;
    } else if ("env" in reference) {
      const resolved = process.env[reference.env];
      if (resolved === undefined) throw new Error(`Secret environment variable is not set: ${reference.env}`);
      value = resolved;
    } else {
      value = await resolveCommand(reference.command);
    }
    if (value.length === 0) throw new Error("Resolved secret is empty");
    this.#values.add(value);
    return value;
  }

  redact(text: string): string {
    let redacted = text;
    for (const value of this.#values) redacted = redacted.replaceAll(value, "[REDACTED]");
    return redacted;
  }
}

async function resolveCommand(argv: readonly string[]): Promise<string> {
  const processHandle = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: minimalEnvironment(),
  });
  const timeout = setTimeout(() => processHandle.kill(), SECRET_TIMEOUT_MS);
  try {
    const stdout = await readBounded(processHandle.stdout, MAX_SECRET_BYTES, () => processHandle.kill());
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) throw new Error(`Secret command failed with exit code ${exitCode}`);
    return stdout.replace(/\r?\n$/, "");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        onOverflow();
        throw new Error(`Secret command stdout exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

function minimalEnvironment(): Record<string, string> {
  const allowed = process.platform === "win32"
    ? ["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "TEMP", "TMP"]
    : ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"];
  const environment: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

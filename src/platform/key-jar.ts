import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The key jar holds every plaintext secret the configuration uses, keyed by the
 * names `{ "jar": "<name>" }` SecretRefs point at. It sits next to the file it
 * serves, so `config.jsonc` itself never carries a secret and can be read,
 * diffed and shared without exposing one.
 */
export const KEY_JAR_FILE = 'key.json';

export type KeyJar = Readonly<Record<string, string>>;

export function keyJarPath(configPath: string): string {
  return join(dirname(resolve(configPath)), KEY_JAR_FILE);
}

/**
 * A fresh entry name. A replaced secret always gets a new name rather than a new
 * value under the old one: the SecretRef in the configuration then changes too,
 * which is what tells a reload that the connection changed.
 */
export function newKeyJarName(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Reads the jar, or `null` when it does not exist. Errors never quote the file:
 * a JSON parse error echoes the text around the fault, which is a secret here.
 */
export async function readKeyJar(path: string): Promise<KeyJar | null> {
  let text: string;
  try {
    if (process.platform !== 'win32' && ((await stat(path)).mode & 0o777) !== 0o600) {
      throw new Error(`Key jar must have mode 0600: ${path}`);
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Key jar is not valid JSON: ${path}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === 'string' && value.length > 0)
  ) {
    throw new Error(`Key jar must be a JSON object of non-empty strings: ${path}`);
  }
  return parsed as KeyJar;
}

/**
 * Adds and removes entries, replacing the file atomically so a concurrent
 * resolve sees either the old jar or the new one. An added name must be new:
 * overwriting an entry would change a secret without changing its SecretRef.
 */
export async function updateKeyJar(
  path: string,
  change: { readonly add?: KeyJar; readonly remove?: readonly string[] },
): Promise<void> {
  const linked = await lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );
  if (linked) {
    // The rename below would replace the link with a regular file.
    throw new Error(`Key jar must not be a symbolic link: ${path}`);
  }
  // No prototype, so an entry named `__proto__` is stored like any other.
  const next: Record<string, string> = Object.assign(Object.create(null), await readKeyJar(path));
  let changed = false;
  for (const name of change.remove ?? []) {
    changed ||= Object.hasOwn(next, name);
    delete next[name];
  }
  for (const [name, value] of Object.entries(change.add ?? {})) {
    if (Object.hasOwn(next, name)) {
      throw new Error(`Key jar already has an entry named ${name}`);
    }
    next[name] = value;
    changed = true;
  }
  if (!changed) {
    // Nothing to do, and a deployment without a jar must not grow an empty one.
    return;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Every jar entry a configuration references. The walk is structural rather
 * than a list of SecretRef fields, so pruning can never drop an entry that a
 * field added later still points at.
 */
export function referencedJarNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      referencedJarNames(item, names);
    }
  } else if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    const [only] = entries;
    if (entries.length === 1 && only?.[0] === 'jar' && typeof only[1] === 'string') {
      names.add(only[1]);
    } else {
      for (const [, item] of entries) {
        referencedJarNames(item, names);
      }
    }
  }
  return names;
}

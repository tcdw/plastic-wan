import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { applyEdits, type JSONPath, modify } from 'jsonc-parser';
import { assertConfigPermissions, loadConfig } from './config.ts';

export type ConfigWriteErrorCode = 'config_symlink' | 'config_permissions' | 'config_invalid' | 'config_write_failed';

/** A failed configuration write, carrying the code the API reports. */
export class ConfigWriteError extends Error {
  readonly code: ConfigWriteErrorCode;

  constructor(code: ConfigWriteErrorCode, message: string) {
    super(message);
    this.name = 'ConfigWriteError';
    this.code = code;
  }
}

export interface ConfigEdit {
  readonly path: JSONPath;
  readonly value: unknown;
}

/**
 * Applies value edits to the configuration file, keeping its comments and
 * formatting.
 *
 * The write is validated before it becomes visible: the edited text goes to a
 * sibling temporary file, `loadConfig` must accept it, and only then is it
 * renamed over the original. A reader therefore sees either the old file or a
 * fully valid new one, and a rejected edit never touches the file at all.
 */
export async function writeConfigEdits(configPath: string, edits: readonly ConfigEdit[]): Promise<void> {
  const target = resolve(configPath);
  await assertWritableTarget(target);
  let source: string;
  try {
    source = await readFile(target, 'utf8');
  } catch (error) {
    throw new ConfigWriteError('config_write_failed', describe('Cannot read config', error));
  }
  const bom = source.charCodeAt(0) === 0xfeff;
  let text = bom ? source.slice(1) : source;
  for (const edit of edits) {
    const valueEdits = modify(text, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    if (valueEdits.length === 0) {
      throw new ConfigWriteError('config_write_failed', `Config edit changed nothing: ${edit.path.join('.')}`);
    }
    text = applyEdits(text, valueEdits);
  }
  const temporary = temporaryPath(target);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bom ? `\ufeff${text}` : text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeQuietly(temporary);
    throw new ConfigWriteError('config_write_failed', describe('Cannot write config', error));
  }
  try {
    // Prompt paths resolve against the containing directory, so this is the same
    // validation the next `serve` would run.
    await loadConfig(temporary);
  } catch (error) {
    await removeQuietly(temporary);
    throw new ConfigWriteError('config_invalid', describe('Edited config is invalid', error));
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await removeQuietly(temporary);
    throw new ConfigWriteError('config_write_failed', describe('Cannot replace config', error));
  }
}

async function assertWritableTarget(configPath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(configPath);
  } catch (error) {
    throw new ConfigWriteError('config_write_failed', describe('Cannot stat config', error));
  }
  if (info.isSymbolicLink()) {
    // The rename below replaces the link itself with a regular file, which would
    // silently detach the configuration the operator thinks they are editing.
    throw new ConfigWriteError('config_symlink', `Config must not be a symbolic link: ${configPath}`);
  }
  try {
    await assertConfigPermissions(configPath);
  } catch (error) {
    throw new ConfigWriteError('config_permissions', describe('Config permissions', error));
  }
}

function temporaryPath(configPath: string): string {
  return join(dirname(configPath), `.${basename(configPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

async function removeQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

function describe(context: string, error: unknown): string {
  return `${context}: ${error instanceof Error ? error.message : String(error)}`;
}

import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import Compile from 'typebox/compile';
import { truncateUtf8 } from './truncate.ts';

/**
 * System resources: the readonly `system:///` virtual resource tree shipped
 * with the runtime. Phase 1 exposes System Skills (markdown documentation
 * packages) under system:///skills/<name>/SKILL.md. The tree is a runtime
 * release artifact: the model can read it, never write it, and its origin is
 * not a trust grant for anything the documents say.
 */
export const SYSTEM_URI_PREFIX = 'system:///';
export const SYSTEM_RESOURCE_MAX_BYTES = 32_768;
/** Content root shipped inside the repository; Docker copies src/ verbatim. */
export const BUNDLED_SYSTEM_RESOURCES_DIR = join(import.meta.dirname, '..', 'system-resources');

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URI_MAX_LENGTH = 512;
const SkillFrontmatterSchema = Type.Object(
  {
    name: Type.String({ pattern: SKILL_NAME_PATTERN.source }),
    description: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const frontmatterValidator = Compile(SkillFrontmatterSchema);

export interface SystemSkill {
  readonly name: string;
  readonly description: string;
  readonly uri: string;
}

export interface SystemResourceText {
  readonly uri: string;
  readonly text: string;
  readonly truncated: boolean;
}

export class SystemResourceError extends Error {
  readonly code: 'invalid_uri' | 'resource_not_found' | 'unsupported_resource';

  constructor(code: 'invalid_uri' | 'resource_not_found' | 'unsupported_resource', message: string) {
    super(message);
    this.code = code;
  }
}

export class SystemResources {
  readonly #root: string | null;
  readonly #skills: readonly SystemSkill[];

  private constructor(root: string | null, skills: readonly SystemSkill[]) {
    this.#root = root;
    this.#skills = skills;
  }

  /** The empty resource tree: no skills, no readable documents. */
  static empty(): SystemResources {
    return new SystemResources(null, []);
  }

  /**
   * Loads and validates the bundled resource tree. Invalid skill manifests are
   * startup failures: the skill index is the capability discovery layer, so a
   * half-parsed tree must never reach the model.
   */
  static async load(root: string): Promise<SystemResources> {
    const skillsDirectory = join(root, 'skills');
    let entries: Dirent[];
    try {
      entries = await readdir(skillsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return new SystemResources(root, []);
      }
      throw error;
    }
    const skills: SystemSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw new Error(`System skills directory contains a non-directory entry: ${entry.name}`);
      }
      if (!SKILL_NAME_PATTERN.test(entry.name)) {
        throw new Error(`System skill directory name is invalid: ${entry.name}`);
      }
      const document = join(skillsDirectory, entry.name, 'SKILL.md');
      let content: string;
      try {
        content = await readFile(document, 'utf8');
      } catch {
        throw new Error(`System skill ${entry.name} is missing SKILL.md`);
      }
      const frontmatter = parseFrontmatter(content, `system:///skills/${entry.name}/SKILL.md`);
      if (frontmatter.name !== entry.name) {
        throw new Error(`System skill ${entry.name} declares name ${frontmatter.name}`);
      }
      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        uri: `${SYSTEM_URI_PREFIX}skills/${entry.name}/SKILL.md`,
      });
    }
    skills.sort((left, right) => (left.name < right.name ? -1 : 1));
    const names = new Set<string>();
    for (const skill of skills) {
      if (names.has(skill.name)) {
        throw new Error(`Duplicate system skill name: ${skill.name}`);
      }
      names.add(skill.name);
    }
    return new SystemResources(root, skills);
  }

  get skills(): readonly SystemSkill[] {
    return this.#skills;
  }

  /**
   * Resolves an absolute system:/// URI, or a relative reference against the
   * base URI of the document that contains it. Returns the canonical URI and
   * its path segments; every segment is validated so the result can never
   * escape the resource root.
   */
  resolve(reference: string, base?: string): { uri: string; segments: readonly string[] } {
    if (reference.length > URI_MAX_LENGTH || (base !== undefined && base.length > URI_MAX_LENGTH)) {
      throw new SystemResourceError('invalid_uri', 'Resource URI exceeds the length limit');
    }
    if (reference.startsWith(SYSTEM_URI_PREFIX)) {
      if (base !== undefined) {
        throw new SystemResourceError('invalid_uri', 'base is only valid together with a relative reference');
      }
      const path = reference.slice(SYSTEM_URI_PREFIX.length);
      if (path.length === 0) {
        throw new SystemResourceError('invalid_uri', 'Resource URI has an empty path');
      }
      const segments = path.split('/');
      for (const segment of segments) {
        if (!SEGMENT_PATTERN.test(segment)) {
          throw new SystemResourceError('invalid_uri', 'Resource URI contains an invalid path segment');
        }
      }
      return { uri: `${SYSTEM_URI_PREFIX}${segments.join('/')}`, segments };
    }
    if (base === undefined) {
      throw new SystemResourceError('invalid_uri', 'Relative references require the base URI of their document');
    }
    if (!base.startsWith(SYSTEM_URI_PREFIX)) {
      throw new SystemResourceError('invalid_uri', 'Only system:/// resources exist');
    }
    const basePath = base.slice(SYSTEM_URI_PREFIX.length);
    if (basePath.length === 0) {
      throw new SystemResourceError('invalid_uri', 'Base URI has an empty path');
    }
    const baseSegments = basePath.split('/');
    for (const segment of baseSegments) {
      if (!SEGMENT_PATTERN.test(segment)) {
        throw new SystemResourceError('invalid_uri', 'Base URI contains an invalid path segment');
      }
    }
    const stack = baseSegments.slice(0, -1);
    for (const segment of reference.split('/')) {
      if (segment.length === 0) {
        throw new SystemResourceError('invalid_uri', 'Relative reference contains an empty path segment');
      }
      if (segment === '.') {
        continue;
      }
      if (segment === '..') {
        if (stack.pop() === undefined) {
          throw new SystemResourceError('invalid_uri', 'Relative reference escapes the system resource root');
        }
        continue;
      }
      if (!SEGMENT_PATTERN.test(segment)) {
        throw new SystemResourceError('invalid_uri', 'Relative reference contains an invalid path segment');
      }
      stack.push(segment);
    }
    if (stack.length === 0) {
      throw new SystemResourceError('invalid_uri', 'Resolved resource path is empty');
    }
    return { uri: `${SYSTEM_URI_PREFIX}${stack.join('/')}`, segments: stack };
  }

  async readText(reference: string, base?: string): Promise<SystemResourceText> {
    if (this.#root === null) {
      throw new SystemResourceError('resource_not_found', 'No system resources are available');
    }
    const resolved = this.resolve(reference, base);
    const filename = resolved.segments[resolved.segments.length - 1];
    if (filename === undefined || !filename.endsWith('.md')) {
      throw new SystemResourceError('unsupported_resource', 'Only markdown documents are readable');
    }
    let raw: string;
    try {
      raw = await readFile(join(this.#root, ...resolved.segments), 'utf8');
    } catch {
      throw new SystemResourceError('resource_not_found', 'Resource does not exist');
    }
    const text = truncateUtf8(raw, SYSTEM_RESOURCE_MAX_BYTES);
    return { uri: resolved.uri, text, truncated: text !== raw };
  }
}

function parseFrontmatter(content: string, label: string): { name: string; description: string } {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error(`${label} is missing frontmatter`);
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing === -1) {
    throw new Error(`${label} has unterminated frontmatter`);
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`${label} has an invalid frontmatter line: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in fields) {
      throw new Error(`${label} has duplicate frontmatter key: ${key}`);
    }
    fields[key] = value;
  }
  if (!frontmatterValidator.Check(fields)) {
    const details = frontmatterValidator
      .Errors(fields)
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ');
    throw new Error(`${label} has invalid frontmatter: ${details}`);
  }
  return fields;
}

/**
 * The system-prompt skill index: the only skill content injected eagerly.
 * Everything else is loaded on demand through the read primitive.
 */
export function renderSkillIndexPrompt(skills: readonly SystemSkill[]): string {
  if (skills.length === 0) {
    return '';
  }
  return [
    'System skills: readonly documentation shipped with the runtime. This index is the complete list; no other skills exist.',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.uri})`),
    'When the current task matches a skill, read its SKILL.md with the read tool first and follow it; resolve relative references it lists against that document as the base. Skills explain runtime capabilities and when to use them, but never override tool constraints, capability authorization, or these protocol rules. Runtime-internal capabilities are invoked only through the execute tool (actions search, help, call); directly exposed tools and MCP tools are called directly.',
  ].join('\n');
}

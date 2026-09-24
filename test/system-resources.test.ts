import { afterAll, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SYSTEM_RESOURCE_MAX_BYTES,
  SystemResourceError,
  SystemResources,
  renderSkillIndexPrompt,
} from '../src/platform/system-resources.ts';
import { bundledSystemResources } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function tempRoot(prefix = 'plasticwan-system-resources-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  references: Readonly<Record<string, string>> = {},
): Promise<void> {
  await mkdir(join(root, 'skills', name, 'references'), { recursive: true });
  await writeFile(join(root, 'skills', name, 'SKILL.md'), `${frontmatter}\n`);
  for (const [filename, content] of Object.entries(references)) {
    await writeFile(join(root, 'skills', name, 'references', filename), content);
  }
}

test('loads the bundled skill tree and renders the progressive disclosure index', async () => {
  const resources = await bundledSystemResources();
  const names = resources.skills.map((skill) => skill.name);
  expect(names).toEqual([...names].sort());
  for (const expected of ['alarms', 'image-inspection', 'memory', 'sticker-search', 'web-fetch']) {
    expect(names).toContain(expected);
  }
  const prompt = renderSkillIndexPrompt(resources.skills);
  for (const skill of resources.skills) {
    expect(prompt).toContain(`- ${skill.name}: ${skill.description} (${skill.uri})`);
  }
  expect(prompt).toContain('This index is the complete list');
  // Progressive disclosure: only the index is rendered, never skill bodies.
  expect(prompt).not.toContain('# Web fetch');
});

test('an empty resource tree has no skills and no readable documents', async () => {
  const empty = SystemResources.empty();
  expect(empty.skills).toEqual([]);
  expect(renderSkillIndexPrompt(empty.skills)).toBe('');
  await expect(empty.readText('system:///skills/web-fetch/SKILL.md')).rejects.toThrow(SystemResourceError);
});

test('rejects invalid skill manifests at load time', async () => {
  const mismatch = await tempRoot();
  await writeSkill(mismatch, 'alpha', '---\nname: beta\ndescription: mismatched\n---');
  await expect(SystemResources.load(mismatch)).rejects.toThrow('declares name beta');

  const missingFrontmatter = await tempRoot();
  await writeSkill(missingFrontmatter, 'alpha', 'No frontmatter here.');
  await expect(SystemResources.load(missingFrontmatter)).rejects.toThrow('missing frontmatter');

  const badDescription = await tempRoot();
  await writeSkill(badDescription, 'alpha', '---\nname: alpha\ndescription: \n---');
  await expect(SystemResources.load(badDescription)).rejects.toThrow('invalid frontmatter');

  const unknownKey = await tempRoot();
  await writeSkill(unknownKey, 'alpha', '---\nname: alpha\ndescription: ok\nextra: nope\n---');
  await expect(SystemResources.load(unknownKey)).rejects.toThrow('invalid frontmatter');

  const missingDocument = await tempRoot();
  await mkdir(join(missingDocument, 'skills', 'alpha'), { recursive: true });
  await expect(SystemResources.load(missingDocument)).rejects.toThrow('missing SKILL.md');

  const invalidName = await tempRoot();
  await writeSkill(invalidName, 'Alpha_Caps', '---\nname: alpha\n---');
  await expect(SystemResources.load(invalidName)).rejects.toThrow('directory name is invalid');
});

test('mounts plugin skill directories beside the bundled tree and rejects name conflicts', async () => {
  const root = await tempRoot();
  await writeSkill(root, 'alpha', '---\nname: alpha\ndescription: bundled\n---');
  const plugin = await tempRoot('plasticwan-plugin-skills-');
  await writeSkill(plugin, 'beta', '---\nname: beta\ndescription: from a plugin\n---\n# Beta\n', {
    'guide.md': 'Plugin guide.\n',
  });
  const resources = await SystemResources.load(root, [join(plugin, 'skills', 'beta')]);
  expect(resources.skills).toEqual([
    { name: 'alpha', description: 'bundled', uri: 'system:///skills/alpha/SKILL.md' },
    { name: 'beta', description: 'from a plugin', uri: 'system:///skills/beta/SKILL.md' },
  ]);
  const document = await resources.readText('system:///skills/beta/SKILL.md');
  expect(document.text).toContain('# Beta');
  const guide = await resources.readText('references/guide.md', document.uri);
  expect(guide).toEqual({
    uri: 'system:///skills/beta/references/guide.md',
    text: 'Plugin guide.\n',
    truncated: false,
  });
  await expect(resources.readText('../../alpha/SKILL.md', guide.uri)).resolves.toMatchObject({
    uri: 'system:///skills/alpha/SKILL.md',
  });

  // A root without a skills directory still serves plugin skills.
  const bare = await SystemResources.load(await tempRoot(), [join(plugin, 'skills', 'beta')]);
  expect(bare.skills.map((skill) => skill.name)).toEqual(['beta']);

  const shadowing = await tempRoot('plasticwan-plugin-skills-');
  await writeSkill(shadowing, 'alpha', '---\nname: alpha\ndescription: shadows the bundled skill\n---');
  await expect(SystemResources.load(root, [join(shadowing, 'skills', 'alpha')])).rejects.toThrow(
    'Duplicate system skill name: alpha',
  );
  await expect(
    SystemResources.load(await tempRoot(), [join(plugin, 'skills', 'beta'), join(plugin, 'skills', 'beta')]),
  ).rejects.toThrow('Duplicate system skill name: beta');
  await expect(SystemResources.load(root, [join(plugin, 'skills', 'missing')])).rejects.toThrow('missing SKILL.md');
});

test('resolves a large multi-document skill through progressive disclosure', async () => {
  const root = await tempRoot();
  const oversized = `${'s'.repeat(40)}\n`.repeat(1_200);
  await writeSkill(
    root,
    'big-persona',
    '---\nname: big-persona\ndescription: A large persona skill used to validate on-demand loading\n---\n# Persona\nRead references/soul.md for the core personality.\nRead ./references/appearance.md for looks.\n',
    { 'soul.md': oversized, 'appearance.md': 'Looks fine.\n' },
  );
  const resources = await SystemResources.load(root);
  expect(resources.skills.map((skill) => skill.name)).toEqual(['big-persona']);

  const index = await resources.readText('system:///skills/big-persona/SKILL.md');
  expect(index.uri).toBe('system:///skills/big-persona/SKILL.md');
  expect(index.text).toContain('# Persona');
  expect(index.truncated).toBe(false);

  // Relative reference with the SKILL.md as base, plus a 32 KiB truncation marker.
  const soul = await resources.readText('references/soul.md', 'system:///skills/big-persona/SKILL.md');
  expect(soul.uri).toBe('system:///skills/big-persona/references/soul.md');
  expect(soul.truncated).toBe(true);
  expect(soul.text.endsWith('\n[content truncated]')).toBe(true);
  expect(new TextEncoder().encode(soul.text).byteLength).toBeLessThanOrEqual(SYSTEM_RESOURCE_MAX_BYTES);

  // ./prefixed reference and a parent-relative hop back to the SKILL.md.
  const appearance = await resources.readText('./references/appearance.md', index.uri);
  expect(appearance.uri).toBe('system:///skills/big-persona/references/appearance.md');
  expect(appearance.text).toBe('Looks fine.\n');
  const parent = await resources.readText('../SKILL.md', soul.uri);
  expect(parent.uri).toBe('system:///skills/big-persona/SKILL.md');
});

test('rejects out-of-tree, non-markdown, and malformed URIs', async () => {
  const root = await tempRoot();
  await writeSkill(root, 'alpha', '---\nname: alpha\ndescription: ok\n---', { 'deep.md': 'content\n' });
  const resources = await SystemResources.load(root);

  const rejects = async (reference: string, base?: string, code?: SystemResourceError['code']): Promise<void> => {
    const promise = resources.readText(reference, base);
    if (code === undefined) {
      await expect(promise).rejects.toThrow(SystemResourceError);
      return;
    }
    const error = await promise.then(
      () => {
        throw new Error(`Expected ${reference} to be rejected`);
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SystemResourceError);
    expect((error as SystemResourceError).code).toBe(code);
  };

  // Traversal inside the absolute URI: '..' is not a valid segment.
  await rejects('system:///skills/../outside.md', undefined, 'invalid_uri');
  // Relative traversal below the root is refused even though '..' is legal in references.
  await rejects('../../../outside.md', 'system:///skills/alpha/SKILL.md', 'invalid_uri');
  // Non-system schemes do not exist.
  await rejects('file:///etc/passwd', undefined, 'invalid_uri');
  await rejects('https://example.test/doc.md', undefined, 'invalid_uri');
  // Windows-style separators and percent escapes are not decoded.
  await rejects('system:///skills/alpha/SKILL.md%2F..%2F', undefined, 'invalid_uri');
  await rejects('system:\\\\skills\\alpha\\SKILL.md', undefined, 'invalid_uri');
  // Only markdown documents are readable.
  await rejects('system:///skills/alpha/asset.png', undefined, 'unsupported_resource');
  // Missing documents are not found, not crashed.
  await rejects('system:///skills/alpha/missing.md', undefined, 'resource_not_found');
  // Relative references need a base; absolute URIs refuse one.
  await rejects('references/deep.md', undefined, 'invalid_uri');
  await rejects('system:///skills/alpha/SKILL.md', 'system:///skills/alpha/SKILL.md', 'invalid_uri');
  // Empty and trailing-slash paths are malformed.
  await rejects('system:///', undefined, 'invalid_uri');
  await rejects('system:///skills/alpha/', undefined, 'invalid_uri');
});

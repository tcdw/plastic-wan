import { expect, test } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { definePlugin, loadPlugins } from '../src/plugins/plugin.ts';

test('loadPlugins rejects invalid and duplicate plugin ids', () => {
  expect(() => loadPlugins([definePlugin({ id: 'Web_Fetch' })])).toThrow('Plugin id is invalid: Web_Fetch');
  expect(() => loadPlugins([definePlugin({ id: 'twin' }), definePlugin({ id: 'twin' })])).toThrow(
    'Duplicate plugin id: twin',
  );
});

test('built-in plugins load with unique ids and their skill directories', () => {
  const loaded = loadPlugins(BUILTIN_PLUGINS);
  expect(loaded.skillDirectories.map((directory) => directory.split(/[\\/]/).at(-1))).toEqual(['web-fetch']);
});

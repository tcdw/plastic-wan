import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { docsRoot } from '../scripts/docs-prepare.ts';

test('the pinned Rspress keyboard handler ignores closed, empty and non-input events', async () => {
  const require = createRequire(resolve(docsRoot, 'package.json'));
  const coreRoot = dirname(require.resolve('@rspress/core/package.json'));
  const source = await readFile(resolve(coreRoot, 'dist/theme/components/Search/SearchPanel.js'), 'utf8');
  // Exercise the installed patched handler without duplicating search logic or adding a DOM test runtime.
  // An upstream layout change deliberately fails here and requires reviewing whether the patch is still needed.
  const setup = source.match(/const KEY_CODE = [\s\S]+?(?=function SearchPanel)/)?.[0];
  const handler = source.match(/const onKeyDown = \(e\)=>\{[\s\S]+?(?=\n {8}document\.addEventListener)/)?.[0];
  expect(setup).toBeDefined();
  expect(handler).toBeDefined();
  const input = {};
  const navigations: string[] = [];
  let prevented = 0;
  let closed = 0;
  const state = {
    focused: false,
    searchInputRef: { current: input },
    currentSuggestions: [] as { title: string; link: string }[],
    currentSuggestionIndex: 0,
    currentRenderType: 'default',
    RenderType: { Default: 'default' },
    navigate: (link: string) => navigations.push(link),
    clearSearchState: () => closed++,
    setCanScroll: () => {},
    setCurrentSuggestionIndex: (index: number) => {
      state.currentSuggestionIndex = index;
    },
  };
  const onKeyDown: unknown = runInNewContext(`${setup}\n${handler}\nonKeyDown;`, state);
  if (typeof onKeyDown !== 'function') {
    throw new Error('Rspress search keyboard handler was not found');
  }
  const press = (code: string, target: object = input, isComposing = false): void => {
    onKeyDown({ code, target, isComposing, preventDefault: () => prevented++ });
  };
  press('Enter');
  state.currentSuggestions = [{ title: '文档', link: '/docs/index.html' }];
  press('Enter');
  expect(navigations).toEqual([]);
  state.focused = true;
  state.currentSuggestions = [];
  press('ArrowDown');
  press('ArrowUp');
  press('Enter');
  expect(state.currentSuggestionIndex).toBe(0);
  expect(prevented).toBe(0);
  state.currentSuggestions = [
    { title: '文档', link: '/docs/index.html' },
    { title: '人格', link: '/docs/guides/personality.html' },
  ];
  press('ArrowDown', {});
  press('Enter', {});
  press('ArrowDown', input, true);
  press('Enter', input, true);
  expect(navigations).toEqual([]);
  expect(state.currentSuggestionIndex).toBe(0);
  state.currentSuggestionIndex = 10;
  press('Enter');
  expect(navigations).toEqual([]);
  state.currentSuggestionIndex = 0;
  press('ArrowUp');
  expect(state.currentSuggestionIndex).toBe(1);
  press('ArrowDown');
  expect(state.currentSuggestionIndex).toBe(0);
  press('ArrowDown');
  press('Enter');
  expect(navigations).toEqual(['/docs/guides/personality.html']);
  expect(closed).toBe(1);
  expect(prevented).toBe(4);
});

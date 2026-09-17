import { expect, test } from 'vitest';
import { stripHtmlComments } from '../src/platform/prompt-markdown.ts';

test('removes annotations and the lines that held only an annotation', () => {
  expect(stripHtmlComments('Stay kind.\n<!-- why this rule exists -->\nBe brief.')).toBe('Stay kind.\nBe brief.');
  expect(stripHtmlComments('Before<!-- note --> after')).toBe('Before after');
});

test('removes annotations that span multiple lines', () => {
  expect(stripHtmlComments('A\n<!--\nwhy\n-->\nB')).toBe('A\nB');
});

test('keeps unterminated annotations and blank lines that were already there', () => {
  expect(stripHtmlComments('A <!-- not closed')).toBe('A <!-- not closed');
  expect(stripHtmlComments('A\n\nB')).toBe('A\n\nB');
});

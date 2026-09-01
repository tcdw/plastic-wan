import { expect, test } from 'bun:test';
import { renderPromptTemplate, validatePromptTemplate } from '../src/platform/prompt-template.ts';

test('renders the allowlisted model and timezone values', () => {
  expect(
    renderPromptTemplate(
      '{{ agent.provider }}/{{agent.model}}; {{ vision.provider }}/{{ vision.model }}; {{timezone}}',
      {
        agent: { provider: 'gateway', model: 'chat-model' },
        vision: { provider: 'vision-gateway', model: 'vision-model' },
        timezone: 'Asia/Shanghai',
      },
    ),
  ).toBe('gateway/chat-model; vision-gateway/vision-model; Asia/Shanghai');
});

test('rejects unsupported and malformed expressions', () => {
  expect(() => validatePromptTemplate('{{agent.api_key}}', 'system prompt')).toThrow('unsupported template variable');
  expect(() => validatePromptTemplate('{{agent.model', 'system prompt')).toThrow('malformed template expression');
});

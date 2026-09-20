import { describe, expect, test } from 'vitest';
import type { ModelMetadataDraft, ProviderModelConfig } from './api.ts';
import {
  applyFeedback,
  compatConfigFromState,
  compatFieldsForApi,
  compatStateFromConfig,
  draftNeedsConfirmation,
  isDraftFieldUnconfirmed,
  metadataSourceLabel,
  modelFormFromConfig,
  modelFromDraft,
  modelPendingRestart,
  modelUsage,
  parseModelIds,
  providerPendingRestart,
  unconfirmedFields,
  validateModelForm,
  writeErrorMessage,
} from './model-manager.ts';

function draft(overrides: Partial<ModelMetadataDraft> = {}): ModelMetadataDraft {
  return {
    id: 'vendor/model',
    name: 'Model',
    reasoning: true,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    requires_reasoning_content: false,
    sources: {
      name: 'openrouter',
      reasoning: 'openrouter',
      input: 'openrouter',
      context_window: 'openrouter',
      max_tokens: 'openrouter',
      cost: 'openrouter',
    },
    requires_reasoning_content_source: 'models.dev',
    match: null,
    candidates: [],
    needs_confirmation: [],
    ...overrides,
  };
}

describe('metadata source labels', () => {
  test('names every source the API can report', () => {
    expect(metadataSourceLabel('openrouter')).toBe('OpenRouter');
    expect(metadataSourceLabel('vercel')).toBe('Vercel');
    expect(metadataSourceLabel('models.dev')).toBe('models.dev');
    expect(metadataSourceLabel('models.dev-fuzzy')).toBe('models.dev (模糊匹配)');
    expect(metadataSourceLabel('missing')).toBe('缺失');
  });
});

describe('draft confirmation', () => {
  test('a fuzzy match alone is enough to require confirmation', () => {
    const fuzzy = draft({
      sources: {
        name: 'models.dev-fuzzy',
        reasoning: 'models.dev-fuzzy',
        input: 'models.dev',
        context_window: 'models.dev',
        max_tokens: 'models.dev',
        cost: 'models.dev',
      },
    });
    expect(draftNeedsConfirmation(fuzzy)).toBe(false);
    expect(isDraftFieldUnconfirmed(fuzzy, 'reasoning')).toBe(true);
    expect(isDraftFieldUnconfirmed(fuzzy, 'name')).toBe(false);
    expect(unconfirmedFields(fuzzy)).toEqual(['reasoning']);
  });

  test('a missing value is unconfirmed even when the server did not flag it', () => {
    const missing = draft({ reasoning: null });
    expect(isDraftFieldUnconfirmed(missing, 'reasoning')).toBe(true);
    expect(unconfirmedFields(missing)).toEqual(['reasoning']);
  });

  test('a complete draft converts to a model config', () => {
    expect(modelFromDraft(draft())).toEqual({
      id: 'vendor/model',
      name: 'Model',
      reasoning: true,
      input: ['text'],
      context_window: 128_000,
      max_tokens: 8_192,
      cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    });
  });

  test('a draft with a null limit never produces a silently defaulted model', () => {
    expect(modelFromDraft(draft({ max_tokens: null }))).toBeUndefined();
    expect(modelFromDraft(draft({ cost: null }))).toBeUndefined();
    expect(modelFromDraft(draft({ input: null }))).toBeUndefined();
  });
});

describe('compat applicability', () => {
  test('only openai-completions exposes all five overrides', () => {
    expect(compatFieldsForApi('openai-completions').map((spec) => spec.field)).toEqual([
      'supports_developer_role',
      'thinking_format',
      'max_tokens_field',
      'requires_reasoning_content',
      'cache_control_format',
    ]);
    expect(compatFieldsForApi('openai-responses').map((spec) => spec.field)).toEqual(['supports_developer_role']);
    expect(compatFieldsForApi('anthropic-messages')).toEqual([]);
    expect(compatFieldsForApi('google-generative-ai')).toEqual([]);
  });

  test('every field defaults to automatic and round-trips through the form state', () => {
    const state = compatStateFromConfig('openai-completions', undefined);
    expect(Object.values(state).every((value) => value === 'auto')).toBe(true);
    expect(compatConfigFromState('openai-completions', state)).toBeUndefined();
  });

  test('booleans map to on/off and enums keep their value', () => {
    const state = compatStateFromConfig('openai-completions', {
      supports_developer_role: false,
      thinking_format: 'deepseek',
      cache_control_format: 'anthropic',
    });
    expect(state.supports_developer_role).toBe('off');
    expect(state.thinking_format).toBe('deepseek');
    expect(state.max_tokens_field).toBe('auto');
    expect(compatConfigFromState('openai-completions', state)).toEqual({
      supports_developer_role: false,
      thinking_format: 'deepseek',
      cache_control_format: 'anthropic',
    });
  });

  test('fields the API does not read are dropped from the state', () => {
    const state = compatStateFromConfig('anthropic-messages', { supports_developer_role: true });
    expect(state).toEqual({});
    expect(compatConfigFromState('anthropic-messages', { supports_developer_role: 'on' })).toBeUndefined();
  });
});

describe('model form validation', () => {
  const config: ProviderModelConfig = {
    id: 'vendor/model',
    name: 'Model',
    reasoning: false,
    input: ['text', 'image'],
    context_window: 200_000,
    max_tokens: 32_768,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  };

  test('a stored model round-trips into a valid form', () => {
    const form = modelFormFromConfig(config, 'openai-completions');
    expect(validateModelForm(form)).toEqual({});
    expect(form.cost.cache_read).toBe('0.1');
  });

  test('requires an id, an input modality and both limits', () => {
    const form = {
      ...modelFormFromConfig(config, 'openai-completions'),
      id: '',
      input: [],
      context_window: '',
      max_tokens: 'abc',
    };
    const errors = validateModelForm(form);
    expect(errors.id).toBeDefined();
    expect(errors.input).toBeDefined();
    expect(errors.context_window).toBeDefined();
    expect(errors.max_tokens).toBeDefined();
  });

  test('rejects an output limit above the context window', () => {
    const form = { ...modelFormFromConfig(config, 'openai-completions'), max_tokens: '300000' };
    expect(validateModelForm(form).max_tokens).toBe('max output cannot exceed the context window');
  });

  test('requires all four prices instead of defaulting them', () => {
    const form = {
      ...modelFormFromConfig(config, 'openai-completions'),
      cost: { input: '1', output: '', cache_read: '0', cache_write: '0' },
    };
    expect(validateModelForm(form).cost).toBeDefined();
  });
});

describe('restart paths', () => {
  test('matches connection and model paths of one provider only', () => {
    const paths = ['providers.oproxy.base_url', 'providers.relay.models[vendor/model]'];
    expect(providerPendingRestart(paths, 'oproxy')).toBe(true);
    expect(providerPendingRestart(paths, 'relay')).toBe(true);
    expect(providerPendingRestart(paths, 'relay2')).toBe(false);
    expect(modelPendingRestart(paths, 'relay', 'vendor/model')).toBe(true);
    expect(modelPendingRestart(paths, 'relay', 'other')).toBe(false);
    expect(modelPendingRestart(paths, 'oproxy', 'vendor/model')).toBe(false);
  });
});

describe('in-use lookup', () => {
  const view = {
    agent: { provider: 'agent', model: 'agent-model' },
    vision: { provider: 'vision', model: 'vision-model' },
  };

  test('reports which role a model fills', () => {
    expect(modelUsage(view, 'agent', 'agent-model')).toBe('agent');
    expect(modelUsage(view, 'vision', 'vision-model')).toBe('vision');
    expect(modelUsage(view, 'agent', 'other')).toBeNull();
  });
});

describe('write feedback', () => {
  test('a pending restart is never reported as applied', () => {
    expect(applyFeedback({ applied: [], restart_required: ['providers.x.api_key'] })).toEqual({
      title: '已保存，待重启',
      description: '待重启字段：providers.x.api_key',
    });
    const mixed = applyFeedback({
      applied: ['providers.x.models[y]'],
      restart_required: ['providers.x.base_url'],
    });
    expect(mixed.title).toBe('已保存，待重启');
    expect(mixed.description).toContain('已生效：providers.x.models[y]');
  });

  test('a hot update reports itself as applied', () => {
    expect(applyFeedback({ applied: ['providers.x.models[y]'], restart_required: [] }).title).toBe('已生效');
    expect(applyFeedback({ applied: [], restart_required: [] }).title).toBe('已保存');
  });
});

describe('error text', () => {
  test('a stale revision is explained instead of echoed as a code', async () => {
    const { ApiError } = await import('./api.ts');
    const message = writeErrorMessage(new ApiError(409, 'config_conflict', 'revision mismatch'));
    expect(message).toContain('配置文件已被修改');
  });

  test('other failures keep the code and message', async () => {
    const { ApiError } = await import('./api.ts');
    expect(writeErrorMessage(new ApiError(400, 'credentials_required', 'key needed'))).toBe(
      'credentials_required: key needed',
    );
  });
});

describe('model id parsing', () => {
  test('splits on whitespace and commas and drops duplicates', () => {
    expect(parseModelIds(' a/b , c\n\nd, a/b ')).toEqual(['a/b', 'c', 'd']);
    expect(parseModelIds('   ')).toEqual([]);
  });
});

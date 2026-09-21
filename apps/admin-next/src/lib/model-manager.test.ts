import { describe, expect, test } from 'vitest';
import type { ModelMetadataDraft, ProviderModelConfig } from './api.ts';
import {
  agentModelConfig,
  applyFeedback,
  compatConfigFromState,
  compatFieldsForApi,
  compatStateFromConfig,
  draftNeedsConfirmation,
  isDraftFieldUnconfirmed,
  matchLabel,
  metadataSourceLabel,
  modelFormFromConfig,
  modelFormToConfig,
  modelFromDraft,
  modelUsage,
  parseModelIds,
  supportedThinkingLevels,
  unconfirmedFields,
  validateModelForm,
  writeErrorMessage,
} from './model-manager.ts';

function draft(overrides: Partial<ModelMetadataDraft> = {}): ModelMetadataDraft {
  return {
    id: 'vendor/model',
    name: 'Model',
    reasoning: true,
    thinking_levels: null,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    requires_reasoning_content: false,
    sources: {
      name: 'openrouter',
      reasoning: 'openrouter',
      thinking_levels: 'missing',
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
    expect(metadataSourceLabel('models.dev-cross-provider')).toBe('models.dev (other provider)');
    expect(metadataSourceLabel('models.dev-fuzzy')).toBe('models.dev (fuzzy match)');
    expect(metadataSourceLabel('missing')).toBe('missing');
  });

  test('names where a draft was matched, and says nothing when it was not', () => {
    expect(matchLabel(null)).toBeNull();
    expect(matchLabel({ provider: 'openrouter', model: 'vendor/model', confidence: 'exact' })).toBe(
      'Matched against models.dev openrouter / vendor/model',
    );
    expect(matchLabel({ provider: 'openrouter', model: 'vendor/model', confidence: 'cross-provider' })).toContain(
      'other provider',
    );
    expect(matchLabel({ provider: 'openrouter', model: 'vendor/model', confidence: 'fuzzy' })).toContain('fuzzy match');
  });
});

describe('draft confirmation', () => {
  test('a fuzzy match alone is enough to require confirmation', () => {
    const fuzzy = draft({
      sources: {
        name: 'models.dev-fuzzy',
        reasoning: 'models.dev-fuzzy',
        thinking_levels: 'missing',
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

  test('a cross-provider match needs confirming just like a fuzzy one', () => {
    const borrowed = draft({
      sources: {
        name: 'models.dev-cross-provider',
        reasoning: 'models.dev-cross-provider',
        thinking_levels: 'models.dev-cross-provider',
        input: 'models.dev-cross-provider',
        context_window: 'models.dev-cross-provider',
        max_tokens: 'models.dev-cross-provider',
        cost: 'models.dev-cross-provider',
      },
    });
    expect(unconfirmedFields({ ...borrowed, thinking_levels: ['low', 'high'] })).toEqual([
      'reasoning',
      'thinking_levels',
      'input',
      'context_window',
      'max_tokens',
      'cost',
    ]);
    expect(isDraftFieldUnconfirmed(borrowed, 'name')).toBe(false);
  });

  test('a missing value is unconfirmed even when the server did not flag it', () => {
    const missing = draft({ reasoning: null });
    expect(isDraftFieldUnconfirmed(missing, 'reasoning')).toBe(true);
    expect(unconfirmedFields(missing)).toEqual(['reasoning']);
  });

  test('missing thinking levels block nothing: the model runs on Pi default', () => {
    expect(isDraftFieldUnconfirmed(draft({ thinking_levels: null }), 'thinking_levels')).toBe(false);
    expect(modelFromDraft(draft({ thinking_levels: null }))).not.toHaveProperty('thinking_levels');
    expect(modelFromDraft(draft({ thinking_levels: ['off', 'high'] }))).toMatchObject({
      thinking_levels: ['off', 'high'],
    });
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

describe('thinking levels', () => {
  test('follow the server rule: off only, Pi default, or the declared list in order', () => {
    expect(supportedThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(supportedThinkingLevels({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(supportedThinkingLevels({ reasoning: true, thinking_levels: ['max', 'off', 'high'] })).toEqual([
      'off',
      'high',
      'max',
    ]);
  });

  test('the form writes declared levels in order and drops them with reasoning', () => {
    const base = modelFormFromConfig(
      {
        id: 'm',
        reasoning: true,
        thinking_levels: ['off', 'high'],
        input: ['text'],
        context_window: 1_000,
        max_tokens: 100,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
      'openai-completions',
    );
    expect(base.thinking_levels).toEqual(['off', 'high']);
    expect(modelFormToConfig({ ...base, thinking_levels: ['max', 'low'] }, 'openai-completions')).toMatchObject({
      thinking_levels: ['low', 'max'],
    });
    // None checked means "leave it out".
    expect(modelFormToConfig({ ...base, thinking_levels: [] }, 'openai-completions')).not.toHaveProperty(
      'thinking_levels',
    );
    expect(modelFormToConfig({ ...base, reasoning: false }, 'openai-completions')).not.toHaveProperty(
      'thinking_levels',
    );
  });

  test('finds the agent model in the file view', () => {
    const model: ProviderModelConfig = {
      id: 'agent-model',
      reasoning: true,
      input: ['text'],
      context_window: 1_000,
      max_tokens: 100,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    };
    const provider = {
      alias: 'agent',
      kind: 'custom' as const,
      api: 'openai-completions' as const,
      base_url: 'https://example.test/v1',
      header_names: [],
      models: [model],
    };
    expect(agentModelConfig({ agent: { provider: 'agent', model: 'agent-model' }, providers: [provider] })).toBe(model);
    expect(agentModelConfig({ agent: { provider: 'agent', model: 'gone' }, providers: [provider] })).toBeNull();
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
      title: 'Saved, restart required',
      description: 'Waiting for a restart: providers.x.api_key',
    });
    const mixed = applyFeedback({
      applied: ['providers.x.models[y]'],
      restart_required: ['providers.x.base_url'],
    });
    expect(mixed.title).toBe('Saved, restart required');
    expect(mixed.description).toContain('Applied: providers.x.models[y]');
  });

  test('a hot update reports itself as applied', () => {
    expect(applyFeedback({ applied: ['providers.x.models[y]'], restart_required: [] }).title).toBe('Applied');
    expect(applyFeedback({ applied: [], restart_required: [] }).title).toBe('Saved');
  });
});

describe('error text', () => {
  test('a stale revision is explained instead of echoed as a code', async () => {
    const { ApiError } = await import('./api.ts');
    const message = writeErrorMessage(new ApiError(409, 'config_conflict', 'revision mismatch'));
    expect(message).toContain('config.jsonc changed');
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

import {
  ApiError,
  type DraftField,
  type MetadataSource,
  type ModelsDevConfidence,
  type ModelsDevMatch,
  type ModelApplySummary,
  type ModelCompatConfig,
  type ModelCostConfig,
  type ModelInput,
  type ModelMetadataDraft,
  type ProviderApi,
  type ProviderModelConfig,
  type ProviderView,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './api.ts';
import { errorMessage } from './errors.ts';

/**
 * Pure helpers for the Models page: metadata source labels, draft → config
 * conversion, compat tri-state and write feedback. The
 * page keeps only React state and mutations; every decision that can be tested
 * without a DOM lives here.
 */

const DRAFT_FIELDS: readonly DraftField[] = [
  'name',
  'reasoning',
  'thinking_levels',
  'input',
  'context_window',
  'max_tokens',
  'cost',
];

/**
 * Fields the configuration may leave out. A missing name shows the id; missing
 * thinking levels leave the model on Pi's default.
 */
const OPTIONAL_FIELDS: readonly DraftField[] = ['name', 'thinking_levels'];

const SOURCE_LABELS: Record<MetadataSource, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel',
  gemini: 'Gemini',
  'models.dev': 'models.dev',
  'models.dev-cross-provider': 'models.dev (other provider)',
  'models.dev-fuzzy': 'models.dev (fuzzy match)',
  missing: 'missing',
};

/** Sources that are a lead rather than an answer, so the field needs confirming. */
const GUESSED_SOURCES: readonly MetadataSource[] = ['models.dev-cross-provider', 'models.dev-fuzzy'];

export function metadataSourceLabel(source: MetadataSource): string {
  return SOURCE_LABELS[source];
}

export function fieldSourceLabel(draft: ModelMetadataDraft, field: DraftField): string {
  return metadataSourceLabel(draft.sources[field]);
}

/**
 * A field the admin has to look at before saving: the value is missing, only a
 * guessed models.dev match backs it, or the server flagged it (for example a
 * `max_tokens` above `context_window`). A missing optional field is not a
 * reason to block the model, and a guessed name is cosmetic.
 */
export function isDraftFieldUnconfirmed(draft: ModelMetadataDraft, field: DraftField): boolean {
  if (draft.needs_confirmation.includes(field)) {
    return true;
  }
  if (GUESSED_SOURCES.includes(draft.sources[field]) && field !== 'name') {
    return true;
  }
  return !OPTIONAL_FIELDS.includes(field) && draft[field] === null;
}

const CONFIDENCE_NOTES: Record<ModelsDevConfidence, string> = {
  exact: '',
  'cross-provider': ' (other provider - check its price and limits)',
  fuzzy: ' (fuzzy match - check every field)',
};

/** Where a draft's metadata was matched, so "needs confirming" is explainable. */
export function matchLabel(match: ModelsDevMatch | null): string | null {
  if (match === null) {
    return null;
  }
  return `Matched against models.dev ${match.provider} / ${match.model}${CONFIDENCE_NOTES[match.confidence]}`;
}

export function draftNeedsConfirmation(draft: ModelMetadataDraft): boolean {
  return draft.needs_confirmation.length > 0;
}

export function unconfirmedFields(draft: ModelMetadataDraft): readonly DraftField[] {
  return DRAFT_FIELDS.filter((field) => isDraftFieldUnconfirmed(draft, field));
}

/**
 * A draft only becomes a configuration entry when every required field has a
 * value. Nothing is defaulted: a missing limit stays missing and forces the
 * admin through the edit dialog.
 */
export function modelFromDraft(draft: ModelMetadataDraft): ProviderModelConfig | undefined {
  if (
    draft.reasoning === null ||
    draft.input === null ||
    draft.context_window === null ||
    draft.max_tokens === null ||
    draft.cost === null
  ) {
    return undefined;
  }
  return {
    id: draft.id,
    ...(draft.name === null ? {} : { name: draft.name }),
    reasoning: draft.reasoning,
    ...(draft.reasoning && draft.thinking_levels !== null ? { thinking_levels: draft.thinking_levels } : {}),
    input: draft.input,
    context_window: draft.context_window,
    max_tokens: draft.max_tokens,
    cost: draft.cost,
  };
}

// --- thinking levels -------------------------------------------------------

/** What Pi offers a reasoning model that declares no levels. */
const UNDECLARED_REASONING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

/**
 * The levels a configured model accepts, weakest first — the same rule the
 * server validates `agent.thinking_level` with (`src/platform/thinking-levels.ts`).
 */
export function supportedThinkingLevels(model: {
  readonly reasoning: boolean;
  readonly thinking_levels?: readonly ThinkingLevel[];
}): readonly ThinkingLevel[] {
  if (!model.reasoning) {
    return ['off'];
  }
  const declared = model.thinking_levels;
  if (declared === undefined) {
    return UNDECLARED_REASONING_LEVELS;
  }
  return THINKING_LEVELS.filter((level) => declared.includes(level));
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Levels in Pi's order, whatever order they were picked in. */
export function sortThinkingLevels(levels: readonly ThinkingLevel[]): readonly ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => levels.includes(level));
}

/** The agent model's entry in the file view, or `null` if the file lost it. */
export function agentModelConfig(view: {
  readonly agent: { readonly provider: string; readonly model: string };
  readonly providers: readonly ProviderView[];
}): ProviderModelConfig | null {
  const provider = view.providers.find((candidate) => candidate.alias === view.agent.provider);
  return provider?.models.find((model) => model.id === view.agent.model) ?? null;
}

// --- model edit form -------------------------------------------------------

export interface ModelCostForm {
  readonly input: string;
  readonly output: string;
  readonly cache_read: string;
  readonly cache_write: string;
}

export interface ModelFormState {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  /** Declared levels; none checked means "leave it out" and use Pi's default. */
  readonly thinking_levels: readonly ThinkingLevel[];
  readonly input: readonly ModelInput[];
  readonly context_window: string;
  readonly max_tokens: string;
  readonly cost: ModelCostForm;
  /** One entry per compat field of the model's API; `auto` means "leave it out". */
  readonly compat: Readonly<Record<string, string>>;
}

export interface ModelFormErrors {
  id?: string;
  input?: string;
  context_window?: string;
  max_tokens?: string;
  cost?: string;
}

const EMPTY_COST: ModelCostForm = { input: '', output: '', cache_read: '', cache_write: '' };

export function emptyModelForm(api: ProviderApi): ModelFormState {
  return {
    id: '',
    name: '',
    reasoning: false,
    thinking_levels: [],
    input: [],
    context_window: '',
    max_tokens: '',
    cost: EMPTY_COST,
    compat: compatStateFromConfig(api, undefined),
  };
}

export function modelFormFromConfig(model: ProviderModelConfig, api: ProviderApi): ModelFormState {
  return {
    id: model.id,
    name: model.name ?? '',
    reasoning: model.reasoning,
    thinking_levels: model.thinking_levels ?? [],
    input: model.input,
    context_window: String(model.context_window),
    max_tokens: String(model.max_tokens),
    cost: {
      input: String(model.cost.input),
      output: String(model.cost.output),
      cache_read: String(model.cost.cache_read),
      cache_write: String(model.cost.cache_write),
    },
    compat: compatStateFromConfig(api, model.compat),
  };
}

export function modelFormFromDraft(draft: ModelMetadataDraft, api: ProviderApi): ModelFormState {
  const cost = draft.cost;
  return {
    id: draft.id,
    name: draft.name ?? '',
    reasoning: draft.reasoning ?? false,
    thinking_levels: draft.thinking_levels ?? [],
    input: draft.input ?? [],
    context_window: draft.context_window === null ? '' : String(draft.context_window),
    max_tokens: draft.max_tokens === null ? '' : String(draft.max_tokens),
    cost:
      cost === null
        ? EMPTY_COST
        : {
            input: String(cost.input),
            output: String(cost.output),
            cache_read: String(cost.cache_read),
            cache_write: String(cost.cache_write),
          },
    // Only the field Pi's detection cannot know is prefilled; everything else
    // stays automatic so a Pi upgrade can still improve it.
    compat: compatStateFromConfig(
      api,
      draft.requires_reasoning_content ? { requires_reasoning_content: true } : undefined,
    ),
  };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function validateModelForm(form: ModelFormState): ModelFormErrors {
  const errors: ModelFormErrors = {};
  if (form.id.trim().length === 0) {
    errors.id = 'id is required';
  }
  if (form.input.length === 0) {
    errors.input = 'select at least one input modality';
  }
  const contextWindow = parsePositiveInteger(form.context_window);
  if (contextWindow === null) {
    errors.context_window = 'a positive integer is required';
  }
  const maxTokens = parsePositiveInteger(form.max_tokens);
  if (maxTokens === null) {
    errors.max_tokens = 'a positive integer is required';
  } else if (contextWindow !== null && maxTokens > contextWindow) {
    errors.max_tokens = 'max output cannot exceed the context window';
  }
  const costs = [form.cost.input, form.cost.output, form.cost.cache_read, form.cost.cache_write];
  if (costs.some((value) => parseNonNegativeNumber(value) === null)) {
    errors.cost = 'all four prices are required (0 is allowed)';
  }
  return errors;
}

export function modelFormToConfig(form: ModelFormState, api: ProviderApi): ProviderModelConfig {
  const cost: ModelCostConfig = {
    input: parseNonNegativeNumber(form.cost.input) ?? 0,
    output: parseNonNegativeNumber(form.cost.output) ?? 0,
    cache_read: parseNonNegativeNumber(form.cost.cache_read) ?? 0,
    cache_write: parseNonNegativeNumber(form.cost.cache_write) ?? 0,
  };
  const compat = compatConfigFromState(api, form.compat);
  // Levels only exist on a reasoning model; unchecking reasoning drops them.
  const thinkingLevels = form.reasoning ? sortThinkingLevels(form.thinking_levels) : [];
  return {
    id: form.id.trim(),
    ...(form.name.trim().length === 0 ? {} : { name: form.name.trim() }),
    reasoning: form.reasoning,
    ...(thinkingLevels.length === 0 ? {} : { thinking_levels: thinkingLevels }),
    ...(compat === undefined ? {} : { compat }),
    input: form.input,
    context_window: parsePositiveInteger(form.context_window) ?? 0,
    max_tokens: parsePositiveInteger(form.max_tokens) ?? 0,
    cost,
  };
}

// --- compat tri-state ------------------------------------------------------

export const AUTO_COMPAT = 'auto';

export interface CompatOption {
  readonly value: string;
  readonly label: string;
}

export interface CompatFieldSpec {
  readonly field: keyof ModelCompatConfig;
  /** `boolean` fields are on/off; `enum` fields offer their concrete values. */
  readonly kind: 'boolean' | 'enum';
  readonly options: readonly CompatOption[];
}

const BOOLEAN_OPTIONS: readonly CompatOption[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/**
 * Which compat overrides each API honours. `anthropic-messages` and
 * `google-generative-ai` have none, so their models hide the advanced section
 * entirely — the server rejects a field the adapter does not read.
 */
const COMPAT_FIELDS_BY_API: Record<ProviderApi, readonly CompatFieldSpec[]> = {
  'openai-completions': [
    { field: 'supports_developer_role', kind: 'boolean', options: BOOLEAN_OPTIONS },
    {
      field: 'thinking_format',
      kind: 'enum',
      options: [
        { value: 'openai', label: 'openai' },
        { value: 'openrouter', label: 'openrouter' },
        { value: 'deepseek', label: 'deepseek' },
        { value: 'together', label: 'together' },
        { value: 'zai', label: 'zai' },
        { value: 'qwen', label: 'qwen' },
        { value: 'string-thinking', label: 'string-thinking' },
      ],
    },
    {
      field: 'max_tokens_field',
      kind: 'enum',
      options: [
        { value: 'max_completion_tokens', label: 'max_completion_tokens' },
        { value: 'max_tokens', label: 'max_tokens' },
      ],
    },
    { field: 'requires_reasoning_content', kind: 'boolean', options: BOOLEAN_OPTIONS },
    { field: 'cache_control_format', kind: 'enum', options: [{ value: 'anthropic', label: 'anthropic' }] },
  ],
  'openai-responses': [{ field: 'supports_developer_role', kind: 'boolean', options: BOOLEAN_OPTIONS }],
  'anthropic-messages': [],
  'google-generative-ai': [],
};

export function compatFieldsForApi(api: ProviderApi): readonly CompatFieldSpec[] {
  return COMPAT_FIELDS_BY_API[api];
}

export function compatStateFromConfig(
  api: ProviderApi,
  compat: ModelCompatConfig | undefined,
): Readonly<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const spec of compatFieldsForApi(api)) {
    const value = compat?.[spec.field];
    if (typeof value === 'boolean') {
      state[spec.field] = value ? 'on' : 'off';
    } else if (typeof value === 'string') {
      state[spec.field] = value;
    } else {
      state[spec.field] = AUTO_COMPAT;
    }
  }
  return state;
}

export function compatConfigFromState(
  api: ProviderApi,
  state: Readonly<Record<string, string>>,
): ModelCompatConfig | undefined {
  const compat: Record<string, unknown> = {};
  for (const spec of compatFieldsForApi(api)) {
    const value = state[spec.field] ?? AUTO_COMPAT;
    if (value === AUTO_COMPAT) {
      continue;
    }
    compat[spec.field] = spec.kind === 'boolean' ? value === 'on' : value;
  }
  return Object.keys(compat).length === 0 ? undefined : (compat as ModelCompatConfig);
}

// --- in-use lookups --------------------------------------------------------

export type ModelUsage = 'agent' | 'vision' | 'both' | null;

export function modelUsage(
  view: { readonly agent: { provider: string; model: string }; readonly vision: { provider: string; model: string } },
  alias: string,
  modelId: string,
): ModelUsage {
  const agent = view.agent.provider === alias && view.agent.model === modelId;
  const vision = view.vision.provider === alias && view.vision.model === modelId;
  if (agent && vision) {
    return 'both';
  }
  if (agent) {
    return 'agent';
  }
  if (vision) {
    return 'vision';
  }
  return null;
}

export function providerUsage(
  view: { readonly agent: { provider: string }; readonly vision: { provider: string } },
  alias: string,
): { readonly agent: boolean; readonly vision: boolean } {
  return { agent: view.agent.provider === alias, vision: view.vision.provider === alias };
}

// --- write feedback --------------------------------------------------------

export const CONFIG_CONFLICT_CODE = 'config_conflict';

/**
 * Save feedback must never present a pending restart as applied: whenever a
 * restart path is waiting, the message says so even if other paths went live.
 */
export function applyFeedback(apply: ModelApplySummary): { readonly title: string; readonly description: string } {
  const applied = apply.applied.join(', ');
  const restart = apply.restart_required.join(', ');
  if (apply.restart_required.length > 0) {
    return {
      title: 'Saved, restart required',
      description:
        applied.length === 0
          ? `Waiting for a restart: ${restart}`
          : `Applied: ${applied}. Waiting for a restart: ${restart}`,
    };
  }
  if (apply.applied.length > 0) {
    return { title: 'Applied', description: `Applied: ${applied}` };
  }
  return { title: 'Saved', description: 'config.jsonc was updated; no field needed a hot apply' };
}

export function isConfigConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONFIG_CONFLICT_CODE;
}

/** Error text for the page and its dialogs; conflicts get a readable message. */
export function writeErrorMessage(error: unknown): string {
  if (isConfigConflict(error)) {
    return 'config.jsonc changed while you were editing. It has been read again - try once more.';
  }
  return errorMessage(error);
}

/** Local validation errors are shown as-is; API failures get the message above. */
export function requestErrorMessage(error: unknown): string {
  return error instanceof ApiError ? writeErrorMessage(error) : errorMessage(error);
}

// --- misc ------------------------------------------------------------------

/** Provider search matches the alias, Pi's provider id, the API and the address. */
export function providerMatchesSearch(provider: ProviderView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [provider.alias, provider.provider ?? '', provider.api, provider.base_url, provider.kind].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function modelMatchesSearch(
  model: { readonly id: string; readonly name?: string | null | undefined },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [model.id, model.name ?? ''].some((value) => value.toLowerCase().includes(needle));
}

/** Ids typed by hand: one per line or comma separated, deduplicated. */
export function parseModelIds(text: string): readonly string[] {
  const ids = text
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(ids)];
}

export function isTextCapable(model: ProviderModelConfig): boolean {
  return model.input.includes('text');
}

export function isImageCapable(model: ProviderModelConfig): boolean {
  return model.input.includes('image');
}

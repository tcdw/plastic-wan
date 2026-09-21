import { useState } from 'react';
import { LazyDetails } from '@/components/business';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type DraftField,
  type ModelInput,
  type ModelMetadataDraft,
  type ProviderApi,
  type ProviderModelConfig,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@/lib/api.ts';
import {
  AUTO_COMPAT,
  compatFieldsForApi,
  fieldSourceLabel,
  isDraftFieldUnconfirmed,
  type ModelFormState,
  matchLabel,
  modelFormToConfig,
  TOOL_SCHEMA_KEYWORDS_OPTIONS,
  unconfirmedFields,
  validateModelForm,
} from '@/lib/model-manager.ts';

const INPUT_MODALITIES: readonly ModelInput[] = ['text', 'image'];
const COST_FIELDS = ['input', 'output', 'cache_read', 'cache_write'] as const;

/**
 * One field label with its provenance: the metadata source the value came from,
 * and a marker when the admin still has to confirm it.
 */
function FieldLabel({
  htmlFor,
  label,
  draft,
  field,
}: {
  readonly htmlFor: string;
  readonly label: string;
  readonly draft: ModelMetadataDraft | null;
  readonly field: DraftField;
}): React.ReactElement {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {draft === null ? null : (
        <>
          <span className="text-muted-foreground text-xs">{fieldSourceLabel(draft, field)}</span>
          {isDraftFieldUnconfirmed(draft, field) ? (
            <span className="text-warning text-xs font-medium">confirm</span>
          ) : null}
        </>
      )}
    </span>
  );
}

export interface ModelEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly api: ProviderApi;
  readonly title: string;
  readonly description: string;
  readonly initial: ModelFormState;
  /** A model already in the file keeps its id: changing it is delete + add. */
  readonly lockId: boolean;
  readonly draft: ModelMetadataDraft | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (model: ProviderModelConfig) => void;
}

export function ModelEditDialog({
  open,
  onOpenChange,
  api,
  title,
  description,
  initial,
  lockId,
  draft,
  pending,
  error,
  onSubmit,
}: ModelEditDialogProps): React.ReactElement {
  // The form is initialized once, at mount: every caller renders this dialog
  // only while it has a target and remounts it (a fresh `key`) for the next one,
  // so there is no state to sync after the first render.
  const [form, setForm] = useState<ModelFormState>(initial);
  const [touched, setTouched] = useState(false);

  const errors = validateModelForm(form);
  const errorCount = Object.keys(errors).length;
  const compatFields = compatFieldsForApi(api);
  const showAdvanced = compatFields.length > 0;
  const confirmations = draft === null ? [] : unconfirmedFields(draft);
  const matchNote = draft === null ? null : matchLabel(draft.match);

  const toggleThinkingLevel = (level: ThinkingLevel): void => {
    setForm((previous) => ({
      ...previous,
      thinking_levels: previous.thinking_levels.includes(level)
        ? previous.thinking_levels.filter((value) => value !== level)
        : [...previous.thinking_levels, level],
    }));
  };

  const toggleInput = (modality: ModelInput): void => {
    setForm((previous) => ({
      ...previous,
      input: previous.input.includes(modality)
        ? previous.input.filter((value) => value !== modality)
        : [...previous.input, modality],
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {confirmations.length > 0 ? (
            <p className="text-warning text-xs">
              Confirm or fill in: {confirmations.join(', ')}. The panel fills in no defaults.
            </p>
          ) : null}
          {/* Naming the match makes "confirm" actionable: a cross-provider or
              normalized hit is a lead from another deployment, not an answer. */}
          {matchNote === null ? null : <p className="text-muted-foreground text-xs">{matchNote}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <FieldLabel htmlFor="model-id" label="id" draft={null} field="name" />
              <Input
                id="model-id"
                value={form.id}
                disabled={lockId}
                onChange={(event) => setForm((previous) => ({ ...previous, id: event.target.value }))}
              />
              {touched && errors.id !== undefined ? <p className="text-destructive text-sm">{errors.id}</p> : null}
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="model-name" label="name" draft={draft} field="name" />
              <Input
                id="model-name"
                value={form.name}
                onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="model-context" label="context_window" draft={draft} field="context_window" />
              <Input
                id="model-context"
                type="number"
                min={1}
                step={1}
                value={form.context_window}
                onChange={(event) => setForm((previous) => ({ ...previous, context_window: event.target.value }))}
              />
              {touched && errors.context_window !== undefined ? (
                <p className="text-destructive text-sm">{errors.context_window}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <FieldLabel htmlFor="model-max-tokens" label="max_tokens" draft={draft} field="max_tokens" />
              <Input
                id="model-max-tokens"
                type="number"
                min={1}
                step={1}
                value={form.max_tokens}
                onChange={(event) => setForm((previous) => ({ ...previous, max_tokens: event.target.value }))}
              />
              {touched && errors.max_tokens !== undefined ? (
                <p className="text-destructive text-sm">{errors.max_tokens}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="model-input-text" label="input" draft={draft} field="input" />
            <div className="flex flex-wrap items-center gap-4">
              {INPUT_MODALITIES.map((modality) => (
                <label key={modality} className="flex items-center gap-2 text-sm" htmlFor={`model-input-${modality}`}>
                  <input
                    id={`model-input-${modality}`}
                    type="checkbox"
                    className="size-4 rounded border-input"
                    checked={form.input.includes(modality)}
                    onChange={() => toggleInput(modality)}
                  />
                  {modality}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm" htmlFor="model-reasoning">
                <input
                  id="model-reasoning"
                  type="checkbox"
                  className="size-4 rounded border-input"
                  checked={form.reasoning}
                  onChange={(event) => setForm((previous) => ({ ...previous, reasoning: event.target.checked }))}
                />
                reasoning
              </label>
              {draft === null ? null : (
                <span className="text-muted-foreground text-xs">{fieldSourceLabel(draft, 'reasoning')}</span>
              )}
            </div>
            {touched && errors.input !== undefined ? <p className="text-destructive text-sm">{errors.input}</p> : null}
          </div>

          {/* Levels only exist on a reasoning model; saving without reasoning
              drops them, so the row goes away with the checkbox. */}
          {form.reasoning ? (
            <div className="space-y-2">
              <FieldLabel htmlFor="model-thinking-off" label="thinking levels" draft={draft} field="thinking_levels" />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {THINKING_LEVELS.map((level) => (
                  <label key={level} className="flex items-center gap-2 text-sm" htmlFor={`model-thinking-${level}`}>
                    <input
                      id={`model-thinking-${level}`}
                      type="checkbox"
                      className="size-4 rounded border-input"
                      checked={form.thinking_levels.includes(level)}
                      onChange={() => toggleThinkingLevel(level)}
                    />
                    {level}
                  </label>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                The levels this model accepts. Leave all unchecked to use Pi's default: off, minimal, low, medium, high.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="model-tool-schema" className="font-mono text-xs">
              tool_schema_keywords
            </Label>
            <Select
              value={form.tool_schema_keywords}
              onValueChange={(value) => setForm((previous) => ({ ...previous, tool_schema_keywords: value }))}
            >
              <SelectTrigger id="model-tool-schema" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOOL_SCHEMA_KEYWORDS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Which JSON Schema keywords this model's tool definitions may carry. Automatic sends every keyword the
              runtime builds; minimal drops the validation-only ones that grammar-constrained endpoints reject with
              "unsupported schema keyword".
            </p>
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="model-cost-input" label="cost (USD per 1M tokens)" draft={draft} field="cost" />
            <div className="grid gap-2 sm:grid-cols-4">
              {COST_FIELDS.map((field) => (
                <div key={field} className="space-y-1">
                  <Label htmlFor={`model-cost-${field}`} className="text-muted-foreground text-xs">
                    {field}
                  </Label>
                  <Input
                    id={`model-cost-${field}`}
                    type="number"
                    min={0}
                    step="any"
                    value={form.cost[field]}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        cost: { ...previous.cost, [field]: event.target.value },
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            {touched && errors.cost !== undefined ? <p className="text-destructive text-sm">{errors.cost}</p> : null}
          </div>

          {showAdvanced ? (
            <LazyDetails summary="Advanced" className="text-sm">
              <div className="space-y-3 pt-3">
                <p className="text-muted-foreground text-xs">
                  Auto leaves the field out of the configuration and lets Pi detect it from the address and the
                  provider. Only the fields {api} honours are listed here.
                </p>
                {compatFields.map((spec) => (
                  <div key={spec.field} className="space-y-1">
                    <Label htmlFor={`compat-${spec.field}`} className="font-mono text-xs">
                      {spec.field}
                    </Label>
                    <Select
                      value={form.compat[spec.field] ?? AUTO_COMPAT}
                      onValueChange={(value) =>
                        setForm((previous) => ({ ...previous, compat: { ...previous.compat, [spec.field]: value } }))
                      }
                    >
                      <SelectTrigger id={`compat-${spec.field}`} className="w-full sm:w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO_COMPAT}>Auto</SelectItem>
                        {spec.options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </LazyDetails>
          ) : null}

          {error !== null ? <p className="text-destructive text-sm break-words">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => {
              setTouched(true);
              if (errorCount > 0) {
                return;
              }
              onSubmit(modelFormToConfig(form, api));
            }}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import type { DraftField, ModelInput, ModelMetadataDraft, ProviderApi, ProviderModelConfig } from '@/lib/api.ts';
import {
  AUTO_COMPAT,
  compatFieldsForApi,
  fieldSourceLabel,
  isDraftFieldUnconfirmed,
  matchLabel,
  modelFormToConfig,
  type ModelFormState,
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
            <span className="text-warning text-xs font-medium">需确认</span>
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
              需确认的字段：{confirmations.join(', ')}。确认或填写后才能保存，面板不会替你填默认值。
            </p>
          ) : null}
          {/* Naming the match makes "需确认" actionable: a cross-provider or
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
            <LazyDetails summary="高级设置" className="text-sm">
              <div className="space-y-3 pt-3">
                <p className="text-muted-foreground text-xs">
                  「自动」表示不写入这个字段，由 Pi 按地址和 provider 自行判断。只有 {api} 支持的字段会出现在这里。
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
                        <SelectItem value={AUTO_COMPAT}>自动</SelectItem>
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

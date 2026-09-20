import { Pencil } from 'lucide-react';
import { MonoValue, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DiscoveredModel, ProviderModelConfig } from '@/lib/api.ts';
import { formatNumber } from '@/lib/format.ts';
import { draftNeedsConfirmation, fieldSourceLabel, unconfirmedFields } from '@/lib/model-manager.ts';

/**
 * The discovered / looked-up model list: checkboxes, the metadata preview with
 * its per-field source, and the marker for drafts the admin still has to confirm.
 */
export function ModelDraftList({
  drafts,
  selected,
  resolved,
  onToggle,
  onEdit,
  search,
  onSearchChange,
  emptyText,
}: {
  readonly drafts: readonly DiscoveredModel[];
  readonly selected: ReadonlySet<string>;
  readonly resolved: Readonly<Record<string, ProviderModelConfig>>;
  readonly onToggle: (id: string) => void;
  readonly onEdit: (draft: DiscoveredModel) => void;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly emptyText: string;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <Input
        aria-label="Search models"
        placeholder="Search models"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {drafts.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">{emptyText}</p>
      ) : (
        <ul className="divide-border max-h-80 divide-y overflow-y-auto rounded-md border">
          {drafts.map((draft) => {
            const confirmed = resolved[draft.id] !== undefined;
            const needsConfirmation = draftNeedsConfirmation(draft) && !confirmed;
            return (
              <li key={draft.id} className="flex items-start gap-3 p-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 rounded border-input"
                  aria-label={`Select ${draft.id}`}
                  checked={selected.has(draft.id)}
                  disabled={draft.configured}
                  onChange={() => onToggle(draft.id)}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <MonoValue value={draft.id} />
                    {draft.configured ? <ToneBadge tone="neutral">已配置</ToneBadge> : null}
                    {confirmed ? <ToneBadge tone="success">已确认</ToneBadge> : null}
                    {needsConfirmation ? (
                      <ToneBadge tone="warning">需确认：{unconfirmedFields(draft).join(', ')}</ToneBadge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">{draft.name ?? '—'}</p>
                  <p className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                    <span>
                      context {draft.context_window === null ? '—' : formatNumber(draft.context_window)}
                      <span className="ml-1">({fieldSourceLabel(draft, 'context_window')})</span>
                    </span>
                    <span>
                      max output {draft.max_tokens === null ? '—' : formatNumber(draft.max_tokens)}
                      <span className="ml-1">({fieldSourceLabel(draft, 'max_tokens')})</span>
                    </span>
                    <span>
                      input {draft.input === null ? '—' : draft.input.join('+')}
                      <span className="ml-1">({fieldSourceLabel(draft, 'input')})</span>
                    </span>
                    <span>
                      reasoning {draft.reasoning === null ? '—' : draft.reasoning ? 'yes' : 'no'}
                      <span className="ml-1">({fieldSourceLabel(draft, 'reasoning')})</span>
                    </span>
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => onEdit(draft)}>
                  <Pencil className="size-3" />
                  编辑
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

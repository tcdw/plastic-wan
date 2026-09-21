import { Pencil } from 'lucide-react';
import { MonoValue, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DiscoveredModel, ProviderModelConfig } from '@/lib/api.ts';
import { formatNumber } from '@/lib/format.ts';
import { draftNeedsConfirmation, matchLabel, unconfirmedFields } from '@/lib/model-manager.ts';

/**
 * One drafted value; a field nobody could fill reads `—`. The label stays
 * neutral: on a draft that needs confirming every field usually does, so tinting
 * them would colour the whole line and mark nothing. The badge carries the
 * count, and the edit dialog names the fields.
 */
function Metric({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.ReactElement {
  return (
    <span className="whitespace-nowrap">
      {label} <span className="text-foreground/80">{value}</span>
    </span>
  );
}

/**
 * The discovered / looked-up model list: checkboxes, a one-line metadata preview
 * with the match it came from, and the marker for drafts the admin still has to
 * confirm. Per-field provenance belongs to the edit dialog, which is where a
 * value is actually accepted.
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
                  className="mt-1.5 size-4 shrink-0 rounded border-input"
                  aria-label={`Select ${draft.id}`}
                  checked={selected.has(draft.id)}
                  disabled={draft.configured}
                  onChange={() => onToggle(draft.id)}
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <MonoValue value={draft.id} />
                    {draft.name === null ? null : (
                      <span className="text-muted-foreground truncate text-xs">{draft.name}</span>
                    )}
                    {draft.configured ? <ToneBadge tone="neutral">已配置</ToneBadge> : null}
                    {confirmed ? <ToneBadge tone="success">已确认</ToneBadge> : null}
                    {needsConfirmation ? (
                      <ToneBadge tone="warning">需确认 {unconfirmedFields(draft).length} 项</ToneBadge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    <Metric
                      label="context"
                      value={draft.context_window === null ? '—' : formatNumber(draft.context_window)}
                    />
                    <Metric
                      label="max output"
                      value={draft.max_tokens === null ? '—' : formatNumber(draft.max_tokens)}
                    />
                    <Metric label="input" value={draft.input === null ? '—' : draft.input.join('+')} />
                    <Metric label="reasoning" value={draft.reasoning === null ? '—' : draft.reasoning ? 'yes' : 'no'} />
                  </p>
                  {/* Where the row came from, once — instead of repeating the
                      same source after every value. */}
                  {matchLabel(draft.match) === null ? null : (
                    <p className="text-muted-foreground truncate text-xs opacity-60">{matchLabel(draft.match)}</p>
                  )}
                </div>
                <Button type="button" variant="ghost" size="xs" onClick={() => onEdit(draft)}>
                  <Pencil />
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

import { useMemo, useState } from 'react';
import type { DiscoveredModel, ProviderModelConfig } from '@/lib/api.ts';
import { draftNeedsConfirmation, modelFromDraft, modelMatchesSearch } from '@/lib/model-manager.ts';

/**
 * Selection state shared by the discovery dialog and the new-provider wizard:
 * which drafts are checked, which of them the admin already confirmed through
 * the edit dialog, and whether the selection can be submitted as it stands.
 */
export interface DraftSelection {
  readonly drafts: readonly DiscoveredModel[];
  readonly selected: ReadonlySet<string>;
  readonly resolved: Readonly<Record<string, ProviderModelConfig>>;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly replaceDrafts: (drafts: readonly DiscoveredModel[]) => void;
  readonly toggle: (id: string) => void;
  readonly resolve: (id: string, model: ProviderModelConfig) => void;
  readonly reset: () => void;
  readonly visibleDrafts: readonly DiscoveredModel[];
  readonly selectedCount: number;
  /** Selected drafts that still need a filled or confirmed field. */
  readonly unresolved: readonly DiscoveredModel[];
  /** The models to submit, or `null` while the selection is not submittable. */
  readonly models: readonly ProviderModelConfig[] | null;
}

export function useDraftSelection(): DraftSelection {
  const [drafts, setDrafts] = useState<readonly DiscoveredModel[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [resolved, setResolved] = useState<Readonly<Record<string, ProviderModelConfig>>>({});
  const [search, setSearch] = useState('');

  const visibleDrafts = useMemo(() => drafts.filter((draft) => modelMatchesSearch(draft, search)), [drafts, search]);

  const chosen = useMemo(() => drafts.filter((draft) => selected.has(draft.id)), [drafts, selected]);
  const unresolved = chosen.filter((draft) => resolved[draft.id] === undefined && draftNeedsConfirmation(draft));

  const models = useMemo(() => {
    if (chosen.length === 0 || unresolved.length > 0) {
      return null;
    }
    const built: ProviderModelConfig[] = [];
    for (const draft of chosen) {
      const confirmed = resolved[draft.id] ?? modelFromDraft(draft);
      if (confirmed === undefined) {
        return null;
      }
      built.push(confirmed);
    }
    return built;
  }, [chosen, resolved, unresolved]);

  return {
    drafts,
    selected,
    resolved,
    search,
    setSearch,
    replaceDrafts: (next) => {
      setDrafts(next);
      setSelected(new Set());
      setResolved({});
    },
    toggle: (id) => {
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    resolve: (id, model) => {
      setResolved((previous) => ({ ...previous, [id]: model }));
      setSelected((previous) => new Set(previous).add(id));
    },
    reset: () => {
      setDrafts([]);
      setSelected(new Set());
      setResolved({});
      setSearch('');
    },
    visibleDrafts,
    selectedCount: chosen.length,
    unresolved,
    models,
  };
}

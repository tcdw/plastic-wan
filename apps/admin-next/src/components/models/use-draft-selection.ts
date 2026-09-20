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
  /** Accepts the drafted values of every selected draft that has no empty field. */
  readonly confirmSelected: () => void;
  readonly reset: () => void;
  readonly visibleDrafts: readonly DiscoveredModel[];
  readonly selectedCount: number;
  /** Selected drafts that still need a filled or confirmed field. */
  readonly unresolved: readonly DiscoveredModel[];
  /** How many of those `confirmSelected` can take as they are. */
  readonly confirmable: number;
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
  // A draft whose fields are all filled but only backed by a guessed match is
  // exactly what the list already shows: values, and where each came from.
  // Accepting those in one go is a decision, not a bypass — a draft with an
  // empty field is not convertible and still has to go through the dialog.
  const confirmable = unresolved.filter((draft) => modelFromDraft(draft) !== undefined);

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
    confirmSelected: () => {
      setResolved((previous) => {
        const next = { ...previous };
        for (const draft of confirmable) {
          const model = modelFromDraft(draft);
          if (model !== undefined) {
            next[draft.id] = model;
          }
        }
        return next;
      });
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
    confirmable: confirmable.length,
    models,
  };
}

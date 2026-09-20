import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ModelApplySummary } from './api.ts';
import { applyFeedback, isConfigConflict } from './model-manager.ts';
import { providersQuery } from './queries.ts';

export interface ProviderWriteFeedback {
  /** Re-reads `GET /providers`; every write changes what that view shows. */
  readonly refresh: () => void;
  /** Reports what actually happened: applied, or saved but waiting for a restart. */
  readonly succeeded: (apply: ModelApplySummary) => void;
  /**
   * Keeps the caller's inline error as the primary message, but refreshes the
   * view when the file changed under us — the stale revision is exactly what the
   * next attempt has to be built from.
   */
  readonly failed: (error: unknown) => void;
}

export function useProviderWrite(): ProviderWriteFeedback {
  const queryClient = useQueryClient();
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
  };
  return {
    refresh,
    succeeded: (apply) => {
      const feedback = applyFeedback(apply);
      toast.success(feedback.title, { description: feedback.description });
      refresh();
    },
    failed: (error) => {
      if (isConfigConflict(error)) {
        refresh();
      }
    },
  };
}

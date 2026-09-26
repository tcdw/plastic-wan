import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ModelApplySummary } from './api.ts';
import { applyFeedback } from './model-manager.ts';
import { chatsQuery, configStatusQuery, providersQuery } from './queries.ts';

export interface ProviderWriteFeedback {
  /** Config-backed views share one revision and must be invalidated together. */
  readonly refresh: () => void;
  /**
   * Reports what actually happened: applied, or saved but waiting for a restart.
   * `note` adds what the write changed on its own, such as a reset level.
   */
  readonly succeeded: (apply: ModelApplySummary, note?: string) => void;
  /** Refresh even on errors: a failed apply may already have written the file. */
  readonly failed: (error: unknown) => void;
}

export function useProviderWrite(): ProviderWriteFeedback {
  const queryClient = useQueryClient();
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey });
    void queryClient.invalidateQueries({ queryKey: configStatusQuery.queryKey });
  };
  return {
    refresh,
    succeeded: (apply, note) => {
      const feedback = applyFeedback(apply);
      toast.success(feedback.title, {
        description: note === undefined ? feedback.description : `${feedback.description}. ${note}`,
      });
      refresh();
    },
    failed: refresh,
  };
}

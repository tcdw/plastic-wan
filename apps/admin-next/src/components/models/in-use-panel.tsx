import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type ProvidersView, setAgentThinkingLevel, type ThinkingLevel } from '@/lib/api.ts';
import { agentModelConfig, isThinkingLevel, supportedThinkingLevels, writeErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

/**
 * What the bot runs on right now, whichever provider the page has selected:
 * the agent model with the thinking effort every invocation uses, and the
 * vision model. Only the effort is edited here; the models are switched from
 * their rows.
 */
export function InUsePanel({
  view,
  revision,
}: {
  readonly view: ProvidersView;
  readonly revision: string;
}): React.ReactElement {
  const write = useProviderWrite();
  const agentModel = agentModelConfig(view);
  // The file always names a configured agent model; if it was edited away under
  // us, the current level is the only one this page can vouch for.
  const levels = agentModel === null ? [view.agent.thinking_level] : supportedThinkingLevels(agentModel);

  const setLevel = useMutation({
    mutationFn: (level: ThinkingLevel) => setAgentThinkingLevel(level, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

  return (
    <Panel title="In use">
      <KvList
        items={[
          { label: 'Agent model', value: <MonoValue value={`${view.agent.provider} / ${view.agent.model}`} /> },
          {
            label: 'Thinking effort',
            value: (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Select
                  value={view.agent.thinking_level}
                  disabled={setLevel.isPending || levels.length < 2}
                  onValueChange={(value) => {
                    if (isThinkingLevel(value) && value !== view.agent.thinking_level) {
                      setLevel.mutate(value);
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-32" aria-label="Thinking effort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">Resets to the weakest level on a model switch</span>
              </span>
            ),
          },
          { label: 'Vision model', value: <MonoValue value={`${view.vision.provider} / ${view.vision.model}`} /> },
        ]}
      />
    </Panel>
  );
}

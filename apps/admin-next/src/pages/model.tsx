import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { KvList, MonoValue } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type ModelOption, switchAgentModel } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { modelQuery } from '@/lib/queries';

function optionKey(option: ModelOption): string {
  return `${option.provider}/${option.model}`;
}

export default function ModelPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const model = useQuery(modelQuery);

  const apply = useMutation({
    mutationFn: (option: ModelOption) => switchAgentModel({ provider: option.provider, model: option.model }),
    onSuccess: () => {
      setSelectedKey(null);
      toast.success('Model switched — applies to subsequent invocations');
      void queryClient.invalidateQueries({ queryKey: ['model'] });
      void queryClient.invalidateQueries({ queryKey: ['config-status'] });
    },
    onError: () => {
      // Selection is kept so the user sees the failing target next to the
      // inline error message.
    },
  });

  if (model.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (model.isError || model.data === undefined) {
    return (
      <div className="p-6 text-center">
        <p className="text-destructive font-medium">Failed to load model state</p>
        <p className="text-muted-foreground text-sm break-words">{errorMessage(model.error)}</p>
      </div>
    );
  }

  const state = model.data;
  const current = state.current;
  const selectedOption = state.options.find((option) => optionKey(option) === selectedKey) ?? null;

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>Switch the agent model</AlertTitle>
        <AlertDescription>
          Switching writes <MonoValue value="agent.provider" /> and <MonoValue value="agent.model" /> into config.jsonc
          and applies the file to the running process, so subsequent invocations use the new model while a running
          session keeps its own. The change survives a restart. Only models that accept text input can be selected.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Current model</CardTitle>
        </CardHeader>
        <CardContent>
          <KvList
            items={[
              { label: 'Provider', value: <MonoValue value={current.provider} /> },
              { label: 'Model', value: <MonoValue value={current.model} /> },
              { label: 'Name', value: current.name },
              { label: 'Context window', value: `${current.context_window.toLocaleString()} tokens` },
              { label: 'Max output', value: `${current.max_tokens.toLocaleString()} tokens` },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Switch model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              {...(selectedKey === null ? {} : { value: selectedKey })}
              onValueChange={(value) => {
                setSelectedKey(value);
                apply.reset();
              }}
            >
              <SelectTrigger className="min-w-64" aria-label="Provider and model">
                <SelectValue placeholder="Select provider and model" />
              </SelectTrigger>
              <SelectContent>
                {state.options.map((option) => (
                  <SelectItem key={optionKey(option)} value={optionKey(option)}>
                    {option.provider} / {option.model} ({option.name})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              disabled={selectedOption === null || apply.isPending}
              onClick={() => {
                if (selectedOption !== null) {
                  apply.mutate(selectedOption);
                }
              }}
            >
              {apply.isPending ? 'Switching…' : 'Switch'}
            </Button>
          </div>
          {state.options.length === 0 ? (
            <p className="text-muted-foreground text-sm">No switchable text-capable models are configured.</p>
          ) : null}
          {apply.isError ? <p className="text-destructive text-sm break-words">{errorMessage(apply.error)}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

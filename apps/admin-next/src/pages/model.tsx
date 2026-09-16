import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { KvList, MonoValue, ToneBadge } from '@/components/business';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { type ModelOption, resetAgentModel, switchAgentModel } from '@/lib/api';
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
    },
    onError: () => {
      // Selection is kept so the user sees the failing target next to the
      // inline error message.
    },
  });

  const reset = useMutation({
    mutationFn: resetAgentModel,
    onSuccess: () => {
      setSelectedKey(null);
      toast.success('Restored the config default model');
      void queryClient.invalidateQueries({ queryKey: ['model'] });
    },
    onError: () => {
      // Keep the state as-is and show the inline error.
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
  const defaultModel = state.default;
  const selectedOption = state.options.find((option) => optionKey(option) === selectedKey) ?? null;
  const switched = current.provider !== defaultModel.provider || current.model !== defaultModel.model;
  const busy = apply.isPending || reset.isPending;

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="text-foreground" />
        <AlertTitle>Hot-switch the agent model</AlertTitle>
        <AlertDescription>
          Switching only affects subsequent invocations; a running session keeps its model and a restart returns to the
          config default. Only models that accept text input can be selected as the agent model.
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
              {
                label: 'Source',
                value: switched ? (
                  <ToneBadge tone="warning">runtime switch</ToneBadge>
                ) : (
                  <ToneBadge tone="success">config default</ToneBadge>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Switch model</CardTitle>
          <CardDescription>
            Default: {defaultModel.provider} / {defaultModel.model}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              {...(selectedKey === null ? {} : { value: selectedKey })}
              onValueChange={(value) => {
                setSelectedKey(value);
                apply.reset();
                reset.reset();
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
              disabled={selectedOption === null || busy}
              onClick={() => {
                if (selectedOption !== null) {
                  apply.mutate(selectedOption);
                }
              }}
            >
              {apply.isPending ? 'Switching…' : 'Switch'}
            </Button>
            <Button type="button" variant="outline" disabled={!switched || busy} onClick={() => reset.mutate()}>
              {reset.isPending ? 'Restoring…' : 'Restore default'}
            </Button>
          </div>
          {state.options.length === 0 ? (
            <p className="text-muted-foreground text-sm">No switchable text-capable models are configured.</p>
          ) : null}
          {apply.isError ? <p className="text-destructive text-sm break-words">{errorMessage(apply.error)}</p> : null}
          {reset.isError ? <p className="text-destructive text-sm break-words">{errorMessage(reset.error)}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

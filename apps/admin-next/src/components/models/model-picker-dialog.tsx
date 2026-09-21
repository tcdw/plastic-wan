import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { MonoValue } from '@/components/business';
import { HeaderFields, headerRowsFromNames, headerValues, type HeaderRow } from '@/components/models/header-fields';
import { ModelDraftList } from '@/components/models/model-draft-list';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { useDraftSelection } from '@/components/models/use-draft-selection';
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
import { Textarea } from '@/components/ui/textarea';
import {
  appendProviderModels,
  type DiscoveredModel,
  discoverProviderModels,
  lookupModelMetadata,
  type ProviderModelConfig,
  type ProviderView,
} from '@/lib/api.ts';
import { formatNumber } from '@/lib/format.ts';
import { modelFormFromDraft, parseModelIds, requestErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

export type ModelPickerMode = 'discover' | 'manual';

/**
 * Adds models to an existing provider: fetch the provider's list and resolve
 * metadata, or look up ids the admin typed in. Neither path writes anything
 * until the selection is submitted, and a draft with unconfirmed fields cannot
 * be submitted before it went through the edit dialog.
 */
export function ModelPickerDialog({
  mode,
  provider,
  revision,
  restartPending,
  onClose,
}: {
  readonly mode: ModelPickerMode;
  readonly provider: ProviderView;
  readonly revision: string;
  readonly restartPending: boolean;
  readonly onClose: () => void;
}): React.ReactElement {
  const write = useProviderWrite();
  const selection = useDraftSelection();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  // A provider whose connection fields wait for a restart is not in the running
  // registry, so discovery has to carry its own credentials.
  const [tempMode, setTempMode] = useState(mode === 'discover' && restartPending);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames(provider.header_names));
  const [ids, setIds] = useState('');
  const [editing, setEditing] = useState<DiscoveredModel | null>(null);
  // models.dev is one metadata source among several; when it is unreachable the
  // listing still works, and this is what the admin has to know about the rest.
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const connection =
    provider.kind === 'builtin'
      ? { kind: 'builtin' as const, provider: provider.provider ?? '' }
      : { kind: 'custom' as const, base_url: provider.base_url, api: provider.api };

  const discover = useMutation({
    mutationFn: async () => {
      if (!tempMode) {
        return await discoverProviderModels({ alias: provider.alias });
      }
      const payload = headerValues(headers);
      if (payload.error !== null) {
        throw new Error(payload.error);
      }
      if (apiKey.length === 0) {
        throw new Error('Temporary mode needs an API key');
      }
      return await discoverProviderModels({
        ...connection,
        api_key: apiKey,
        ...(payload.values === undefined ? {} : { headers: payload.values }),
      });
    },
    onSuccess: (result) => {
      setEndpoint(result.endpoint);
      setMetadataError(result.metadata_source_error);
      selection.replaceDrafts(result.models);
    },
  });

  const lookup = useMutation({
    mutationFn: async () => {
      const parsed = parseModelIds(ids);
      if (parsed.length === 0) {
        throw new Error('Enter at least one model id');
      }
      const result = await lookupModelMetadata({ ...connection, ids: parsed });
      return {
        metadataSourceError: result.metadata_source_error,
        models: result.models.map((draft) => ({ ...draft, configured: false })),
      };
    },
    onSuccess: ({ models, metadataSourceError }) => {
      setMetadataError(metadataSourceError);
      selection.replaceDrafts(models);
      // A single id goes straight into the edit dialog, which is where its
      // metadata is confirmed; several ids are picked from the list first.
      const only = models.length === 1 ? models[0] : undefined;
      if (only !== undefined) {
        setEditing(only);
      }
    },
  });

  const append = useMutation({
    mutationFn: (models: readonly ProviderModelConfig[]) => appendProviderModels(provider.alias, models, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
      onClose();
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const fetchError = mode === 'discover' ? discover.error : lookup.error;
  const fetchPending = mode === 'discover' ? discover.isPending : lookup.isPending;
  const blocked = selection.selectedCount === 0 || selection.models === null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'discover' ? 'Fetch models' : 'Add models by id'}</DialogTitle>
          <DialogDescription>
            {provider.alias} · {provider.api}
            {mode === 'discover'
              ? ' · metadata from the provider listing and models.dev'
              : ' · metadata only; the listing endpoint is not called'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === 'discover' ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setTempMode((previous) => !previous)}>
                  {tempMode ? 'Use the saved connection' : 'Use temporary mode (key from this form)'}
                </Button>
                {endpoint === null ? null : (
                  <span className="text-muted-foreground text-xs">
                    endpoint: <MonoValue value={endpoint} />
                  </span>
                )}
              </div>
              {tempMode ? (
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-muted-foreground text-xs">
                    This provider has connection fields waiting for a restart, so the running process does not know them
                    yet: enter the API key once more here. After the restart it is no longer needed.
                  </p>
                  <div className="space-y-1">
                    <Label htmlFor="picker-api-key">API Key</Label>
                    <Input
                      id="picker-api-key"
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </div>
                  {provider.kind === 'custom' && provider.header_names.length > 0 ? (
                    <HeaderFields rows={headers} onChange={setHeaders} valuesRequired={false} idPrefix="picker" />
                  ) : null}
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={fetchPending}
                onClick={() => {
                  discover.mutate();
                }}
              >
                {fetchPending ? 'Fetching…' : selection.drafts.length === 0 ? 'Fetch' : 'Fetch again'}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="picker-ids">Model ids (one per line, or comma separated)</Label>
                <Textarea
                  id="picker-ids"
                  rows={3}
                  value={ids}
                  onChange={(event) => setIds(event.target.value)}
                  placeholder={'deepseek/deepseek-v4-flash\nqwen/qwen3-max'}
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={fetchPending}
                onClick={() => {
                  lookup.mutate();
                }}
              >
                {fetchPending ? 'Looking up…' : 'Look up metadata'}
              </Button>
            </div>
          )}

          {fetchError === null ? null : (
            <p className="text-destructive text-sm break-words">{requestErrorMessage(fetchError)}</p>
          )}

          {metadataError === null ? null : (
            <p className="text-muted-foreground text-xs break-words">
              models.dev metadata is unavailable ({metadataError}). The models listed can still be added, but every
              field has to be confirmed by hand.
            </p>
          )}

          {selection.drafts.length === 0 ? null : (
            <>
              <ModelDraftList
                drafts={selection.visibleDrafts}
                selected={selection.selected}
                resolved={selection.resolved}
                onToggle={selection.toggle}
                onEdit={setEditing}
                search={selection.search}
                onSearchChange={selection.setSearch}
                emptyText="No matching models."
              />
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted-foreground text-xs">
                  {formatNumber(selection.selectedCount)} selected
                  {selection.unresolved.length === 0
                    ? ''
                    : ` · ${selection.unresolved.map((draft) => draft.id).join(', ')} still need fields confirmed`}
                </p>
                {selection.confirmable === 0 ? null : (
                  <Button type="button" variant="outline" size="sm" onClick={selection.confirmSelected}>
                    Accept listed values ({formatNumber(selection.confirmable)})
                  </Button>
                )}
              </div>
            </>
          )}
          {append.isError ? (
            <p className="text-destructive text-sm break-words">{requestErrorMessage(append.error)}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={append.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={append.isPending || blocked}
            onClick={() => {
              if (selection.models !== null) {
                append.mutate(selection.models);
              }
            }}
          >
            {append.isPending
              ? 'Adding…'
              : `Add ${formatNumber(selection.selectedCount)} ${selection.selectedCount === 1 ? 'model' : 'models'}`}
          </Button>
        </DialogFooter>
      </DialogContent>

      {editing === null ? null : (
        <ModelEditDialog
          key={`confirm-${editing.id}`}
          open
          onOpenChange={(next) => {
            if (!next) {
              setEditing(null);
            }
          }}
          api={provider.api}
          title={`Confirm ${editing.id}`}
          description="Values come from the provider listing or models.dev; anything marked for confirming has to be confirmed or replaced."
          initial={modelFormFromDraft(editing, provider.api)}
          lockId
          draft={editing}
          pending={false}
          error={null}
          onSubmit={(model) => {
            selection.resolve(editing.id, model);
            setEditing(null);
          }}
        />
      )}
    </Dialog>
  );
}

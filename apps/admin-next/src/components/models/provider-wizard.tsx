import { useMutation, useQuery } from '@tanstack/react-query';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  type CreateProviderRequest,
  createProvider,
  type DiscoveredModel,
  discoverProviderModels,
  lookupModelMetadata,
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderKind,
  type ProviderModelConfig,
} from '@/lib/api.ts';
import { formatNumber } from '@/lib/format.ts';
import { modelFormFromDraft, parseModelIds, requestErrorMessage } from '@/lib/model-manager.ts';
import { providerPresetsQuery } from '@/lib/queries.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type WizardStep = 'connection' | 'credentials' | 'models';

const STEP_TITLES: Record<WizardStep, string> = {
  connection: 'Connection',
  credentials: 'Credentials',
  models: 'Models',
};

/**
 * New-provider wizard: connection → credentials → models. The model
 * list is never prefilled (C8): it comes from the provider's own listing with
 * the key that was just typed, or from ids the admin enters by hand.
 */
export function ProviderWizard({
  revision,
  onClose,
  onCreated,
}: {
  readonly revision: string;
  readonly onClose: () => void;
  /** Runs after a successful create, so the page can select the new provider. */
  readonly onCreated: (alias: string) => void;
}): React.ReactElement {
  const write = useProviderWrite();
  const presets = useQuery(providerPresetsQuery);
  const selection = useDraftSelection();

  const [step, setStep] = useState<WizardStep>('connection');
  const [kind, setKind] = useState<ProviderKind>('builtin');
  const [alias, setAlias] = useState('');
  const [presetId, setPresetId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState<ProviderApi>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames([]));
  const [ids, setIds] = useState('');
  const [editing, setEditing] = useState<DiscoveredModel | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const preset = (presets.data?.presets ?? []).find((candidate) => candidate.id === presetId) ?? null;
  const aliasValid = ALIAS_PATTERN.test(alias);

  const connection: {
    readonly kind: ProviderKind;
    readonly provider?: string;
    readonly base_url?: string;
    readonly api?: ProviderApi;
  } = kind === 'builtin' ? { kind, provider: presetId } : { kind, base_url: baseUrl.trim(), api };

  const discover = useMutation({
    mutationFn: async () => {
      const payload = headerValues(headers);
      if (payload.error !== null) {
        throw new Error(payload.error);
      }
      if (apiKey.length === 0) {
        throw new Error('Enter the API key first');
      }
      return await discoverProviderModels({
        ...connection,
        api_key: apiKey,
        ...(payload.values === undefined ? {} : { headers: payload.values }),
      });
    },
    onSuccess: (result) => {
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
      return result.models.map((draft) => ({ ...draft, configured: false }));
    },
    onSuccess: (models) => {
      selection.replaceDrafts(models);
    },
  });

  const create = useMutation({
    mutationFn: (body: CreateProviderRequest) => createProvider(body, revision),
    onSuccess: (result) => {
      // A create is applied immediately like every other write, so the same
      // feedback shows and the wizard hands the new provider to the page.
      write.succeeded(result.apply);
      onCreated(alias);
      onClose();
      // The body carries the plaintext key; resetting drops it from the
      // mutation cache once the request is over.
      create.reset();
    },
    onError: (error) => {
      write.failed(error);
      setCreateError(requestErrorMessage(error));
      create.reset();
    },
  });

  const submit = (): void => {
    if (selection.models === null) {
      return;
    }
    const payload = headerValues(headers);
    if (payload.error !== null) {
      // An incomplete header row must stop the submit: dropping it silently
      // would create the provider without a header the admin meant to send.
      setCreateError(payload.error);
      return;
    }
    setCreateError(null);
    create.mutate({
      alias,
      kind,
      ...(kind === 'builtin' ? { provider: presetId } : { base_url: baseUrl.trim(), api }),
      api_key: apiKey,
      ...(payload.values === undefined ? {} : { headers: payload.values }),
      models: selection.models,
    });
  };

  const fetchError = step === 'models' ? (discover.error ?? lookup.error) : null;
  const fetchPending = discover.isPending || lookup.isPending;

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
          <DialogTitle>New provider - {STEP_TITLES[step]}</DialogTitle>
          <DialogDescription>The new provider is written to config.jsonc and applied immediately.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {step === 'connection' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="wizard-kind">kind</Label>
                <Select value={kind} onValueChange={(value) => setKind(value as ProviderKind)}>
                  <SelectTrigger id="wizard-kind" className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="builtin">builtin (a provider Pi ships)</SelectItem>
                    <SelectItem value="custom">custom (your own endpoint)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-alias">alias</Label>
                <Input
                  id="wizard-alias"
                  value={alias}
                  placeholder="openrouter"
                  onChange={(event) => setAlias(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Starts with a letter; letters, digits, underscore and hyphen only, up to 64. An alias cannot be
                  renamed later.
                </p>
                {alias.length > 0 && !aliasValid ? (
                  <p className="text-destructive text-sm">alias does not match the allowed pattern</p>
                ) : null}
              </div>
              {kind === 'builtin' ? (
                <div className="space-y-2">
                  <Label htmlFor="wizard-preset">Pi provider</Label>
                  {presets.isPending ? (
                    <p className="text-muted-foreground text-sm">Loading presets…</p>
                  ) : presets.isError ? (
                    <p className="text-destructive text-sm break-words">{requestErrorMessage(presets.error)}</p>
                  ) : (
                    <Select value={presetId} onValueChange={setPresetId}>
                      <SelectTrigger id="wizard-preset" className="w-full">
                        <SelectValue placeholder="Pick a built-in provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {(presets.data?.presets ?? []).map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.name} ({candidate.api})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {preset === null ? null : (
                    <p className="text-muted-foreground text-xs">
                      base_url: <MonoValue value={preset.base_url} />
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="wizard-base-url">base_url</Label>
                    <Input
                      id="wizard-base-url"
                      value={baseUrl}
                      placeholder="https://example.com/v1"
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wizard-api">api</Label>
                    <Select value={api} onValueChange={(value) => setApi(value as ProviderApi)}>
                      <SelectTrigger id="wizard-api" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROVIDER_APIS.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {api === 'google-generative-ai' ? (
                      <p className="text-muted-foreground text-xs">
                        base_url must already carry the version path, for example /v1beta.
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {step === 'credentials' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="wizard-api-key">API Key</Label>
                <Input
                  id="wizard-api-key"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  This key fetches the model list and is stored in key.json next to the configuration file; config.jsonc
                  only names its entry.
                </p>
              </div>
              {kind === 'custom' ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Headers (optional)</p>
                  <HeaderFields rows={headers} onChange={setHeaders} valuesRequired={false} idPrefix="wizard" />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 'models' ? (
            <div className="space-y-4">
              <p className="text-muted-foreground text-xs">
                The provider is not saved yet, so the listing is fetched in temporary mode with the key above. There is
                no preset model list: only what you select is written to the configuration.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fetchPending}
                  onClick={() => {
                    discover.mutate();
                  }}
                >
                  {fetchPending ? 'Fetching…' : 'Fetch models'}
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-ids">Or enter model ids by hand (one per line, or comma separated)</Label>
                <Textarea id="wizard-ids" rows={2} value={ids} onChange={(event) => setIds(event.target.value)} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fetchPending}
                  onClick={() => {
                    lookup.mutate();
                  }}
                >
                  Look up metadata
                </Button>
              </div>
              {fetchError === null ? null : (
                <p className="text-destructive text-sm break-words">{requestErrorMessage(fetchError)}</p>
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
            </div>
          ) : null}

          {createError === null ? null : <p className="text-destructive text-sm break-words">{createError}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
            Cancel
          </Button>
          {step === 'connection' ? (
            <Button
              type="button"
              disabled={!aliasValid || (kind === 'builtin' ? presetId.length === 0 : baseUrl.trim().length === 0)}
              onClick={() => setStep('credentials')}
            >
              Next
            </Button>
          ) : null}
          {step === 'credentials' ? (
            <Button type="button" disabled={apiKey.length === 0} onClick={() => setStep('models')}>
              Next
            </Button>
          ) : null}
          {step === 'models' ? (
            <Button type="button" disabled={create.isPending || selection.models === null} onClick={submit}>
              {create.isPending ? 'Saving…' : 'Create provider'}
            </Button>
          ) : null}
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
          api={kind === 'builtin' ? (preset?.api ?? api) : api}
          title={`Confirm ${editing.id}`}
          description="Values come from the provider listing or models.dev; anything marked for confirming has to be confirmed or replaced."
          initial={modelFormFromDraft(editing, kind === 'builtin' ? (preset?.api ?? api) : api)}
          lockId
          draft={editing}
          pending={false}
          error={null}
          onSubmit={(model: ProviderModelConfig) => {
            selection.resolve(editing.id, model);
            setEditing(null);
          }}
        />
      )}
    </Dialog>
  );
}

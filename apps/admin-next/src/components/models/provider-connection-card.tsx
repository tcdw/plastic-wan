import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { KvList, MonoValue } from '@/components/business';
import {
  HeaderFields,
  headerPayload,
  headerRowsFromNames,
  type HeaderRow,
  removedHeaderNames,
} from '@/components/models/header-fields';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderView,
  type UpdateProviderRequest,
  updateProvider,
} from '@/lib/api.ts';
import { requestErrorMessage } from '@/lib/model-manager.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

const API_LABELS: Record<ProviderApi, string> = {
  'openai-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
  'google-generative-ai': 'google-generative-ai',
};

/**
 * Connection fields of one provider. Builtin providers keep Pi's address and
 * adapter (read-only); only their key can change. Secrets are write-only: the
 * panel shows an empty password field, never a value and never a reveal button.
 */
export function ProviderConnectionCard({
  provider,
  revision,
  onDetect,
}: {
  readonly provider: ProviderView;
  readonly revision: string;
  readonly onDetect: () => void;
}): React.ReactElement {
  const write = useProviderWrite();
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [api, setApi] = useState<ProviderApi>(provider.api);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames(provider.header_names));
  const [localError, setLocalError] = useState<string | null>(null);

  const custom = provider.kind === 'custom';
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const baseUrlChanged = custom && trimmedBaseUrl !== provider.base_url;
  const apiChanged = custom && api !== provider.api;
  const removed = removedHeaderNames(provider.header_names, headers);
  const payload = headerPayload(headers, removed);
  const dirty = baseUrlChanged || apiChanged || apiKey.length > 0 || payload.headers !== undefined;

  const save = useMutation({
    mutationFn: (body: UpdateProviderRequest) => updateProvider(provider.alias, body, revision),
    onSuccess: (result) => {
      const saved = result.providers.find((candidate) => candidate.alias === provider.alias);
      setApiKey('');
      setLocalError(null);
      if (saved !== undefined) {
        setBaseUrl(saved.base_url);
        setApi(saved.api);
        setHeaders(headerRowsFromNames(saved.header_names));
      }
      write.succeeded(result.apply);
      // The request body carries the plaintext key; resetting the mutation drops
      // it from the mutation cache as soon as the request is over.
      save.reset();
    },
    onError: (error) => {
      write.failed(error);
      // The message is kept in local state so the mutation (and with it the key
      // in `variables`) can be dropped right away.
      setLocalError(requestErrorMessage(error));
      save.reset();
    },
  });

  const submit = (): void => {
    if (payload.error !== null) {
      setLocalError(payload.error);
      return;
    }
    if (baseUrlChanged) {
      // Moving the address without re-entering the credentials would let a
      // stolen session point a stored key at another server.
      if (apiKey.length === 0) {
        setLocalError('Changing base_url requires the API key again');
        return;
      }
      const missing = provider.header_names.filter((name) => !headers.some((row) => row.existing && row.name === name));
      if (missing.length > 0) {
        setLocalError(`A header cannot be removed while base_url changes: ${missing.join(', ')}`);
        return;
      }
      if (headers.some((row) => row.existing && row.value.length === 0)) {
        setLocalError('Changing base_url requires every header value again');
        return;
      }
    }
    const body: UpdateProviderRequest = {
      ...(baseUrlChanged ? { base_url: trimmedBaseUrl } : {}),
      ...(apiChanged ? { api } : {}),
      ...(apiKey.length > 0 ? { api_key: apiKey } : {}),
      ...(payload.headers === undefined ? {} : { headers: payload.headers }),
    };
    setLocalError(null);
    save.mutate(body);
  };

  const error = localError;

  return (
    <Panel
      title="Connection"
      action={
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onDetect}>
            Test
          </Button>
          <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {custom ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider-base-url">base_url</Label>
              <Input
                id="provider-base-url"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setLocalError(null);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-api">api</Label>
              <Select value={api} onValueChange={(value) => setApi(value as ProviderApi)}>
                <SelectTrigger id="provider-api" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_APIS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {API_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {api === 'google-generative-ai' ? (
                <p className="text-muted-foreground text-xs">
                  base_url must already carry the version path, for example end with /v1beta.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <KvList
            items={[
              { label: 'Built-in provider', value: <MonoValue value={provider.provider ?? ''} /> },
              { label: 'base_url', value: <MonoValue value={provider.base_url} /> },
              { label: 'api', value: <MonoValue value={provider.api} /> },
            ]}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="provider-api-key">API Key</Label>
            <Input
              id="provider-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setLocalError(null);
              }}
            />
            <p className="text-muted-foreground text-xs">
              Set - leave empty to keep it
              {baseUrlChanged ? ' · required again after a base_url change' : ''}
            </p>
          </div>
        </div>

        {custom ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Headers</p>
            <HeaderFields
              rows={headers}
              onChange={(rows) => {
                setHeaders(rows);
                setLocalError(null);
              }}
              valuesRequired={baseUrlChanged}
              idPrefix="provider"
            />
          </div>
        ) : null}

        {baseUrlChanged ? (
          <p className="text-warning text-xs">
            Changing base_url requires the API key and every header value in the same save
          </p>
        ) : null}
        {error !== null ? <p className="text-destructive text-sm break-words">{error}</p> : null}
      </div>
    </Panel>
  );
}

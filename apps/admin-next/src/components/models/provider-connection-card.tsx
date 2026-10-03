import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { KvList, MonoValue } from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { HeaderFields } from '@/components/models/header-fields';
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
import { type HeaderRow, headerPayload, headerRowsFromNames, removedHeaderNames } from '@/lib/header-rows.ts';
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
  const { t } = useTranslation();
  const write = useProviderWrite();
  // The provider and revision the drafts below were built from. Every comparison
  // and the If-Match of a save use this baseline, never the latest query data:
  // comparing stale header rows against freshly fetched names read a header
  // someone else just added as a deletion, and the fresh revision let that save
  // through.
  const [baseline, setBaseline] = useState({ provider, revision });
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [api, setApi] = useState<ProviderApi>(provider.api);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<readonly HeaderRow[]>(() => headerRowsFromNames(provider.header_names));
  const [localError, setLocalError] = useState<string | null>(null);

  const base = baseline.provider;
  const custom = base.kind === 'custom';
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const baseUrlChanged = custom && trimmedBaseUrl !== base.base_url;
  const apiChanged = custom && api !== base.api;
  const removed = removedHeaderNames(base.header_names, headers);
  const payload = headerPayload(headers, removed);
  const dirty = baseUrlChanged || apiChanged || apiKey.length > 0 || payload.headers !== undefined;
  const stale = revision !== baseline.revision;

  const resetDrafts = (next: ProviderView, nextRevision: string): void => {
    setBaseline({ provider: next, revision: nextRevision });
    setBaseUrl(next.base_url);
    setApi(next.api);
    setApiKey('');
    setHeaders(headerRowsFromNames(next.header_names));
    setLocalError(null);
  };

  // Untouched drafts simply follow the server. Edited ones wait for an explicit
  // reload, so a refresh never silently merges into what the admin typed.
  useEffect(() => {
    if (stale && !dirty) {
      setBaseline({ provider, revision });
      setBaseUrl(provider.base_url);
      setApi(provider.api);
      setHeaders(headerRowsFromNames(provider.header_names));
    }
  }, [stale, dirty, provider, revision]);

  const save = useMutation({
    mutationFn: (body: UpdateProviderRequest) => updateProvider(base.alias, body, baseline.revision),
    onSuccess: (result) => {
      const saved = result.providers.find((candidate) => candidate.alias === base.alias);
      setApiKey('');
      setLocalError(null);
      if (saved !== undefined) {
        resetDrafts(saved, result.revision);
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
        setLocalError(t('models.models.connection.needsApiKey'));
        return;
      }
      const missing = base.header_names.filter((name) => !headers.some((row) => row.existing && row.name === name));
      if (missing.length > 0) {
        setLocalError(t('models.models.connection.headerRemoved', { names: missing.join(', ') }));
        return;
      }
      if (headers.some((row) => row.existing && row.value.length === 0)) {
        setLocalError(t('models.models.headers.valuesRequired'));
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
      title={t('models.models.connection.title')}
      action={
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onDetect}>
            {t('models.models.connection.test')}
          </Button>
          <Button type="button" size="sm" disabled={!dirty || stale || save.isPending} onClick={submit}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {custom ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider-base-url">{t('models.models.connection.baseUrl')}</Label>
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
              <Label htmlFor="provider-api">{t('models.models.connection.api')}</Label>
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
                <p className="text-muted-foreground text-xs">{t('models.models.connection.googleNote')}</p>
              ) : null}
            </div>
          </div>
        ) : (
          <KvList
            items={[
              {
                label: t('models.models.connection.builtinProvider'),
                value: <MonoValue value={provider.provider ?? ''} />,
              },
              { label: t('models.models.connection.baseUrl'), value: <MonoValue value={provider.base_url} /> },
              { label: t('models.models.connection.api'), value: <MonoValue value={provider.api} /> },
            ]}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="provider-api-key">{t('models.models.connection.apiKey')}</Label>
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
              {t('models.models.connection.keepHint')}
              {baseUrlChanged ? t('models.models.connection.keepHintChanged') : ''}
            </p>
          </div>
        </div>

        {custom ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('models.models.connection.headersTitle')}</p>
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

        {baseUrlChanged ? <p className="text-warning text-xs">{t('models.models.connection.changedWarning')}</p> : null}
        {stale && dirty ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-warning text-sm break-words">{t('models.models.connection.staleWarning')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => resetDrafts(provider, revision)}>
              {t('common.reload')}
            </Button>
          </div>
        ) : null}
        {error !== null ? <p className="text-destructive text-sm break-words">{error}</p> : null}
      </div>
    </Panel>
  );
}

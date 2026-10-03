import { useMutation, useQuery } from '@tanstack/react-query';
import { Eye, Lightbulb, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type ColumnSpec,
  ConfirmDialog,
  FLUSH_TABLE_CLASS,
  MonoValue,
  TableShell,
  ToneBadge,
} from '@/components/business';
import { Panel } from '@/components/layout/panel';
import { InUsePanel } from '@/components/models/in-use-panel';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { ModelPickerDialog, type ModelPickerMode } from '@/components/models/model-picker-dialog';
import { ProviderConnectionCard } from '@/components/models/provider-connection-card';
import { ProviderWizard } from '@/components/models/provider-wizard';
import { RestartBanner } from '@/components/models/restart-banner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  deleteProvider,
  deleteProviderModel,
  type ProviderApi,
  type ProviderModelConfig,
  type ProviderView,
  replaceProviderModel,
  restartServer,
  switchAgentModel,
  switchVisionModel,
} from '@/lib/api.ts';
import { errorMessage } from '@/lib/errors.ts';
import { formatNumber } from '@/lib/format.ts';
import {
  isConfigConflict,
  isImageCapable,
  isTextCapable,
  modelFormFromConfig,
  modelUsage,
  providerMatchesSearch,
  providerUsage,
  writeErrorMessage,
} from '@/lib/model-manager.ts';
import { providersQuery } from '@/lib/queries.ts';
import { waitForAdminServer } from '@/lib/restart.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';
import { cn } from '@/lib/utils';

interface ModelRow {
  readonly alias: string;
  readonly api: ProviderApi;
  readonly model: ProviderModelConfig;
}

interface PickerTarget {
  readonly mode: ModelPickerMode;
  readonly alias: string;
  /** Remounts the dialog so its credentials and selection start empty. */
  readonly nonce: number;
}

function ProviderBadges({
  view,
  provider,
}: {
  readonly view: { readonly agent: { provider: string }; readonly vision: { provider: string } };
  readonly provider: ProviderView;
}): React.ReactElement {
  const { t } = useTranslation();
  const usage = providerUsage(view, provider.alias);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {usage.agent ? <ToneBadge tone="success">{t('models.models.page.agentInUse')}</ToneBadge> : null}
      {usage.vision ? <ToneBadge tone="info">{t('models.models.page.visionInUse')}</ToneBadge> : null}
    </span>
  );
}

export default function ModelsPage(): React.ReactElement {
  const { t } = useTranslation();
  const write = useProviderWrite();
  const providers = useQuery(providersQuery);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // The revision travels with the snapshot the edit form starts from, so a save
  // can never pass the concurrency check with a form built from older data.
  const [editing, setEditing] = useState<{
    readonly alias: string;
    readonly model: ProviderModelConfig;
    readonly revision: string;
  } | null>(null);
  const [deletingModel, setDeletingModel] = useState<{ readonly alias: string; readonly model: string } | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderView | null>(null);

  const view = providers.data;
  const revision = view?.revision ?? '';
  const restartPaths = useMemo(() => view?.restart_required ?? [], [view]);

  const switchAgent = useMutation({
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      switchAgentModel({ provider: alias, model }, revision),
    onSuccess: (result) => {
      // Models do not share one set of levels, so the switch always resets it.
      write.succeeded(result.apply, t('models.models.page.thinkingReset', { level: result.current.thinking_level }));
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

  const switchVision = useMutation({
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      switchVisionModel({ provider: alias, model }, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
      write.failed(error);
    },
  });

  const saveModel = useMutation({
    mutationFn: ({
      alias,
      model,
      revision: formRevision,
    }: {
      readonly alias: string;
      readonly model: ProviderModelConfig;
      readonly revision: string;
    }) => replaceProviderModel(alias, model.id, model, formRevision),
    onSuccess: (result) => {
      setEditing(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
      if (isConfigConflict(error)) {
        // Retrying this form would overwrite whatever changed on the server, so
        // it closes; reopening starts from the refreshed definition.
        setEditing(null);
        saveModel.reset();
        toast.error(t('models.models.page.editConflictToast'));
      }
    },
  });

  const removeModel = useMutation({
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      deleteProviderModel(alias, model, revision),
    onSuccess: (result) => {
      setDeletingModel(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const removeProvider = useMutation({
    mutationFn: (alias: string) => deleteProvider(alias, revision),
    onSuccess: (result) => {
      setDeletingProvider(null);
      setSelectedAlias(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
    },
  });

  const restart = useMutation({
    mutationFn: restartServer,
    onSuccess: async () => {
      toast.info(t('models.models.page.restarting'), {
        description: t('models.models.page.restartingDescription'),
      });
      const recovered = await waitForAdminServer();
      write.refresh();
      if (recovered) {
        toast.success(t('models.models.page.serverBack'));
      } else {
        toast.error(t('models.models.page.restartTimeout'));
      }
    },
    onError: (error) => {
      toast.error(writeErrorMessage(error));
    },
  });

  if (providers.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (providers.isError || view === undefined) {
    return (
      <div className="p-6 text-center">
        <p className="text-destructive font-medium">{t('models.models.page.loadFailed')}</p>
        <p className="text-muted-foreground text-sm break-words">{errorMessage(providers.error)}</p>
      </div>
    );
  }

  const listed = view.providers.filter((provider) => providerMatchesSearch(provider, search));
  const selected =
    view.providers.find((provider) => provider.alias === selectedAlias) ?? listed[0] ?? view.providers[0] ?? null;

  const rows: readonly ModelRow[] =
    selected === null ? [] : selected.models.map((model) => ({ alias: selected.alias, api: selected.api, model }));

  const columns: readonly ColumnSpec<ModelRow>[] = [
    {
      key: 'model',
      title: t('models.models.page.colModel'),
      className: 'max-w-96 min-w-48 whitespace-normal',
      render: (row) => (
        <div className="space-y-0.5">
          <MonoValue value={row.model.id} />
          <p className="text-muted-foreground truncate text-xs">{row.model.name ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'flags',
      title: t('models.models.page.colFlags'),
      render: (row) => (
        <span className="text-muted-foreground flex items-center gap-1.5">
          {isImageCapable(row.model) ? (
            <>
              <Eye className="size-[1.15em]" aria-hidden="true" />
              <span className="sr-only">{t('models.models.page.srOnlyImage')}</span>
            </>
          ) : null}
          {row.model.reasoning ? (
            <>
              <Lightbulb className="size-[1.15em]" aria-hidden="true" />
              <span className="sr-only">{t('models.models.page.srOnlyReasoning')}</span>
            </>
          ) : null}
        </span>
      ),
    },
    {
      key: 'context',
      title: t('models.models.page.colContext'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.model.context_window),
    },
    {
      key: 'max_tokens',
      title: t('models.models.page.colMaxOutput'),
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.model.max_tokens),
    },
    {
      key: 'usage',
      title: t('models.models.page.colInUse'),
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        if (usage === null) {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <span className="flex flex-wrap items-center gap-1">
            {usage === 'agent' || usage === 'both' ? (
              <ToneBadge tone="success">{t('models.models.page.agentBadge')}</ToneBadge>
            ) : null}
            {usage === 'vision' || usage === 'both' ? (
              <ToneBadge tone="info">{t('models.models.page.visionBadge')}</ToneBadge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'actions',
      title: t('models.models.page.colActions'),
      align: 'right',
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!isTextCapable(row.model) || usage === 'agent' || usage === 'both' || switchAgent.isPending}
              onClick={() => switchAgent.mutate({ alias: row.alias, model: row.model.id })}
            >
              {t('models.models.page.setAsAgent')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!isImageCapable(row.model) || usage === 'vision' || usage === 'both' || switchVision.isPending}
              onClick={() => switchVision.mutate({ alias: row.alias, model: row.model.id })}
            >
              {t('models.models.page.setAsVision')}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('models.models.page.editModelAria', { model: row.model.id })}
              onClick={() => setEditing({ alias: row.alias, model: row.model, revision })}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('models.models.page.deleteModelAria', { model: row.model.id })}
              disabled={usage !== null}
              onClick={() => setDeletingModel({ alias: row.alias, model: row.model.id })}
            >
              <Trash2 />
            </Button>
          </div>
        );
      },
    },
  ];

  const pickerProvider = picker === null ? null : (view.providers.find((p) => p.alias === picker.alias) ?? null);

  return (
    <div className="space-y-6">
      <RestartBanner
        paths={restartPaths}
        supervised={view.supervised}
        pending={restart.isPending}
        onRestart={() => restart.mutate()}
      />

      <InUsePanel view={view} revision={revision} />

      {/* `grid-cols-1` on a phone: an implicit `auto` track grows to the model
          table's min-content and scrolls the whole page sideways. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <Panel
          title={t('models.models.page.providersTitle')}
          className="self-start"
          action={
            <Button type="button" size="sm" onClick={() => setWizardOpen(true)}>
              {t('models.models.page.newProvider')}
            </Button>
          }
        >
          <div className="space-y-3">
            <Input
              aria-label={t('models.models.page.searchProviders')}
              placeholder={t('models.models.page.searchProviders')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {view.providers.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('models.models.page.noProviders')}</p>
            ) : listed.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('models.models.page.noMatchingProviders')}</p>
            ) : (
              <ul className="space-y-0.5">
                {listed.map((provider) => {
                  const active = selected !== null && selected.alias === provider.alias;
                  return (
                    <li key={provider.alias}>
                      {/* No border: the panel is already the frame, and a box per
                          row would nest one inside it. */}
                      <button
                        type="button"
                        aria-label={t('models.models.page.providerAria', { alias: provider.alias })}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'w-full space-y-1 rounded-lg px-3 py-2 text-left transition-colors',
                          active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                        )}
                        onClick={() => setSelectedAlias(provider.alias)}
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <MonoValue value={provider.alias} />
                          <span className="text-muted-foreground text-xs">{provider.kind}</span>
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {provider.provider ?? provider.base_url}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <ProviderBadges view={view} provider={provider} />
                          <span className="text-muted-foreground text-xs tabular-nums">
                            {t(
                              provider.models.length === 1
                                ? 'models.models.page.oneModel'
                                : 'models.models.page.manyModels',
                              { count: provider.models.length },
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Panel>

        <div className="space-y-6">
          {selected === null ? (
            <Card>
              <CardContent className="text-muted-foreground py-8 text-center text-sm">
                {t('models.models.page.emptyState')}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-mono text-base font-semibold">{selected.alias}</h2>
                  <span className="text-muted-foreground text-xs">{selected.kind}</span>
                  <ProviderBadges view={view} provider={selected} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={providerUsage(view, selected.alias).agent || providerUsage(view, selected.alias).vision}
                  onClick={() => setDeletingProvider(selected)}
                >
                  <Trash2 />
                  {t('models.models.page.deleteProvider')}
                </Button>
              </div>

              <ProviderConnectionCard
                key={selected.alias}
                provider={selected}
                revision={revision}
                onDetect={() => setPicker({ mode: 'discover', alias: selected.alias, nonce: Date.now() })}
              />

              <Panel
                title={t('models.models.page.modelsTitle')}
                flush
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPicker({ mode: 'discover', alias: selected.alias, nonce: Date.now() })}
                    >
                      {t('models.models.page.fetchModels')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPicker({ mode: 'manual', alias: selected.alias, nonce: Date.now() })}
                    >
                      {t('models.models.page.addById')}
                    </Button>
                  </div>
                }
              >
                {/* Flush: the panel is the frame, so the table only keeps the
                    rule under the header. */}
                <TableShell
                  columns={columns}
                  data={rows}
                  rowKey={(row) => `${row.alias}/${row.model.id}`}
                  className={FLUSH_TABLE_CLASS}
                  emptyText={t('models.models.page.emptyModels')}
                />
              </Panel>
            </>
          )}
        </div>
      </div>

      {wizardOpen ? (
        <ProviderWizard
          revision={revision}
          onClose={() => setWizardOpen(false)}
          onCreated={(alias) => setSelectedAlias(alias)}
        />
      ) : null}

      {picker === null || pickerProvider === null ? null : (
        <ModelPickerDialog
          key={`${picker.mode}-${picker.alias}-${String(picker.nonce)}`}
          mode={picker.mode}
          provider={pickerProvider}
          revision={revision}
          onClose={() => setPicker(null)}
        />
      )}

      {editing === null ? null : (
        <ModelEditDialog
          key={`edit-${editing.alias}/${editing.model.id}`}
          open
          onOpenChange={(next) => {
            if (!next) {
              setEditing(null);
            }
          }}
          api={view.providers.find((provider) => provider.alias === editing.alias)?.api ?? 'openai-completions'}
          title={t('models.models.page.editTitle', { model: editing.model.id })}
          description={t('models.models.page.editDescription')}
          initial={modelFormFromConfig(
            editing.model,
            view.providers.find((provider) => provider.alias === editing.alias)?.api ?? 'openai-completions',
          )}
          lockId
          draft={null}
          pending={saveModel.isPending}
          error={saveModel.isError ? writeErrorMessage(saveModel.error) : null}
          onSubmit={(model) => saveModel.mutate({ alias: editing.alias, model, revision: editing.revision })}
        />
      )}

      <ConfirmDialog
        open={deletingModel !== null}
        onOpenChange={(open) => {
          if (!open && !removeModel.isPending) {
            setDeletingModel(null);
          }
        }}
        title={t('models.models.page.deleteModelTitle')}
        description={
          deletingModel === null
            ? ''
            : t('models.models.page.deleteModelDescription', { model: deletingModel.model, alias: deletingModel.alias })
        }
        confirmText={t('models.models.page.deleteModelConfirm')}
        destructive
        pending={removeModel.isPending}
        error={removeModel.isError ? writeErrorMessage(removeModel.error) : null}
        onConfirm={() => {
          if (deletingModel !== null) {
            removeModel.mutate(deletingModel);
          }
        }}
      />

      <ConfirmDialog
        open={deletingProvider !== null}
        onOpenChange={(open) => {
          if (!open && !removeProvider.isPending) {
            setDeletingProvider(null);
          }
        }}
        title={t('models.models.page.deleteProviderTitle')}
        description={
          deletingProvider === null
            ? ''
            : t('models.models.page.deleteProviderDescription', { alias: deletingProvider.alias })
        }
        confirmText={t('models.models.page.deleteProviderConfirm')}
        destructive
        pending={removeProvider.isPending}
        error={removeProvider.isError ? writeErrorMessage(removeProvider.error) : null}
        onConfirm={() => {
          if (deletingProvider !== null) {
            removeProvider.mutate(deletingProvider.alias);
          }
        }}
      />
    </div>
  );
}

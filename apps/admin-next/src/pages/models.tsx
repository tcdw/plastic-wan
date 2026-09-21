import { useMutation, useQuery } from '@tanstack/react-query';
import { Eye, Lightbulb, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ConfirmDialog,
  FLUSH_TABLE_CLASS,
  MonoValue,
  TableShell,
  ToneBadge,
  type ColumnSpec,
} from '@/components/business';
import { ModelEditDialog } from '@/components/models/model-edit-dialog';
import { ModelPickerDialog, type ModelPickerMode } from '@/components/models/model-picker-dialog';
import { ProviderConnectionCard } from '@/components/models/provider-connection-card';
import { ProviderWizard } from '@/components/models/provider-wizard';
import { RestartBanner } from '@/components/models/restart-banner';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
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
  isImageCapable,
  isTextCapable,
  modelFormFromConfig,
  modelPendingRestart,
  modelUsage,
  providerMatchesSearch,
  providerPendingRestart,
  providerUsage,
  writeErrorMessage,
} from '@/lib/model-manager.ts';
import { providersQuery } from '@/lib/queries.ts';
import { waitForAdminServer } from '@/lib/restart.ts';
import { useProviderWrite } from '@/lib/use-provider-write.ts';

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
  const usage = providerUsage(view, provider.alias);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {usage.agent ? <ToneBadge tone="success">Agent 在用</ToneBadge> : null}
      {usage.vision ? <ToneBadge tone="info">Vision 在用</ToneBadge> : null}
    </span>
  );
}

export default function ModelsPage(): React.ReactElement {
  const write = useProviderWrite();
  const providers = useQuery(providersQuery);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [editing, setEditing] = useState<{ readonly alias: string; readonly model: ProviderModelConfig } | null>(null);
  const [deletingModel, setDeletingModel] = useState<{ readonly alias: string; readonly model: string } | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderView | null>(null);

  const view = providers.data;
  const revision = view?.revision ?? '';
  const restartPaths = useMemo(() => view?.restart_required ?? [], [view]);

  const switchAgent = useMutation({
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: string }) =>
      switchAgentModel({ provider: alias, model }, revision),
    onSuccess: (result) => {
      write.succeeded(result.apply);
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
    mutationFn: ({ alias, model }: { readonly alias: string; readonly model: ProviderModelConfig }) =>
      replaceProviderModel(alias, model.id, model, revision),
    onSuccess: (result) => {
      setEditing(null);
      write.succeeded(result.apply);
    },
    onError: (error) => {
      write.failed(error);
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
      toast.info('正在重启服务端…', { description: '页面会短暂断开连接，恢复后会自动重新加载。' });
      const recovered = await waitForAdminServer();
      write.refresh();
      if (recovered) {
        toast.success('服务端已恢复');
      } else {
        toast.error('等待服务端恢复超时，请检查进程监督配置');
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
        <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (providers.isError || view === undefined) {
    return (
      <div className="p-6 text-center">
        <p className="text-destructive font-medium">Failed to load providers</p>
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
      title: 'Model',
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
      title: 'Flags',
      render: (row) => (
        <span className="text-muted-foreground flex items-center gap-1.5">
          {isImageCapable(row.model) ? (
            <>
              <Eye className="size-[1.15em]" aria-hidden="true" />
              <span className="sr-only">accepts image input</span>
            </>
          ) : null}
          {row.model.reasoning ? (
            <>
              <Lightbulb className="size-[1.15em]" aria-hidden="true" />
              <span className="sr-only">reasoning model</span>
            </>
          ) : null}
          {modelPendingRestart(restartPaths, row.alias, row.model.id) ? (
            <ToneBadge tone="warning">待重启</ToneBadge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'context',
      title: 'Context',
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.model.context_window),
    },
    {
      key: 'max_tokens',
      title: 'Max output',
      align: 'right',
      className: 'tabular-nums',
      render: (row) => formatNumber(row.model.max_tokens),
    },
    {
      key: 'usage',
      title: 'In use',
      render: (row) => {
        const usage = modelUsage(view, row.alias, row.model.id);
        if (usage === null) {
          return <span className="text-muted-foreground">—</span>;
        }
        return (
          <span className="flex flex-wrap items-center gap-1">
            {usage === 'agent' || usage === 'both' ? <ToneBadge tone="success">Agent</ToneBadge> : null}
            {usage === 'vision' || usage === 'both' ? <ToneBadge tone="info">Vision</ToneBadge> : null}
          </span>
        );
      },
    },
    {
      key: 'actions',
      title: 'Actions',
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
              设为 Agent
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!isImageCapable(row.model) || usage === 'vision' || usage === 'both' || switchVision.isPending}
              onClick={() => switchVision.mutate({ alias: row.alias, model: row.model.id })}
            >
              设为 Vision
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${row.model.id}`}
              onClick={() => setEditing({ alias: row.alias, model: row.model })}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${row.model.id}`}
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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <Panel
          title="Providers"
          className="self-start"
          action={
            <Button type="button" size="sm" onClick={() => setWizardOpen(true)}>
              新建 Provider
            </Button>
          }
        >
          <div className="space-y-3">
            <Input
              aria-label="Search providers"
              placeholder="Search providers"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {view.providers.length === 0 ? (
              <p className="text-muted-foreground text-sm">还没有配置任何 Provider。</p>
            ) : listed.length === 0 ? (
              <p className="text-muted-foreground text-sm">没有匹配的 Provider。</p>
            ) : (
              <ul className="space-y-0.5">
                {listed.map((provider) => {
                  const pendingRestart = providerPendingRestart(restartPaths, provider.alias);
                  const active = selected !== null && selected.alias === provider.alias;
                  return (
                    <li key={provider.alias}>
                      {/* No border: the panel is already the frame, and a box per
                          row would nest one inside it. */}
                      <button
                        type="button"
                        aria-label={`Provider ${provider.alias}`}
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
                          {pendingRestart ? <ToneBadge tone="warning">待重启</ToneBadge> : null}
                          <span className="text-muted-foreground text-xs tabular-nums">
                            {provider.models.length} {provider.models.length === 1 ? 'model' : 'models'}
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
                先新建一个 Provider，再填写 API Key 获取模型列表。
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
                  删除 Provider
                </Button>
              </div>

              <ProviderConnectionCard
                key={selected.alias}
                provider={selected}
                revision={revision}
                onDetect={() => setPicker({ mode: 'discover', alias: selected.alias, nonce: Date.now() })}
              />

              <Panel
                title="Models"
                flush
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPicker({ mode: 'discover', alias: selected.alias, nonce: Date.now() })}
                    >
                      获取模型列表
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPicker({ mode: 'manual', alias: selected.alias, nonce: Date.now() })}
                    >
                      手动添加
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
                  emptyText="填写 API Key 后获取模型列表"
                />
              </Panel>
            </>
          )}
        </div>
      </div>

      {wizardOpen ? (
        <ProviderWizard
          revision={revision}
          supervised={view.supervised}
          onClose={() => setWizardOpen(false)}
          onRestart={() => restart.mutate()}
        />
      ) : null}

      {picker === null || pickerProvider === null ? null : (
        <ModelPickerDialog
          key={`${picker.mode}-${picker.alias}-${String(picker.nonce)}`}
          mode={picker.mode}
          provider={pickerProvider}
          revision={revision}
          restartPending={providerPendingRestart(restartPaths, picker.alias)}
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
          title={`Edit ${editing.model.id}`}
          description="编辑会替换这个模型在 config.jsonc 里的整条定义；在用模型的改动会等到重启后才生效。"
          initial={modelFormFromConfig(
            editing.model,
            view.providers.find((provider) => provider.alias === editing.alias)?.api ?? 'openai-completions',
          )}
          lockId
          draft={null}
          pending={saveModel.isPending}
          error={saveModel.isError ? writeErrorMessage(saveModel.error) : null}
          onSubmit={(model) => saveModel.mutate({ alias: editing.alias, model })}
        />
      )}

      <ConfirmDialog
        open={deletingModel !== null}
        onOpenChange={(open) => {
          if (!open && !removeModel.isPending) {
            setDeletingModel(null);
          }
        }}
        title="删除这个模型？"
        description={
          deletingModel === null ? '' : `${deletingModel.model} 会从 ${deletingModel.alias} 的 models 列表中移除。`
        }
        confirmText="删除模型"
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
        title="删除这个 Provider？"
        description={
          deletingProvider === null ? '' : `${deletingProvider.alias} 及其模型列表会从 config.jsonc 中移除。`
        }
        confirmText="删除 Provider"
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

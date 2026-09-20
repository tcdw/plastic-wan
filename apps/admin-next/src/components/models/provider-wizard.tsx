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

type WizardStep = 'connection' | 'credentials' | 'models' | 'saved';

const STEP_TITLES: Record<WizardStep, string> = {
  connection: '连接',
  credentials: '凭据',
  models: '模型',
  saved: '完成',
};

/**
 * New-provider wizard: connection → credentials → models → saved. The model
 * list is never prefilled (C8): it comes from the provider's own listing with
 * the key that was just typed, or from ids the admin enters by hand.
 */
export function ProviderWizard({
  revision,
  supervised,
  onClose,
  onRestart,
}: {
  readonly revision: string;
  readonly supervised: boolean;
  readonly onClose: () => void;
  readonly onRestart: () => void;
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
  const [savedPaths, setSavedPaths] = useState<readonly string[]>([]);
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
        throw new Error('需要先填写 API Key');
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
        throw new Error('至少输入一个模型 id');
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
      setSavedPaths(result.apply.restart_required);
      setStep('saved');
      write.succeeded(result.apply);
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
          <DialogTitle>新建 Provider（{STEP_TITLES[step]}）</DialogTitle>
          <DialogDescription>Provider 的新增与连接字段保存后需要重启服务端才会生效。</DialogDescription>
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
                    <SelectItem value="builtin">builtin（使用 Pi 的内置供应商）</SelectItem>
                    <SelectItem value="custom">custom（自定义中转站）</SelectItem>
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
                  字母开头，只含字母、数字、下划线和连字符（≤64 字符）。alias 建立后不可改名。
                </p>
                {alias.length > 0 && !aliasValid ? (
                  <p className="text-destructive text-sm">alias 不符合字符集要求</p>
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
                        <SelectValue placeholder="选择一个内置供应商" />
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
                      <p className="text-muted-foreground text-xs">base_url 必须已包含版本路径，例如 /v1beta。</p>
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
                  面板只能写入明文；这里填的 Key 用于随后拉取模型列表，并写进配置文件。
                </p>
              </div>
              {kind === 'custom' ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Headers（可选）</p>
                  <HeaderFields rows={headers} onChange={setHeaders} valuesRequired={false} idPrefix="wizard" />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 'models' ? (
            <div className="space-y-4">
              <p className="text-muted-foreground text-xs">
                新 Provider 在重启前不在运行中的 registry 里，所以拉取列表用临时模式（使用上面填的 Key）。
                没有任何预置模型清单：只有你选中的模型才会写进配置。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={fetchPending}
                  onClick={() => {
                    discover.mutate();
                  }}
                >
                  {fetchPending ? '获取中…' : '获取模型列表'}
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-ids">或者手填模型 id（每行一个，或用逗号分隔）</Label>
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
                  获取元数据
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
                    emptyText="没有匹配的模型。"
                  />
                  <p className="text-muted-foreground text-xs">
                    已选 {formatNumber(selection.selectedCount)} 个
                    {selection.unresolved.length === 0
                      ? ''
                      : ` · ${selection.unresolved.map((draft) => draft.id).join(', ')} 还有需确认的字段，请先点「编辑」填写`}
                  </p>
                </>
              )}
            </div>
          ) : null}

          {step === 'saved' ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">已保存，待重启</p>
              <p className="text-muted-foreground text-xs">
                新的 Provider 只有重启服务端之后才会进入 registry：
                {savedPaths.length === 0 ? '（没有待重启字段）' : <MonoValue value={savedPaths.join(', ')} />}
              </p>
              {supervised ? (
                <Button type="button" onClick={onRestart}>
                  立即重启
                </Button>
              ) : (
                <p className="text-muted-foreground text-xs">
                  部署方未声明进程监督（PLASTICWAN_SUPERVISED=1），请手动重启服务端。
                </p>
              )}
            </div>
          ) : null}

          {createError === null ? null : <p className="text-destructive text-sm break-words">{createError}</p>}
        </div>

        <DialogFooter>
          {step === 'saved' ? (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
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
                  {create.isPending ? 'Saving…' : '创建 Provider'}
                </Button>
              ) : null}
            </>
          )}
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
          title={`确认 ${editing.id}`}
          description="字段值来自 Provider 列表或 models.dev；标了「需确认」的字段必须由你确认或改写。"
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

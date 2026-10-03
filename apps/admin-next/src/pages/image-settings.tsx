import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/layout/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getImageConfig,
  getImageModelCatalog,
  getImageModelEndpoints,
  getImageStatus,
  type ImageConfigView,
  type ImageModelConfig,
  putImageConfig,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';

const selectClass =
  'h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-ring disabled:opacity-50';

export default function ImageSettingsPage() {
  const config = useQuery({ queryKey: ['image-config'], queryFn: getImageConfig });
  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus });
  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">图片生成设置</h1>
        <p className="text-muted-foreground text-sm">
          当前状态：
          {status.isPending ? '加载中…' : status.isError ? '读取失败' : status.data.enabled ? '已启用' : '已禁用'}
          。保存后立即生效，无需重启。
        </p>
      </div>
      {config.isPending ? (
        <p className="text-muted-foreground text-sm">正在读取配置…</p>
      ) : config.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{errorMessage(config.error)}</p>
          <Button variant="outline" onClick={() => void config.refetch()}>
            重新加载
          </Button>
        </div>
      ) : (
        <ImageSettingsForm key={config.data.revision} initial={config.data} />
      )}
    </div>
  );
}

function ImageSettingsForm({ initial }: { initial: ImageConfigView }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const credentialNames = [...new Set([...initial.credentials, ...initial.models.map((model) => model.credentialRef)])];
  const [credentials, setCredentials] = useState(() =>
    (credentialNames.length > 0 ? credentialNames : ['openrouter']).map((name) => ({
      key: crypto.randomUUID(),
      name,
      secret: '',
      saved: initial.credentials.includes(name),
      source: initial.credentials.includes(name)
        ? ''
        : initial.credential_providers.includes(name)
          ? name
          : initial.credential_providers.length === 1
            ? (initial.credential_providers[0] ?? '')
            : '',
    })),
  );
  const [models, setModels] = useState(() => [
    ...new Map(initial.models.map((model) => [JSON.stringify(model), model])).values(),
  ]);
  const mergedDuplicates = initial.models.length - new Set(initial.models.map((model) => JSON.stringify(model))).size;
  const [search, setSearch] = useState('');
  const [modelId, setModelId] = useState('');
  const [providerTag, setProviderTag] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const catalog = useQuery({
    queryKey: ['image-model-catalog'],
    queryFn: getImageModelCatalog,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const endpoints = useQuery({
    queryKey: ['image-model-endpoints', modelId],
    queryFn: () => getImageModelEndpoints(modelId),
    enabled: enabled && modelId !== '',
    staleTime: 5 * 60_000,
    retry: false,
  });
  const selectedModel = catalog.data?.models.find((model) => model.id === modelId);
  const availableEndpoints = endpoints.data?.endpoints ?? [];
  const selectedEndpoint =
    availableEndpoints.find((endpoint) => endpoint.providerTag === providerTag) ??
    availableEndpoints.find((endpoint) => endpoint.unavailableReason === null);
  const selectedCredential = credentialRef || credentials[0]?.name || '';
  const visibleModels =
    catalog.data?.models.filter(
      (model) =>
        model.id === modelId || `${model.name} ${model.id}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const alreadyAdded = models.some(
    (model) => model.upstreamModel === modelId && model.providerTag === selectedEndpoint?.providerTag,
  );
  const editedCredentials = credentials.filter(
    (entry) => entry.saved || entry.name.trim() || entry.secret.trim() || entry.source,
  );
  const invalidName = editedCredentials.find((entry) => !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name));
  const missingKey = editedCredentials.find((entry) => !entry.saved && !entry.secret.trim() && !entry.source);
  const missingReference = models.find(
    (model) => !editedCredentials.some((entry) => entry.name === model.credentialRef),
  );
  const validationError = !enabled
    ? null
    : models.length === 0
      ? '请先选择模型并点击「添加所选模型」'
      : new Set(models.map((model) => model.id)).size !== models.length
        ? '模型 ID 重复，请移除重复的模型条目'
        : invalidName
          ? '凭据名称只能包含字母、数字、下划线或短横线，长度为 1–80 个字符'
          : new Set(editedCredentials.map((entry) => entry.name)).size !== editedCredentials.length
            ? '凭据名称重复，请改名或移除重复条目'
            : missingReference
              ? `模型 ${missingReference.name} 的凭据 ${missingReference.credentialRef} 尚未配置`
              : missingKey
                ? `凭据 ${missingKey.name} 尚未配置 API key，请输入密钥或选择已有的 OpenRouter 凭据`
                : null;

  const save = useMutation({
    mutationFn: () => {
      if (validationError !== null) {
        throw new Error(validationError);
      }
      return putImageConfig(
        {
          enabled,
          ...(enabled
            ? {
                credentials: Object.fromEntries(
                  editedCredentials
                    .filter((entry) => entry.secret.trim() !== '')
                    .map((entry) => [entry.name, entry.secret.trim()]),
                ),
                credential_sources: Object.fromEntries(
                  editedCredentials
                    .filter((entry) => entry.source !== '' && entry.secret.trim() === '')
                    .map((entry) => [entry.name, entry.source]),
                ),
                models,
              }
            : {}),
        },
        initial.revision,
      );
    },
    onSuccess: async (result) => {
      toast.success(result.enabled ? '图片生成配置已应用' : '图片生成已禁用');
      setCredentials((current) => current.map((entry) => ({ ...entry, secret: '' })));
      await Promise.all(
        ['image-config', 'image-status', 'providers', 'config-status'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  function addModel() {
    if (!selectedModel || !selectedEndpoint || selectedEndpoint.unavailableReason !== null || alreadyAdded) {
      return;
    }
    setModels((current) => [
      ...current,
      {
        id: selectedEndpoint.id,
        name: selectedModel.name,
        provider: 'openrouter',
        upstreamModel: selectedModel.id,
        credentialRef: selectedCredential,
        providerTag: selectedEndpoint.providerTag,
        capabilities: selectedEndpoint.capabilities,
      },
    ]);
    setModelId('');
    setProviderTag('');
    setSearch('');
  }

  return (
    <div className="space-y-6">
      <Panel title="启用与凭据">
        <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
          <div className="flex items-center gap-3">
            <input
              id="image-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4"
            />
            <Label htmlFor="image-enabled">启用图片生成</Label>
          </div>
          {enabled && (
            <>
              <p className="text-muted-foreground text-sm">
                可复用已保存的 OpenRouter 凭据，或输入新的 API key。已有图片凭据留空即可沿用。
              </p>
              {credentials.map((entry, index) => (
                <div key={entry.key} className="grid gap-3 sm:grid-cols-[160px_1fr]">
                  <div className="space-y-2">
                    <Label htmlFor={`credential-name-${index}`}>凭据名称</Label>
                    <Input
                      id={`credential-name-${index}`}
                      value={entry.name}
                      disabled={entry.saved || models.some((model) => model.credentialRef === entry.name)}
                      onChange={(event) =>
                        setCredentials((current) =>
                          current.map((item) =>
                            item.key === entry.key ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    {!entry.saved && initial.credential_providers.length > 0 && (
                      <div className="space-y-2">
                        <Label htmlFor={`credential-source-${index}`}>密钥来源</Label>
                        <select
                          id={`credential-source-${index}`}
                          className={selectClass}
                          value={entry.source}
                          onChange={(event) =>
                            setCredentials((current) =>
                              current.map((item) =>
                                item.key === entry.key ? { ...item, source: event.target.value, secret: '' } : item,
                              ),
                            )
                          }
                        >
                          <option value="">输入新的 API key</option>
                          {initial.credential_providers.map((alias) => (
                            <option key={alias} value={alias}>
                              使用已保存的 {alias} 凭据
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {entry.source === '' && (
                      <>
                        <Label htmlFor={`credential-key-${index}`}>API key</Label>
                        <Input
                          id={`credential-key-${index}`}
                          type="password"
                          autoComplete="new-password"
                          placeholder={
                            initial.credentials.includes(entry.name) ? '已配置，留空沿用' : '输入 OpenRouter API key'
                          }
                          value={entry.secret}
                          onChange={(event) =>
                            setCredentials((current) =>
                              current.map((item) =>
                                item.key === entry.key ? { ...item, secret: event.target.value } : item,
                              ),
                            )
                          }
                        />
                      </>
                    )}
                  </div>
                  {!entry.saved && credentials.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="sm:col-span-2 sm:justify-self-start"
                      disabled={models.some((model) => model.credentialRef === entry.name)}
                      onClick={() => setCredentials((current) => current.filter((item) => item.key !== entry.key))}
                    >
                      移除凭据
                    </Button>
                  )}
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setCredentials((current) => [
                    ...current,
                    { key: crypto.randomUUID(), name: '', secret: '', saved: false, source: '' },
                  ])
                }
              >
                添加凭据
              </Button>
            </>
          )}
        </fieldset>
      </Panel>
      {enabled && (
        <Panel
          title="图片模型"
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={catalog.isFetching || save.isPending}
              onClick={() => {
                void catalog.refetch();
                if (modelId) {
                  void endpoints.refetch();
                }
              }}
            >
              {catalog.isFetching ? '获取中…' : '刷新模型列表'}
            </Button>
          }
        >
          <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
            <p className="text-muted-foreground text-sm">
              从 OpenRouter 实时目录选择，名称、供应商和支持的参数会自动填好。
            </p>
            {catalog.isError && (
              <p role="alert" className="text-destructive text-sm">
                模型列表获取失败：{errorMessage(catalog.error)}。请点击刷新重试。
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="image-model-search">搜索模型</Label>
              <Input
                id="image-model-search"
                placeholder="输入模型名称或 ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-model-select">OpenRouter 图片模型</Label>
              <select
                id="image-model-select"
                className={selectClass}
                value={modelId}
                disabled={catalog.isPending || visibleModels.length === 0}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setProviderTag('');
                }}
              >
                <option value="">
                  {catalog.isPending ? '正在获取模型…' : visibleModels.length === 0 ? '没有匹配的模型' : '请选择模型'}
                </option>
                {visibleModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.id})
                  </option>
                ))}
              </select>
            </div>
            {modelId && (
              <div className="space-y-3">
                {endpoints.isPending ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    正在读取供应商与模型能力…
                  </p>
                ) : endpoints.isError ? (
                  <div role="alert" className="space-y-2">
                    <p className="text-destructive text-sm">供应商信息获取失败：{errorMessage(endpoints.error)}</p>
                    <Button size="sm" variant="outline" onClick={() => void endpoints.refetch()}>
                      重试供应商查询
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="image-provider-select">供应商</Label>
                      <select
                        id="image-provider-select"
                        className={selectClass}
                        value={selectedEndpoint?.providerTag ?? ''}
                        onChange={(event) => setProviderTag(event.target.value)}
                      >
                        {!selectedEndpoint && <option value="">暂无可用供应商</option>}
                        {availableEndpoints.map((endpoint) => (
                          <option
                            key={endpoint.providerTag}
                            value={endpoint.providerTag}
                            disabled={endpoint.unavailableReason !== null}
                          >
                            {endpoint.providerName}
                          </option>
                        ))}
                      </select>
                    </div>
                    {selectedEndpoint ? (
                      <ModelCapabilities capabilities={selectedEndpoint.capabilities} />
                    ) : (
                      <p role="status" className="text-muted-foreground text-sm">
                        {availableEndpoints[0]?.unavailableReason ?? '该模型当前没有可用供应商，请选择其他模型'}
                      </p>
                    )}
                  </>
                )}
                {credentials.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="image-credential-select">使用凭据</Label>
                    <select
                      id="image-credential-select"
                      className={selectClass}
                      value={selectedCredential}
                      onChange={(event) => setCredentialRef(event.target.value)}
                    >
                      {credentials
                        .filter((entry) => entry.name !== '')
                        .map((entry) => (
                          <option key={entry.key}>{entry.name}</option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            <Button
              variant="outline"
              disabled={
                !selectedModel ||
                !selectedEndpoint ||
                selectedEndpoint.unavailableReason !== null ||
                !selectedCredential ||
                alreadyAdded ||
                models.length >= 64
              }
              onClick={addModel}
            >
              {alreadyAdded ? '此模型和供应商已添加' : '添加所选模型'}
            </Button>
            {mergedDuplicates > 0 && (
              <p className="text-muted-foreground text-sm">
                已合并 {mergedDuplicates} 个完全相同的旧模型条目，保存后生效
              </p>
            )}
            {models.length === 0 ? (
              <p className="text-muted-foreground text-sm">尚未添加模型，请至少选择一个</p>
            ) : (
              <ul className="space-y-5">
                {models.map((model) => (
                  <li key={JSON.stringify(model)} className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">{model.name}</p>
                        <p className="text-muted-foreground break-all text-xs">
                          {model.upstreamModel} · {model.providerTag} · 凭据 {model.credentialRef}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`移除 ${model.name}`}
                        onClick={() => setModels((current) => current.filter((item) => item !== model))}
                      >
                        移除
                      </Button>
                    </div>
                    <ModelCapabilities capabilities={model.capabilities} />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </Panel>
      )}
      {validationError && (
        <p id="image-save-requirements" role="status" className="text-sm text-muted-foreground">
          {validationError}
        </p>
      )}
      {save.isError && validationError === null && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(save.error)}
        </p>
      )}
      <Button
        onClick={() => {
          if (validationError !== null) {
            toast.error(validationError);
            return;
          }
          save.mutate();
        }}
        aria-describedby={validationError ? 'image-save-requirements' : undefined}
        disabled={save.isPending}
      >
        {save.isPending ? '保存中…' : '保存并应用'}
      </Button>
    </div>
  );
}

function ModelCapabilities({ capabilities }: { capabilities: ImageModelConfig['capabilities'] }) {
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      {capabilities.imageInput ? `最多 ${capabilities.maxInputImages} 张参考图` : '仅文字生图'} · 最多{' '}
      {capabilities.maxOutputs} 张输出
      <br />
      比例：{capabilities.aspectRatios.map((value) => (value === 'auto' ? '自动' : value)).join('、')}
      {' · '}质量：
      {capabilities.resolutionClasses
        .map((value) => ({ auto: '自动', low: '低', medium: '中', high: '高' })[value] ?? value)
        .join('、')}
    </p>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getImageStatus, putImageConfig } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { providersQuery } from '@/lib/queries';

/**
 * The image capability switch. Enable writes the `image` section (plaintext
 * credentials go into the key jar, the file keeps SecretRef names) and applies
 * through the reloader, so enabling and disabling never restart the process.
 */

interface ModelDraft {
  key: string;
  id: string;
  name: string;
  provider: string;
  upstream_model: string;
  credential_ref: string;
  provider_tag: string;
}

let draftSequence = 0;

function draftKey(): string {
  draftSequence += 1;
  return `draft-${draftSequence}`;
}

function emptyModel(): ModelDraft {
  return {
    key: draftKey(),
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    provider: 'openrouter',
    upstream_model: 'openai/gpt-image-1',
    credential_ref: 'openrouter',
    provider_tag: 'openai',
  };
}

function toCapabilityBlock() {
  return {
    imageInput: true,
    maxInputImages: 2,
    maxOutputs: 4,
    aspectRatios: ['auto', '1:1'],
    resolutionClasses: ['auto', 'high'],
  };
}

export default function ImageSettingsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus });
  const providers = useQuery({ ...providersQuery });
  const revision = providers.data?.revision ?? '';
  const [enabled, setEnabled] = useState(true);
  const [credentials, setCredentials] = useState<{ key: string; name: string; secret: string }[]>([
    { key: draftKey(), name: 'openrouter', secret: '' },
  ]);
  const [models, setModels] = useState<ModelDraft[]>([emptyModel()]);

  const save = useMutation({
    mutationFn: () => {
      const credentialMap: Record<string, string> = {};
      for (const entry of credentials) {
        if (entry.name.length > 0 && entry.secret.length > 0) {
          credentialMap[entry.name] = entry.secret;
        }
      }
      return putImageConfig(
        {
          enabled,
          ...(enabled
            ? {
                credentials: credentialMap,
                models: models.map((model) => ({
                  id: model.id,
                  name: model.name,
                  provider: model.provider,
                  upstreamModel: model.upstream_model,
                  credentialRef: model.credential_ref,
                  providerTag: model.provider_tag,
                  capabilities: toCapabilityBlock(),
                })),
              }
            : {}),
        },
        revision,
      );
    },
    onSuccess: (result) => {
      toast.success(result.enabled ? '图片生成已启用（热应用）' : '图片生成已禁用（热应用）');
      queryClient.invalidateQueries({ queryKey: ['image-status'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const statusEnabled = status.data?.enabled ?? false;

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">图片生成设置</h1>
      <p className="text-muted-foreground text-sm">
        当前状态：{status.isLoading ? '加载中…' : statusEnabled ? '已启用' : '已禁用'}
        。启用与禁用即时热应用，不需要重启。
      </p>
      <div className="space-y-3 rounded border p-4">
        <div className="flex items-center gap-2">
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
            <div className="space-y-2">
              <div className="text-sm font-medium">凭据（明文只写入 key jar，配置文件仅保留引用）</div>
              {credentials.map((entry) => (
                <div key={entry.key} className="grid grid-cols-[160px_1fr] gap-2">
                  <Input
                    value={entry.name}
                    placeholder="名称"
                    onChange={(event) =>
                      setCredentials((current) =>
                        current.map((item) => (item.key === entry.key ? { ...item, name: event.target.value } : item)),
                      )
                    }
                  />
                  <Input
                    type="password"
                    value={entry.secret}
                    placeholder="API key（留空表示沿用 jar 中已有值）"
                    onChange={(event) =>
                      setCredentials((current) =>
                        current.map((item) =>
                          item.key === entry.key ? { ...item, secret: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCredentials((current) => [...current, { key: draftKey(), name: '', secret: '' }])}
              >
                + 添加凭据
              </Button>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">模型</div>
              {models.map((model) => (
                <div key={model.key} className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ['id', '模型 ID'],
                      ['name', '显示名'],
                      ['provider', 'Provider'],
                      ['upstream_model', '上游模型'],
                      ['credential_ref', '凭据引用'],
                      ['provider_tag', 'Provider Tag'],
                    ] as const
                  ).map(([field, label]) => (
                    <div key={field} className="space-y-1">
                      <Label className="text-xs">{label}</Label>
                      <Input
                        value={model[field]}
                        onChange={(event) =>
                          setModels((current) =>
                            current.map((item) =>
                              item.key === model.key ? { ...item, [field]: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setModels((current) => [...current, emptyModel()])}>
                + 添加模型
              </Button>
            </div>
          </>
        )}
        <Button onClick={() => save.mutate()} disabled={save.isPending || revision === ''}>
          {save.isPending ? '保存中…' : '保存并应用'}
        </Button>
      </div>
    </div>
  );
}

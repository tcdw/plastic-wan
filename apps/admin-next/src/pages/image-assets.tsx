import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { type ColumnSpec, ConfirmDialog, TableShell } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  archiveImageAsset,
  archiveImagePrompt,
  createImagePrompt,
  type ImageAssetInfo,
  type ImagePromptAsset,
  imageUrl,
  listImageAssets,
  listImagePrompts,
  uploadImageAsset as uploadAsset,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';

/** Asset management: prompt templates and reference images, with upload and archive. */

function PromptEditor({ onDone }: { readonly onDone: () => void }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const create = useMutation({
    mutationFn: () => createImagePrompt({ name, body }),
    onSuccess: () => {
      toast.success('素材已创建');
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  return (
    <div className="space-y-2 rounded border p-3">
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="素材名称" />
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={4}
        placeholder="素材正文（不支持 {{ 嵌套）"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => create.mutate()}
          disabled={create.isPending || name.trim() === '' || body.trim() === ''}
        >
          创建
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  );
}

export default function ImageAssetsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'prompts' | 'images'>('prompts');
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<{ kind: 'prompt' | 'image'; id: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const prompts = useQuery({ queryKey: ['image-assets', 'prompts'], queryFn: () => listImagePrompts({ limit: 60 }) });
  const assets = useQuery({ queryKey: ['image-assets', 'images'], queryFn: () => listImageAssets({ limit: 60 }) });

  const archive = useMutation({
    mutationFn: async () => {
      if (archiving === null) {
        return;
      }
      return archiving.kind === 'prompt' ? archiveImagePrompt(archiving.id) : archiveImageAsset(archiving.id);
    },
    onSuccess: () => {
      toast.success('已归档');
      setArchiving(null);
      queryClient.invalidateQueries({ queryKey: ['image-assets'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const base64 = btoa(binary);
      const mime = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
      return uploadAsset({ name: file.name, base64, mime });
    },
    onSuccess: () => {
      toast.success('已上传');
      queryClient.invalidateQueries({ queryKey: ['image-assets'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const promptColumns: readonly ColumnSpec<ImagePromptAsset>[] = [
    { key: 'name', title: '名称', render: (row) => <span className="font-medium">{row.name}</span> },
    { key: 'category', title: '分类', render: (row) => row.category },
    { key: 'updated', title: '更新时间', render: (row) => formatTime(row.updated_at) },
  ];
  const assetColumns: readonly ColumnSpec<ImageAssetInfo>[] = [
    {
      key: 'preview',
      title: '预览',
      render: (row) => (
        <img src={imageUrl(row.id)} alt={row.name} className="bg-muted h-10 w-10 rounded object-cover" />
      ),
    },
    { key: 'name', title: '名称', render: (row) => <span className="font-medium">{row.name}</span> },
    { key: 'source', title: '来源', render: (row) => row.source },
    { key: 'created', title: '创建时间', render: (row) => formatTime(row.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">生图资产</h1>
        <div className="flex gap-2">
          {tab === 'images' && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) {
                    upload.mutate(file);
                    event.target.value = '';
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileInput.current?.click()}
                disabled={upload.isPending}
              >
                {upload.isPending ? '上传中…' : '上传图片'}
              </Button>
            </>
          )}
          {tab === 'prompts' && (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              新建素材
            </Button>
          )}
          <div className="bg-muted flex rounded p-0.5 text-sm">
            <button
              type="button"
              className={`rounded px-3 py-1 ${tab === 'prompts' ? 'bg-background font-medium' : ''}`}
              onClick={() => setTab('prompts')}
            >
              Prompt 素材
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1 ${tab === 'images' ? 'bg-background font-medium' : ''}`}
              onClick={() => setTab('images')}
            >
              图片
            </button>
          </div>
        </div>
      </div>

      {creating && tab === 'prompts' && (
        <PromptEditor
          onDone={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['image-assets'] });
          }}
        />
      )}

      {tab === 'prompts' ? (
        <TableShell
          columns={promptColumns}
          data={prompts.data?.items ?? []}
          rowKey={(row) => row.id}
          emptyText={prompts.isLoading ? '加载中…' : '暂无 Prompt 素材'}
          expandedRender={(row) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setArchiving({ kind: 'prompt', id: row.id, name: row.name })}
            >
              归档
            </Button>
          )}
        />
      ) : (
        <TableShell
          columns={assetColumns}
          data={assets.data?.items ?? []}
          rowKey={(row) => row.id}
          emptyText={assets.isLoading ? '加载中…' : '暂无图片'}
          expandedRender={(row) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setArchiving({ kind: 'image', id: row.id, name: row.name })}
            >
              归档
            </Button>
          )}
        />
      )}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setArchiving(null);
          }
        }}
        title={archiving === null ? '' : `归档 ${archiving.name}`}
        description="归档后不再出现在选择列表；已引用它的历史生成不受影响。"
        confirmText="归档"
        pending={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() => archive.mutate()}
      />
    </div>
  );
}

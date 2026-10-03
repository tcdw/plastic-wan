import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const create = useMutation({
    mutationFn: () => createImagePrompt({ name, body }),
    onSuccess: () => {
      toast.success(t('image.assets.createdToast'));
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
  return (
    <div className="space-y-2 rounded border p-3">
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('image.assets.namePlaceholder')}
      />
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={4}
        placeholder={t('image.assets.bodyPlaceholder')}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => create.mutate()}
          disabled={create.isPending || name.trim() === '' || body.trim() === ''}
        >
          {t('common.create')}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

export default function ImageAssetsPage() {
  const { t } = useTranslation();
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
      toast.success(t('image.assets.archivedToast'));
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
      toast.success(t('image.assets.uploadedToast'));
      queryClient.invalidateQueries({ queryKey: ['image-assets'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const promptColumns: readonly ColumnSpec<ImagePromptAsset>[] = [
    {
      key: 'name',
      title: t('image.assets.columnName'),
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'category', title: t('image.assets.columnCategory'), render: (row) => row.category },
    { key: 'updated', title: t('image.assets.columnUpdated'), render: (row) => formatTime(row.updated_at) },
  ];
  const assetColumns: readonly ColumnSpec<ImageAssetInfo>[] = [
    {
      key: 'preview',
      title: t('image.assets.columnPreview'),
      render: (row) => (
        <img src={imageUrl(row.id)} alt={row.name} className="bg-muted h-10 w-10 rounded object-cover" />
      ),
    },
    {
      key: 'name',
      title: t('image.assets.columnName'),
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'source', title: t('image.assets.columnSource'), render: (row) => row.source },
    { key: 'created', title: t('image.assets.columnCreated'), render: (row) => formatTime(row.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('image.assets.title')}</h1>
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
                {upload.isPending ? t('common.uploading') : t('image.assets.uploadImage')}
              </Button>
            </>
          )}
          {tab === 'prompts' && (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              {t('image.assets.newAsset')}
            </Button>
          )}
          <div className="bg-muted flex rounded p-0.5 text-sm">
            <button
              type="button"
              className={`rounded px-3 py-1 ${tab === 'prompts' ? 'bg-background font-medium' : ''}`}
              onClick={() => setTab('prompts')}
            >
              {t('image.assets.tabPrompts')}
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1 ${tab === 'images' ? 'bg-background font-medium' : ''}`}
              onClick={() => setTab('images')}
            >
              {t('image.assets.tabImages')}
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
          emptyText={prompts.isLoading ? t('common.loading') : t('image.assets.emptyPrompts')}
          expandedRender={(row) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setArchiving({ kind: 'prompt', id: row.id, name: row.name })}
            >
              {t('image.assets.archive')}
            </Button>
          )}
        />
      ) : (
        <TableShell
          columns={assetColumns}
          data={assets.data?.items ?? []}
          rowKey={(row) => row.id}
          emptyText={assets.isLoading ? t('common.loading') : t('image.assets.emptyImages')}
          expandedRender={(row) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setArchiving({ kind: 'image', id: row.id, name: row.name })}
            >
              {t('image.assets.archive')}
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
        title={archiving === null ? '' : t('image.assets.archiveConfirmTitle', { name: archiving.name })}
        description={t('image.assets.archiveConfirmDescription')}
        confirmText={t('image.assets.archive')}
        pending={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() => archive.mutate()}
      />
    </div>
  );
}

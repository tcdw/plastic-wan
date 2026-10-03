import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  getImageStatus,
  type ImageGenerationRecord,
  imageUrl,
  listImageAssets,
  listImagePrompts,
  resolveImageGeneration,
  submitImageGeneration,
  uploadImageAsset as uploadAsset,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';

/**
 * The image workspace: compose a generation from prompt and reference
 * assets, preview the resolved snapshot without paying, submit, and watch the
 * outputs land. Output pictures link into the generation audit trail.
 */

const ASPECT_RATIOS = ['auto', '1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'];
const RESOLUTIONS = ['auto', 'low', 'medium', 'high'];

function SelectedRefs({
  title,
  refs,
  onRemove,
}: {
  title: string;
  refs: readonly { readonly id: string; readonly label: string }[];
  onRemove: (id: string) => void;
}) {
  if (refs.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-xs">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {refs.map((reference) => (
          <button
            key={reference.id}
            type="button"
            onClick={() => onRemove(reference.id)}
            className="bg-secondary hover:bg-secondary/80 rounded px-2 py-0.5 text-xs"
          >
            {reference.label} ✕
          </button>
        ))}
      </div>
    </div>
  );
}

function OutputGrid({ generation }: { readonly generation: ImageGenerationRecord }) {
  if (generation.outputs.length === 0) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {generation.outputs.map((output) => (
        <a key={output.id} href={imageUrl(output.id)} target="_blank" rel="noreferrer" className="group block">
          <img
            src={imageUrl(output.id)}
            alt={output.name}
            className="bg-muted aspect-square w-full rounded object-cover"
          />
          <div className="text-muted-foreground mt-1 truncate text-xs">{output.name}</div>
        </a>
      ))}
    </div>
  );
}

export default function ImageGeneratePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [resolution, setResolution] = useState('auto');
  const [outputCount, setOutputCount] = useState(1);
  const [promptRefs, setPromptRefs] = useState<{ id: string; label: string }[]>([]);
  const [imageRefs, setImageRefs] = useState<{ id: string; label: string }[]>([]);
  const [resolved, setResolved] = useState<string | null>(null);
  const [pending, setPending] = useState<ImageGenerationRecord | null>(null);

  const status = useQuery({ queryKey: ['image-status'], queryFn: getImageStatus, staleTime: 10_000 });
  const prompts = useQuery({
    queryKey: ['image-prompts-picker'],
    queryFn: () => listImagePrompts({ limit: 50 }),
  });
  const assets = useQuery({ queryKey: ['image-assets-picker'], queryFn: () => listImageAssets({ limit: 50 }) });

  const resolvePreview = useMutation({
    mutationFn: () =>
      resolveImageGeneration({
        prompt,
        model_id: modelId === '' ? undefined : modelId,
        aspect_ratio: aspectRatio,
        resolution,
        output_count: outputCount,
        prompt_refs: promptRefs.map((reference) => reference.id),
        input_image_refs: imageRefs.map((reference) => reference.id),
      }),
    onSuccess: (snapshot) => {
      const record = snapshot as { resolvedPrompt?: string; finalPrompt?: string };
      setResolved(record.finalPrompt ?? record.resolvedPrompt ?? JSON.stringify(snapshot));
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const submit = useMutation({
    mutationFn: () =>
      submitImageGeneration({
        prompt,
        model_id: modelId === '' ? undefined : modelId,
        aspect_ratio: aspectRatio,
        resolution,
        output_count: outputCount,
        prompt_refs: promptRefs.map((reference) => reference.id),
        input_image_refs: imageRefs.map((reference) => reference.id),
        idempotency_key: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    onSuccess: ({ generation, replayed }) => {
      toast.success(replayed ? t('image.generate.replayedToast') : t('image.generate.submittedToast'));
      setPending(generation);
      queryClient.invalidateQueries({ queryKey: ['image-generations'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const mime = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
      return uploadAsset({ name: file.name, base64, mime });
    },
    onSuccess: (asset) => {
      toast.success(t('image.generate.uploadedToast', { name: asset.name }));
      queryClient.invalidateQueries({ queryKey: ['image-assets-picker'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  if (status.data !== undefined && !status.data.enabled) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">{t('image.generate.title')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('image.generate.disabledIntro')}
          <Link to="/image-settings" className="underline">
            {t('image.generate.disabledLink')}
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="image-prompt">{t('image.generate.promptLabel')}</Label>
          <Textarea
            id="image-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            placeholder={t('image.generate.promptPlaceholder', {
              promptRef: '{{prompt:…}}',
              imageRef: '{{image:…}}',
            })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label>{t('image.generate.model')}</Label>
            <select
              className="border-input bg-background w-full rounded border px-2 py-1.5 text-sm"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">{t('image.generate.defaultModelOption')}</option>
              {status.data?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>{t('image.generate.aspectRatio')}</Label>
            <select
              className="border-input bg-background w-full rounded border px-2 py-1.5 text-sm"
              value={aspectRatio}
              onChange={(event) => setAspectRatio(event.target.value)}
            >
              {ASPECT_RATIOS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>{t('image.generate.quality')}</Label>
            <select
              className="border-input bg-background w-full rounded border px-2 py-1.5 text-sm"
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
            >
              {RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>{t('image.generate.count')}</Label>
            <Input
              type="number"
              min={1}
              max={4}
              value={outputCount}
              onChange={(event) => setOutputCount(Math.min(4, Math.max(1, Number(event.target.value) || 1)))}
            />
          </div>
        </div>
        <div className="space-y-3 rounded border p-3">
          <SelectedRefs
            title={t('image.generate.selectedPromptRefs')}
            refs={promptRefs}
            onRemove={(id) => setPromptRefs((current) => current.filter((entry) => entry.id !== id))}
          />
          <SelectedRefs
            title={t('image.generate.selectedImageRefs')}
            refs={imageRefs}
            onRemove={(id) => setImageRefs((current) => current.filter((entry) => entry.id !== id))}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">{t('image.generate.promptAssets')}</div>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                {prompts.data?.items.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="bg-secondary hover:bg-secondary/80 rounded px-2 py-0.5 text-xs"
                    onClick={() =>
                      setPromptRefs((current) =>
                        current.some((reference) => reference.id === entry.id)
                          ? current
                          : [...current, { id: entry.id, label: entry.name }],
                      )
                    }
                  >
                    {t('image.generate.addAssetRef', { name: entry.name })}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">{t('image.generate.referenceImages')}</div>
              <div className="flex flex-wrap gap-2">
                {assets.data?.items.slice(0, 8).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    title={t('image.generate.addAssetRef', { name: entry.name })}
                    className="hover:ring-primary rounded ring-offset-2"
                    onClick={() =>
                      setImageRefs((current) =>
                        current.some((reference) => reference.id === entry.id)
                          ? current
                          : [...current, { id: entry.id, label: entry.name }],
                      )
                    }
                  >
                    <img
                      src={imageUrl(entry.id)}
                      alt={entry.name}
                      className="bg-muted h-10 w-10 rounded object-cover"
                    />
                  </button>
                ))}
              </div>
              <div>
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
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? t('common.uploading') : t('image.generate.uploadReference')}
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={() => submit.mutate()} disabled={submit.isPending || prompt.trim() === ''}>
            {submit.isPending ? t('common.submitting') : t('image.generate.generate')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => resolvePreview.mutate()}
            disabled={resolvePreview.isPending || prompt.trim() === ''}
          >
            {resolvePreview.isPending ? t('image.generate.resolving') : t('image.generate.resolvePreview')}
          </Button>
        </div>
        {resolved !== null && (
          <div className="bg-muted space-y-1 rounded p-3">
            <div className="text-muted-foreground text-xs">{t('image.generate.resolvedPromptLabel')}</div>
            <pre className="text-xs whitespace-pre-wrap">{resolved}</pre>
          </div>
        )}
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t('image.generate.outputsTitle')}</h2>
          {pending !== null && (
            <Link
              to="/image-generations/$generationId"
              params={{ generationId: pending.id }}
              className="text-xs underline"
            >
              {t('image.generate.auditDetail')}
            </Link>
          )}
        </div>
        {pending === null ? (
          <p className="text-muted-foreground text-sm">{t('image.generate.outputsPlaceholder')}</p>
        ) : (
          <OutputGrid generation={pending} />
        )}
      </div>
    </div>
  );
}

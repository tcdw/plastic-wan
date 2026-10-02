import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { toast } from 'sonner';
import { KvList, MonoValue, StateBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { getImageGeneration, imageUrl, retryImageGeneration } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatTime } from '@/lib/format';

/** One generation: intent snapshot, per-item attempts, outputs, and error. */

function GenerationDetail({ id }: { readonly id: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['image-generation', id],
    queryFn: () => getImageGeneration(id),
    refetchInterval: (latest) => {
      const status = latest.state.data?.status;
      return status === 'queued' || status === 'running' ? 3000 : false;
    },
  });
  const retry = useMutation({
    mutationFn: () => retryImageGeneration(id),
    onSuccess: ({ generation }) => {
      toast.success(`已重新提交：${generation.id.slice(0, 8)}…`);
      void queryClient.invalidateQueries({ queryKey: ['image-generation', id] });
      void queryClient.invalidateQueries({ queryKey: ['image-generations'] });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  if (query.isLoading) {
    return <p className="text-muted-foreground text-sm">加载中…</p>;
  }
  if (query.data === undefined) {
    return <p className="text-muted-foreground text-sm">生成不存在。</p>;
  }
  const record = query.data;
  const settled = record.status !== 'queued' && record.status !== 'running';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-lg">{record.id.slice(0, 8)}…</h1>
          <StateBadge state={record.status} />
        </div>
        {settled && (
          <Button size="sm" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? '提交中…' : '重试'}
          </Button>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <KvList
          items={[
            { label: 'Generation ID', value: <MonoValue value={record.id} /> },
            { label: '模型', value: record.snapshot.authored.modelId },
            {
              label: '比例 / 质量',
              value: `${record.snapshot.authored.aspectRatio} · ${record.snapshot.authored.resolution}`,
            },
            { label: '输出数', value: `${record.outputs.length}/${record.snapshot.authored.outputCount}` },
            { label: '来源', value: `${record.source} · ${record.actorName}` },
            { label: '提交时间', value: formatTime(record.createdAt) },
            { label: '完成时间', value: record.finishedAt === null ? '—' : formatTime(record.finishedAt) },
            {
              label: '引用',
              value:
                record.snapshot.promptAssets.length + record.snapshot.imageAssets.length === 0 ? (
                  '—'
                ) : (
                  <span>
                    {record.snapshot.promptAssets.map((asset) => (
                      <span key={asset.id} className="mr-1 inline-block">
                        prompt:{asset.name}
                      </span>
                    ))}
                    {record.snapshot.imageAssets.map((asset) => (
                      <span key={asset.id} className="mr-1 inline-block">
                        image:{asset.name}
                      </span>
                    ))}
                  </span>
                ),
            },
          ]}
        />
        {record.error !== null ? (
          <div className="bg-destructive/10 space-y-1 rounded p-3">
            <div className="text-sm font-medium">错误：{record.error.code}</div>
            <p className="text-sm break-words">{record.error.message}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {record.outputs.map((output) => (
              <a key={output.id} href={imageUrl(output.id)} target="_blank" rel="noreferrer">
                <img
                  src={imageUrl(output.id)}
                  alt={output.name}
                  className="bg-muted aspect-square w-full rounded object-cover"
                />
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Attempt 记录</div>
        <div className="space-y-1">
          {record.attempts.map((attempt) => (
            <div key={attempt.id} className="bg-muted/50 flex flex-wrap items-center gap-2 rounded px-3 py-1.5 text-xs">
              <StateBadge state={attempt.status} />
              <span>
                round {attempt.round} · item {attempt.itemIndex}
              </span>
              {attempt.providerRequestId !== null && <MonoValue value={attempt.providerRequestId} />}
              {attempt.usage !== null && (
                <span className="text-muted-foreground">
                  {Object.entries(attempt.usage)
                    .map(([key, value]) => `${key} ${value}`)
                    .join(' · ')}
                </span>
              )}
              {attempt.error !== null && <span className="text-destructive">{attempt.error.message}</span>}
              {attempt.finishedAt !== null && (
                <span className="text-muted-foreground">{formatTime(attempt.finishedAt)}</span>
              )}
            </div>
          ))}
          {record.attempts.length === 0 && <p className="text-muted-foreground text-xs">尚无 attempt。</p>}
        </div>
      </div>
      <div className="bg-muted/50 rounded p-3">
        <div className="text-muted-foreground text-xs">最终 Prompt（已展开引用）</div>
        <pre className="text-xs whitespace-pre-wrap">{record.snapshot.finalPrompt}</pre>
      </div>
    </div>
  );
}

export default function ImageGenerationDetailPage() {
  const { generationId } = useParams({ from: '/image-generations/$generationId' });
  return (
    <div className="space-y-4">
      <Link to="/image-generations" className="text-sm underline">
        ← 返回列表
      </Link>
      <GenerationDetail id={generationId} />
    </div>
  );
}

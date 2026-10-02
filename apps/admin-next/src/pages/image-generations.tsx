import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ColumnSpec, StateBadge, TableShell } from '@/components/business';
import { type ImageGenerationRecord, listImageGenerations } from '@/lib/api';
import { formatTime } from '@/lib/format';

/** Generation audit list: every generation submitted from the panel or the agent. */

function GenerationList() {
  const generations = useQuery({
    queryKey: ['image-generations'],
    queryFn: () => listImageGenerations({ limit: 60 }),
    refetchInterval: (query) => {
      const statuses = query.state.data?.items.map((entry) => entry.status) ?? [];
      return statuses.some((status) => status === 'queued' || status === 'running') ? 3000 : false;
    },
  });

  const columns: readonly ColumnSpec<ImageGenerationRecord>[] = [
    {
      key: 'id',
      title: 'Generation',
      render: (row) => (
        <Link
          to="/image-generations/$generationId"
          params={{ generationId: row.id }}
          className="font-mono text-xs break-all underline-offset-4 hover:underline"
        >
          {row.id.slice(0, 8)}…
        </Link>
      ),
    },
    { key: 'status', title: '状态', render: (row) => <StateBadge state={row.status} /> },
    { key: 'model', title: '模型', render: (row) => row.snapshot.authored.modelId },
    {
      key: 'prompt',
      title: 'Prompt',
      render: (row) => <span className="line-clamp-1 max-w-72 text-xs">{row.snapshot.authored.authoredPrompt}</span>,
    },
    {
      key: 'outputs',
      title: '输出',
      render: (row) => `${row.outputs.length}/${row.snapshot.authored.outputCount}`,
    },
    {
      key: 'source',
      title: '来源',
      render: (row) => `${row.source}${row.actorName === '' ? '' : ` · ${row.actorName}`}`,
    },
    { key: 'created', title: '提交时间', render: (row) => formatTime(row.createdAt) },
  ];

  return (
    <TableShell
      columns={columns}
      data={generations.data?.items ?? []}
      rowKey={(row) => row.id}
      emptyText={generations.isLoading ? '加载中…' : '暂无生成记录'}
    />
  );
}

export default function ImageGenerationsPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">生图记录</h1>
        <Link to="/image-generate" className="text-sm underline">
          新建生成
        </Link>
      </div>
      <GenerationList />
    </div>
  );
}

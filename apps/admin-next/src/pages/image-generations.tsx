import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { type ColumnSpec, StateBadge, TableShell } from '@/components/business';
import { type ImageGenerationRecord, listImageGenerations } from '@/lib/api';
import { formatTime } from '@/lib/format';

/** Generation audit list: every generation submitted from the panel or the agent. */

function GenerationList() {
  const { t } = useTranslation();
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
      title: t('image.generations.columnGeneration'),
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
    { key: 'status', title: t('image.generations.columnStatus'), render: (row) => <StateBadge state={row.status} /> },
    { key: 'model', title: t('image.generations.columnModel'), render: (row) => row.snapshot.authored.modelId },
    {
      key: 'prompt',
      title: t('image.generations.columnPrompt'),
      render: (row) => <span className="line-clamp-1 max-w-72 text-xs">{row.snapshot.authored.authoredPrompt}</span>,
    },
    {
      key: 'outputs',
      title: t('image.generations.columnOutputs'),
      render: (row) => `${row.outputs.length}/${row.snapshot.authored.outputCount}`,
    },
    {
      key: 'source',
      title: t('image.generations.columnSource'),
      render: (row) => `${row.source}${row.actorName === '' ? '' : ` · ${row.actorName}`}`,
    },
    { key: 'created', title: t('image.generations.columnSubmitted'), render: (row) => formatTime(row.createdAt) },
  ];

  return (
    <TableShell
      columns={columns}
      data={generations.data?.items ?? []}
      rowKey={(row) => row.id}
      emptyText={generations.isLoading ? t('common.loading') : t('image.generations.empty')}
    />
  );
}

export default function ImageGenerationsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('image.generations.title')}</h1>
        <Link to="/image-generate" className="text-sm underline">
          {t('image.generations.newGeneration')}
        </Link>
      </div>
      <GenerationList />
    </div>
  );
}

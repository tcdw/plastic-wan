import { createFileRoute } from '@tanstack/react-router';
import MemoriesPage from '@/pages/memories';

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
});

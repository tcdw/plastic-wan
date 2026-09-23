import { createFileRoute } from '@tanstack/react-router';
import ModelsPage from '@/pages/models';

export const Route = createFileRoute('/models')({
  component: ModelsPage,
});

import { createFileRoute } from '@tanstack/react-router';
import ContextsPage from '@/pages/contexts';

export const Route = createFileRoute('/contexts')({
  component: ContextsPage,
});

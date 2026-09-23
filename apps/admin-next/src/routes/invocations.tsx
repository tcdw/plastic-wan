import { createFileRoute } from '@tanstack/react-router';
import InvocationsPage from '@/pages/invocations';

export const Route = createFileRoute('/invocations')({
  component: InvocationsPage,
});

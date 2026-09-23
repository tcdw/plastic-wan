import { createFileRoute } from '@tanstack/react-router';
import { ContextDetailView } from '@/pages/context-detail';

export const Route = createFileRoute('/contexts_/$conversationId')({
  component: ContextDetailRoute,
});

function ContextDetailRoute(): React.ReactElement {
  const { conversationId } = Route.useParams();
  return <ContextDetailView id={conversationId} />;
}

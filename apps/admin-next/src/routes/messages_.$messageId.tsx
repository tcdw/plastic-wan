import { createFileRoute } from '@tanstack/react-router';
import { MessageDetailView } from '@/pages/message-detail';

export const Route = createFileRoute('/messages_/$messageId')({
  component: MessageDetailRoute,
});

function MessageDetailRoute(): React.ReactElement {
  const { messageId } = Route.useParams();
  return <MessageDetailView id={messageId} />;
}

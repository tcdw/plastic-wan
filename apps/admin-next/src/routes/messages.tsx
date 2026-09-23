import { createFileRoute } from '@tanstack/react-router';
import MessagesPage from '@/pages/messages';

export const Route = createFileRoute('/messages')({
  component: MessagesPage,
});

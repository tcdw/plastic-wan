import { createFileRoute } from '@tanstack/react-router';
import ChatsPage from '@/pages/chats';

export const Route = createFileRoute('/chats')({
  component: ChatsPage,
});

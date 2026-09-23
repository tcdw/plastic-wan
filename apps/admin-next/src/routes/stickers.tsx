import { createFileRoute } from '@tanstack/react-router';
import StickersPage from '@/pages/stickers';

export const Route = createFileRoute('/stickers')({
  component: StickersPage,
});

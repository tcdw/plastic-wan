import { createFileRoute } from '@tanstack/react-router';
import ImageGenerationsPage from '@/pages/image-generations';

export const Route = createFileRoute('/image-generations')({
  component: ImageGenerationsPage,
});

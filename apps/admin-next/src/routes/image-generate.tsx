import { createFileRoute } from '@tanstack/react-router';
import ImageGeneratePage from '@/pages/image-generate';

export const Route = createFileRoute('/image-generate')({
  component: ImageGeneratePage,
});

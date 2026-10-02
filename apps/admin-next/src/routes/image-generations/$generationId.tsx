import { createFileRoute } from '@tanstack/react-router';
import ImageGenerationDetailPage from '@/pages/image-generation-detail';

export const Route = createFileRoute('/image-generations/$generationId')({
  component: ImageGenerationDetailPage,
});

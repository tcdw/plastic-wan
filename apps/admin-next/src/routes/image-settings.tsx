import { createFileRoute } from '@tanstack/react-router';
import ImageSettingsPage from '@/pages/image-settings';

export const Route = createFileRoute('/image-settings')({
  component: ImageSettingsPage,
});

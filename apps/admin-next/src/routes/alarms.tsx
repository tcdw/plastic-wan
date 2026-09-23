import { createFileRoute } from '@tanstack/react-router';
import AlarmsPage from '@/pages/alarms';

export const Route = createFileRoute('/alarms')({
  component: AlarmsPage,
});

import { createFileRoute } from '@tanstack/react-router';
import AdminsPage from '@/pages/admins';

export const Route = createFileRoute('/admins')({
  component: AdminsPage,
});

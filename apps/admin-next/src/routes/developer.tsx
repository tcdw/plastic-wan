import { createFileRoute } from '@tanstack/react-router';
import DeveloperPage from '@/pages/developer';

export const Route = createFileRoute('/developer')({ component: DeveloperPage });

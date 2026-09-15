import { useRouterState } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface Crumb {
  title: string;
  link: string;
}

function useBreadcrumbs(): Crumb[] {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [{ title: 'Overview', link: '/' }];
  }

  return segments.map((seg: string, i: number) => {
    const link = `/${segments.slice(0, i + 1).join('/')}`;
    const title = seg.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    return { title, link };
  });
}

export function Breadcrumbs() {
  const items = useBreadcrumbs();
  if (items.length === 0) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {items.map((item: Crumb, index: number) => (
          <Fragment key={item.title}>
            {index !== items.length - 1 && (
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href={item.link}>{item.title}</BreadcrumbLink>
              </BreadcrumbItem>
            )}
            {index < items.length - 1 && (
              <BreadcrumbSeparator className="hidden md:block">
                <ChevronRight className="size-3" />
              </BreadcrumbSeparator>
            )}
            {index === items.length - 1 && <BreadcrumbPage>{item.title}</BreadcrumbPage>}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

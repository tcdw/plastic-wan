import type React from 'react';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * A page area framed by one card: title and optional trailing action. The
 * header keeps a fixed minimum height so panels in the same row start their
 * content on the same line whether or not they carry an action. Content inside
 * must not add another frame — pass `flush` for a table so it runs edge to
 * edge under the header instead of nesting a border.
 */
export function Panel({
  title,
  action,
  flush = false,
  children,
  className,
}: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly flush?: boolean;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <Card className={cn('gap-4', flush && 'overflow-hidden pt-4 pb-0', className)}>
      <div className="flex min-h-9 items-center justify-between gap-3 px-6">
        <CardTitle>{title}</CardTitle>
        {action}
      </div>
      <CardContent className={cn(flush && 'px-0')}>{children}</CardContent>
    </Card>
  );
}

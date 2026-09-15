import { EyeOff } from 'lucide-react';
import type React from 'react';
import { cn } from '@/lib/utils';

/**
 * Marks assistant ordinary text as private reasoning. Assistant messages are
 * never published to Telegram on their own; only a successful `send` tool
 * call publishes a message. Used in the Agent transcript tab and the timeline.
 */

export function PrivateReasoningTag({ className }: { readonly className?: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-300',
        className,
      )}
    >
      <EyeOff className="size-3" />
      Private reasoning
    </span>
  );
}

export function PrivateReasoningNote({ className }: { readonly className?: string }): React.ReactElement {
  return (
    <p className={cn('text-muted-foreground text-xs', className)}>
      Assistant text is private reasoning and is never sent to Telegram directly — only a successful{' '}
      <code className="rounded bg-muted px-1 font-mono text-[0.7rem]">send</code> tool call publishes a message.
    </p>
  );
}

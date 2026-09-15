import type React from 'react';
import { stateColor } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * State badge: maps the previous panel's color names onto semantic variants
 * for the new UI. The state → color table stays in `lib/format.ts`
 * (`stateColor`); this component only translates colors to Tailwind classes.
 * Unknown states and unknown colors fall back to the neutral variant.
 */

export type BadgeSemantic = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

const LEGACY_COLOR_TO_SEMANTIC: Record<string, BadgeSemantic> = {
  green: 'success',
  blue: 'info',
  geekblue: 'info',
  cyan: 'info',
  gold: 'warning',
  orange: 'warning',
  volcano: 'warning',
  red: 'danger',
  magenta: 'danger',
  purple: 'info',
  default: 'neutral',
};

const SEMANTIC_CLASSES: Record<BadgeSemantic, string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  neutral: 'border-border bg-muted text-muted-foreground',
};

/** Semantic variant for a state string (unknown state → 'default' color → neutral). */
export function stateBadgeSemantic(state: string): BadgeSemantic {
  return LEGACY_COLOR_TO_SEMANTIC[stateColor(state)] ?? 'neutral';
}

export function StateBadge({
  state,
  className,
}: {
  readonly state: string | null;
  readonly className?: string;
}): React.ReactElement {
  if (state === null || state.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const semantic = stateBadgeSemantic(state);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        SEMANTIC_CLASSES[semantic],
        className,
      )}
    >
      {state}
    </span>
  );
}

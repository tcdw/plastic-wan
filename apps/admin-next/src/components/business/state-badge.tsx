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
  success: 'border-success/40 bg-success/10 text-success',
  info: 'border-info/40 bg-info/10 text-info',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  neutral: 'border-border bg-muted text-muted-foreground',
};

/** Semantic variant for a state string (unknown state → 'default' color → neutral). */
export function stateBadgeSemantic(state: string): BadgeSemantic {
  return LEGACY_COLOR_TO_SEMANTIC[stateColor(state)] ?? 'neutral';
}

/** Pill badge in one of the semantic tones; colors come from theme tokens only. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  readonly tone: BadgeSemantic;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        SEMANTIC_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
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
  return (
    <ToneBadge tone={stateBadgeSemantic(state)} {...(className !== undefined ? { className } : {})}>
      {state}
    </ToneBadge>
  );
}

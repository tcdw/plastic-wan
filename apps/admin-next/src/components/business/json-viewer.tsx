import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { lightTheme } from '@uiw/react-json-view/light';
import { useState } from 'react';
import type React from 'react';
import { useTheme } from '@/components/themes/theme-provider';
import { Button } from '@/components/ui/button';
import { prettyJson } from '@/lib/format';
import { cn } from '@/lib/utils';
import { LazyDetails } from './lazy-details';

/**
 * JSON viewer with a Tree / Text toggle. The tree is `@uiw/react-json-view`
 * (one level expanded, long strings shortened, copy on hover). Stored JSON is
 * untrusted content: everything renders as text nodes (no HTML execution),
 * malformed JSON falls back to the raw text, and payloads above a threshold
 * start collapsed and mount only when expanded.
 */

const DEFAULT_COLLAPSE_THRESHOLD_CHARS = 2_000;
const MAX_INLINE_STRING_CHARS = 120;

function parseJsonValue(value: string | null): unknown {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isTree(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

const BOX = 'bg-muted/50 max-h-96 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-normal';

function JsonTree({ value }: { readonly value: object }): React.ReactElement {
  const { resolved } = useTheme();
  return (
    <JsonView
      value={value}
      collapsed={1}
      displayObjectSize={false}
      displayDataTypes={false}
      shortenTextAfterLength={MAX_INLINE_STRING_CHARS}
      enableClipboard
      style={
        {
          ...(resolved === 'dark' ? darkTheme : lightTheme),
          '--w-rjv-background-color': 'transparent',
          '--w-rjv-font-family': 'var(--font-mono)',
        } as React.CSSProperties
      }
    />
  );
}

export interface JsonViewerProps {
  readonly value: string | null;
  readonly title?: string;
  readonly defaultMode?: 'tree' | 'text';
  /** Start collapsed regardless of size (explicit collapse for known-huge payloads). */
  readonly initiallyCollapsed?: boolean;
  /** Payloads above this many characters start collapsed in tree mode. */
  readonly collapseThresholdChars?: number;
  readonly className?: string;
}

export function JsonViewer({
  value,
  title,
  defaultMode = 'tree',
  initiallyCollapsed = false,
  collapseThresholdChars = DEFAULT_COLLAPSE_THRESHOLD_CHARS,
  className,
}: JsonViewerProps): React.ReactElement {
  const [mode, setMode] = useState<'tree' | 'text'>(defaultMode);
  const text = prettyJson(value);
  if (text === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const parsed = parseJsonValue(value);
  const canTree = isTree(parsed);
  const large = text.length > collapseThresholdChars;
  const collapsed = initiallyCollapsed || large;

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="xs"
          variant={mode === 'tree' ? 'secondary' : 'ghost'}
          disabled={!canTree}
          onClick={() => setMode('tree')}
        >
          Tree
        </Button>
        <Button size="xs" variant={mode === 'text' ? 'secondary' : 'ghost'} onClick={() => setMode('text')}>
          Text
        </Button>
        {title !== undefined ? <span className="text-muted-foreground text-xs">{title}</span> : null}
        {collapsed ? <span className="text-muted-foreground text-xs">{text.length} chars</span> : null}
      </div>
      {mode === 'tree' && canTree ? (
        collapsed ? (
          <LazyDetails
            summary={`Payload (${text.length} chars) — click to expand`}
            summaryClassName="text-muted-foreground hover:bg-muted cursor-pointer rounded px-1 py-0.5 text-xs transition-colors"
            contentClassName={cn('mt-1', BOX)}
          >
            <JsonTree value={parsed} />
          </LazyDetails>
        ) : (
          <div className={BOX}>
            <JsonTree value={parsed} />
          </div>
        )
      ) : (
        <pre className={cn(BOX, 'break-all whitespace-pre-wrap')}>{text}</pre>
      )}
    </div>
  );
}

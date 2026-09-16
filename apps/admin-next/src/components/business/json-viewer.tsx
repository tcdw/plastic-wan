import { useState } from 'react';
import type React from 'react';
import { Button } from '@/components/ui/button';
import { prettyJson } from '@/lib/format';
import { cn } from '@/lib/utils';
import { LazyDetails } from './lazy-details';

/**
 * JSON viewer with a Tree / Text toggle. Stored JSON is untrusted content:
 * everything renders as text nodes (no HTML execution), malformed JSON falls
 * back to the raw text, and payloads above a threshold start collapsed.
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function describePrimitive(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    const shown = value.length > MAX_INLINE_STRING_CHARS ? `${value.slice(0, MAX_INLINE_STRING_CHARS)}…` : value;
    return JSON.stringify(shown);
  }
  return String(value);
}

function primitiveClass(value: string | number | boolean | null): string {
  if (value === null) {
    return 'text-muted-foreground';
  }
  if (typeof value === 'string') {
    return 'text-emerald-700 dark:text-emerald-300';
  }
  if (typeof value === 'number') {
    return 'text-amber-700 dark:text-amber-300';
  }
  return 'text-violet-700 dark:text-violet-300';
}

function JsonTreeNode({ name, value }: { readonly name?: string; readonly value: unknown }): React.ReactElement {
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      <details className="group/json-node" open>
        <summary className="flex cursor-pointer items-baseline gap-1 rounded px-1 py-0.5 hover:bg-muted">
          {name !== undefined ? <span className="text-sky-700 dark:text-sky-300">{name}:</span> : null}
          <span className="text-muted-foreground">{entries.length === 0 ? '{}' : '{…}'}</span>
        </summary>
        <div className="ml-3 border-l pl-2">
          {entries.map(([key, child]) => (
            <JsonTreeNode key={key} name={key} value={child} />
          ))}
        </div>
      </details>
    );
  }
  if (isArray(value)) {
    return (
      <details className="group/json-node" open>
        <summary className="flex cursor-pointer items-baseline gap-1 rounded px-1 py-0.5 hover:bg-muted">
          {name !== undefined ? <span className="text-sky-700 dark:text-sky-300">{name}:</span> : null}
          <span className="text-muted-foreground">{value.length === 0 ? '[]' : `[${value.length}]`}</span>
        </summary>
        <div className="ml-3 border-l pl-2">
          {Object.entries(value).map(([key, child]) => (
            <JsonTreeNode key={key} name={key} value={child} />
          ))}
        </div>
      </details>
    );
  }
  const primitive: string | number | boolean | null = isPrimitive(value) ? value : null;
  return (
    <div className="flex items-baseline gap-1 rounded px-1 py-0.5">
      {name !== undefined ? <span className="text-sky-700 dark:text-sky-300">{name}:</span> : null}
      <span className={cn('font-mono text-xs break-all', primitiveClass(primitive))}>
        {describePrimitive(primitive)}
      </span>
    </div>
  );
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
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
  const canTree = parsed !== null && (isRecord(parsed) || isArray(parsed));
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
            summaryClassName="text-muted-foreground cursor-pointer rounded px-1 py-0.5 text-xs hover:bg-muted"
            contentClassName="mt-1 overflow-x-auto rounded border bg-muted/20 p-2"
          >
            <JsonTreeNode value={parsed} />
          </LazyDetails>
        ) : (
          <div className="overflow-x-auto rounded border bg-muted/20 p-2">
            <JsonTreeNode value={parsed} />
          </div>
        )
      ) : (
        <pre className="max-h-96 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
    </div>
  );
}

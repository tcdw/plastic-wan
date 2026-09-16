import { useState } from 'react';
import type React from 'react';

/**
 * Native `<details>` disclosure whose children are mounted only after the first
 * expansion. A plain `<details>` renders its subtree eagerly (the browser just
 * hides it), which is expensive for heavy payloads such as `JsonViewer` trees
 * or long tool registries. The children stay mounted once opened so viewer
 * state (tree/text mode, expanded nodes) survives collapsing.
 */

export interface LazyDetailsProps {
  readonly summary: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly summaryClassName?: string;
  readonly contentClassName?: string;
}

export function LazyDetails({
  summary,
  children,
  className,
  summaryClassName,
  contentClassName,
}: LazyDetailsProps): React.ReactElement {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className={className}
      onToggle={(event) => {
        if (event.currentTarget.open && !opened) {
          setOpened(true);
        }
      }}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {opened ? <div className={contentClassName}>{children}</div> : null}
    </details>
  );
}

/**
 * Shared business component contract (M2). Pages import from this barrel:
 *
 *   import { CursorList, StateBadge, TableShell, ... } from '@/components/business';
 *
 * These components are intentionally free of page-specific business fields;
 * pages compose them with their own column specs and render functions.
 */
export {
  CursorList,
  flatPages,
  type CursorListProps,
  type CursorQueryFactory,
  type CursorQueryOptions,
} from './cursor-list';
export { FilterToolbar, SelectFilter, TextFilter, type FilterOption } from './filter-toolbar';
export { StateBadge, stateBadgeSemantic, type BadgeSemantic } from './state-badge';
export { JsonViewer, type JsonViewerProps } from './json-viewer';
export { KvList, MonoValue, TextValue, type KvItem } from './kv-list';
export { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';
export { DetailError, DetailSkeleton, type DetailErrorProps } from './detail-state';
export { TableShell, type ColumnSpec, type TableShellProps } from './table-shell';
export { ChartCard, TimeSeriesChart, type ChartDatum, type ChartSeries } from './chart-card';
export { PrivateReasoningNote, PrivateReasoningTag } from './private-reasoning';

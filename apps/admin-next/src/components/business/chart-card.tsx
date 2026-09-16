import type React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Time-series chart panel for Overview / Usage (M4). A thin recharts wrapper:
 * one x-axis (`date`), one line per series, compact y-axis tick labels.
 * It does not invent totals or aggregate endpoints the API does not provide.
 */

export interface ChartSeries {
  readonly dataKey: string;
  readonly label: string;
  readonly color: string;
}

export type ChartDatum = Readonly<Record<string, string | number>>;

const COMPACT_FORMATTER = new Intl.NumberFormat('en-US', { notation: 'compact' });

function compactNumber(value: number): string {
  return COMPACT_FORMATTER.format(value);
}

const AXIS_TICK = { fontSize: 12, fill: 'var(--muted-foreground)' };

/** Series color marks only the dot; labels and values stay neutral. */
function SeriesDot({ color }: { readonly color: string }): React.ReactElement {
  return <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />;
}

function ChartTooltip({
  active,
  label,
  payload,
  series,
}: {
  readonly active: boolean;
  readonly label: string | number | undefined;
  readonly payload: TooltipContentProps['payload'];
  readonly series: readonly ChartSeries[];
}): React.ReactNode {
  if (!active || payload.length === 0) {
    return null;
  }
  return (
    <div className="bg-popover text-popover-foreground space-y-2 rounded-lg border px-3 py-2 text-xs shadow-xs">
      <p className="font-medium">{label}</p>
      <ul className="space-y-1.5">
        {series.map((entry) => {
          const item = payload.find((candidate) => candidate.dataKey === entry.dataKey);
          return (
            <li key={entry.dataKey} className="flex items-center gap-2">
              <SeriesDot color={entry.color} />
              <span className="text-muted-foreground">{entry.label}</span>
              <span className="ms-auto ps-4 font-medium tabular-nums">
                {typeof item?.value === 'number' ? formatNumber(item.value) : '-'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function TimeSeriesChart({
  data,
  series,
  height = 240,
}: {
  readonly data: readonly ChartDatum[];
  readonly series: readonly ChartSeries[];
  readonly height?: number;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...data]} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
            <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => compactNumber(value)}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)' }}
              content={({ active, label, payload }) => (
                <ChartTooltip active={active} label={label} payload={payload} series={series} />
              )}
            />
            {series.map((entry) => (
              <Line
                key={entry.dataKey}
                type="monotone"
                dataKey={entry.dataKey}
                name={entry.label}
                stroke={entry.color}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {series.map((entry) => (
          <li key={entry.dataKey} className="text-muted-foreground flex items-center gap-2">
            <SeriesDot color={entry.color} />
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartPanel({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('space-y-2', className)}>
      <h3 className="text-muted-foreground text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}

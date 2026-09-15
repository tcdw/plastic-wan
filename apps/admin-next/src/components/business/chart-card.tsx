import type React from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Time-series chart card for Overview / Usage (M4). A thin recharts wrapper:
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
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={[...data]} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(value: number) => compactNumber(value)}
          />
          <Tooltip />
          <Legend />
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
  );
}

export function ChartCard({
  title,
  description,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <Card className={cn('gap-3', className)}>
      <CardHeader className="px-4 pt-4 pb-1">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="px-2 pb-2">{children}</CardContent>
    </Card>
  );
}


const STATE_COLORS: Record<string, string> = {
  completed: "green",
  success: "green",
  ready: "green",
  running: "blue",
  queued: "geekblue",
  pending: "gold",
  collecting: "cyan",
  merged: "purple",
  failed: "red",
  error: "red",
  aborted: "volcano",
  outcome_unknown: "magenta",
  skipped_budget: "orange",
  blocked_budget: "orange",
  expired: "default",
  firing: "blue",
  fired: "green",
  cancelled: "default",
};

const TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatTime(value: string | null): string {
  if (value === null || value.length === 0) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : TIME_FORMAT.format(date);
}

export function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

export function formatCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(2)} s`;
}

export function stateColor(state: string): string {
  return STATE_COLORS[state] ?? "default";
}

export function prettyJson(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

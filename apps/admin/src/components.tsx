import { Alert, Empty, Spin, Tag, Typography } from "antd";
import { ApiError } from "./api.ts";
import { prettyJson, stateColor } from "./format.ts";

export function JsonBlock({ value }: { readonly value: string | null }): React.ReactElement {
  const text = prettyJson(value);
  if (text === null) return <Typography.Text type="secondary">—</Typography.Text>;
  return <pre className="admin-json">{text}</pre>;
}

export function StateTag({ state }: { readonly state: string | null }): React.ReactElement {
  if (state === null || state.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return <Tag color={stateColor(state)}>{state}</Tag>;
}

export function TextValue({ value }: { readonly value: string | null }): React.ReactElement {
  if (value === null || value.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return <Typography.Text>{value}</Typography.Text>;
}

export interface QueryStateOptions {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly isEmpty?: boolean;
}

/**
 * Renders the error, loading, or empty placeholder for a query, or `null` when the
 * caller should render real data. Callers rely on the `null` result to decide
 * between an early return and their own content, so this is a plain function
 * rather than a component: a JSX element is never `null`.
 */
export function queryState({ isPending, error, isEmpty }: QueryStateOptions): React.ReactElement | null {
  if (error !== null && error !== undefined) {
    const message = error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Admin request failed";
    return <Alert type="error" showIcon message="Request failed" description={message} />;
  }
  if (isPending) {
    return (
      <div className="admin-center">
        <Spin />
      </div>
    );
  }
  if (isEmpty === true) return <Empty description="No records" />;
  return null;
}

import { useState } from "react";
import { Alert, Button, Empty, Form, Input, Spin, Tag, Typography } from "antd";
import { ApiError, type Credentials } from "./api.ts";
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

export interface CredentialsFormProps {
  readonly onSubmit: (credentials: Credentials) => Promise<unknown>;
  readonly submitText: string;
  readonly block?: boolean;
  readonly autoFocus?: boolean;
  readonly enforcePasswordLength?: boolean;
  readonly passwordLabel?: string;
  readonly passwordAutoComplete?: "new-password" | "current-password";
}

export function CredentialsForm({
  onSubmit,
  submitText,
  block,
  autoFocus,
  enforcePasswordLength,
  passwordLabel = "Password",
  passwordAutoComplete = "new-password",
}: CredentialsFormProps): React.ReactElement {
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const onFinish = async (values: Credentials): Promise<void> => {
    setPending(true);
    try {
      await onSubmit(values);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : "Request failed");
    } finally {
      setPending(false);
    }
  };
  return (
    <Form<Credentials> layout="vertical" requiredMark={false} onFinish={onFinish}>
      <Form.Item
        name="username"
        label="Username"
        rules={[
          { required: true, message: "Username is required" },
          { pattern: /^[A-Za-z0-9._-]{3,32}$/, message: "3-32 letters, digits, dot, underscore, or hyphen" },
        ]}
      >
        <Input autoComplete="username" autoFocus={autoFocus} />
      </Form.Item>
      <Form.Item
        name="password"
        label={passwordLabel}
        rules={[
          { required: true, message: "Password is required" },
          ...(enforcePasswordLength === true ? [{ min: 12, message: "At least 12 characters" }] : []),
        ]}
      >
        <Input.Password autoComplete={passwordAutoComplete} />
      </Form.Item>
      {failure === null ? null : <Typography.Text type="danger">{failure}</Typography.Text>}
      <Button type="primary" htmlType="submit" block={block === true} loading={pending}>
        {submitText}
      </Button>
    </Form>
  );
}

/** Search-text filter state: trimmed setter plus the empty-string-to-`undefined` coerced value. */
export function useSearchFilter(): {
  readonly filter: string | undefined;
  readonly set: (value: string) => void;
} {
  const [value, setValue] = useState("");
  return { filter: value.length === 0 ? undefined : value, set: (next) => setValue(next.trim()) };
}

/** Flattens the items of an infinite-query page collection into a plain list. */
export function flatPages<T>(data: { readonly pages: ReadonlyArray<{ readonly items: readonly T[] }> } | undefined): T[] {
  return data === undefined ? [] : data.pages.flatMap((page) => [...page.items]);
}

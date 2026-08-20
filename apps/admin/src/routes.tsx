import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { App as AntApp, Button, Card, Form, Input, Layout, Menu, Space, Typography } from "antd";
import { useState } from "react";
import { ApiError, createFirstAdmin, login, logout, updateCredentials, type Credentials } from "./api.ts";
import { queryState } from "./components.tsx";
import { AdminsPage } from "./pages/admins.tsx";
import { InvocationDetailPage, InvocationsPage } from "./pages/invocations.tsx";
import { MemoriesPage } from "./pages/memories.tsx";
import { MessageDetailPage, MessagesPage } from "./pages/messages.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { StickersPage } from "./pages/stickers.tsx";
import { sessionQuery } from "./queries.ts";

const MENU_ITEMS = [
  { key: "/", label: <Link to="/">Overview</Link> },
  { key: "/invocations", label: <Link to="/invocations">Tool sessions</Link> },
  { key: "/messages", label: <Link to="/messages">Messages</Link> },
  { key: "/memories", label: <Link to="/memories">Memories</Link> },
  { key: "/admins", label: <Link to="/admins">Bot admins</Link> },
  { key: "/stickers", label: <Link to="/stickers">Bot sticker sets</Link> },
  { key: "/settings", label: <Link to="/settings">Settings</Link> },
];

interface RouterContext {
  readonly queryClient: QueryClient;
}

function AuthGate(): React.ReactElement {
  const { data, isPending, error } = useQuery(sessionQuery);
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (placeholder !== null) return placeholder;
  if (data === undefined) throw new Error("Session data is missing");
  if (data.setup_required) return <CredentialsCard mode="setup" />;
  if (!data.authenticated) return <CredentialsCard mode="login" />;
  return <AdminShell username={data.username ?? "admin"} />;
}

function CredentialsCard({ mode }: { readonly mode: "setup" | "login" }): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [failure, setFailure] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (credentials: Credentials) => (mode === "setup" ? createFirstAdmin(credentials) : login(credentials)),
    onSuccess: async () => {
      setFailure(null);
      message.success(mode === "setup" ? "Administrator account created" : "Signed in");
      await queryClient.invalidateQueries();
    },
    onError: (error: unknown) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : "Request failed");
    },
  });
  return (
    <div className="admin-auth">
      <Card
        style={{ width: 420 }}
        title={mode === "setup" ? "Create the administrator account" : "Plastic Wan admin sign-in"}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {mode === "setup" ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              First run. Choose a username and a password of at least 12 characters. Only an Argon2id hash is stored.
            </Typography.Paragraph>
          ) : null}
          <Form<Credentials>
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => submit.mutate(values)}
          >
            <Form.Item
              name="username"
              label="Username"
              rules={[
                { required: true, message: "Username is required" },
                { pattern: /^[A-Za-z0-9._-]{3,32}$/, message: "3-32 letters, digits, dot, underscore, or hyphen" },
              ]}
            >
              <Input autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item
              name="password"
              label="Password"
              rules={[
                { required: true, message: "Password is required" },
                ...(mode === "setup" ? [{ min: 12, message: "At least 12 characters" }] : []),
              ]}
            >
              <Input.Password autoComplete={mode === "setup" ? "new-password" : "current-password"} />
            </Form.Item>
            {failure === null ? null : (
              <Form.Item>
                <Typography.Text type="danger">{failure}</Typography.Text>
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" block loading={submit.isPending}>
              {mode === "setup" ? "Create account" : "Sign in"}
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}

function SettingsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [failure, setFailure] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: updateCredentials,
    onSuccess: async () => {
      setFailure(null);
      message.success("Credentials updated; all other sessions were signed out");
      await queryClient.invalidateQueries();
    },
    onError: (error: unknown) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : "Request failed");
    },
  });
  return (
    <Card title="Admin credentials" style={{ maxWidth: 520 }}>
      <Typography.Paragraph type="secondary">
        Change the username and password. The current session remains signed in.
      </Typography.Paragraph>
      <Form<Credentials> layout="vertical" requiredMark={false} onFinish={(values) => submit.mutate(values)}>
        <Form.Item
          name="username"
          label="Username"
          rules={[
            { required: true, message: "Username is required" },
            { pattern: /^[A-Za-z0-9._-]{3,32}$/, message: "3-32 letters, digits, dot, underscore, or hyphen" },
          ]}
        >
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          name="password"
          label="New password"
          rules={[
            { required: true, message: "Password is required" },
            { min: 12, message: "At least 12 characters" },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {failure === null ? null : <Typography.Text type="danger">{failure}</Typography.Text>}
        <Button type="primary" htmlType="submit" loading={submit.isPending}>
          Update credentials
        </Button>
      </Form>
    </Card>
  );
}


function AdminShell({ username }: { readonly username: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      await navigate({ to: "/" });
      queryClient.clear();
      await queryClient.invalidateQueries();
    },
  });
  const { pathname } = useLocation();
  const selected = MENU_ITEMS.map((item) => item.key)
    .filter((key) => key !== "/" && pathname.startsWith(key));
  return (
    <Layout style={{ minHeight: "100%" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", gap: 24, paddingInline: 24 }}>
        <Typography.Text strong style={{ color: "#fff", whiteSpace: "nowrap" }}>
          Plastic Wan Admin
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          items={MENU_ITEMS}
          selectedKeys={selected.length > 0 ? selected : ["/"]}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Space>
          <Typography.Text style={{ color: "rgba(255,255,255,0.75)" }}>{username}</Typography.Text>
          <Button size="small" loading={signOut.isPending} onClick={() => signOut.mutate()}>
            Sign out
          </Button>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}


const rootRoute = createRootRouteWithContext<RouterContext>()({ component: AuthGate });

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });

const invocationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invocations",
  component: InvocationsPage,
});

const invocationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invocations/$invocationId",
  component: function InvocationDetailRoute() {
    const { invocationId } = useParams({ from: "/invocations/$invocationId" });
    return <InvocationDetailPage id={invocationId} />;
  },
});

const messagesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/messages", component: MessagesPage });

const memoriesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/memories", component: MemoriesPage });

const adminsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admins", component: AdminsPage });

const messageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/messages/$messageId",
  component: function MessageDetailRoute() {
    const { messageId } = useParams({ from: "/messages/$messageId" });
    return <MessageDetailPage id={messageId} />;
  },
});

const stickersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/stickers", component: StickersPage });

export const routeTree = rootRoute.addChildren([
  overviewRoute,
  invocationsRoute,
  invocationDetailRoute,
  messagesRoute,
  memoriesRoute,
  adminsRoute,
  messageDetailRoute,
  settingsRoute,
  stickersRoute,
]);

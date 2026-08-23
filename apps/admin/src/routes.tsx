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
import { App as AntApp, Button, Card, Layout, Menu, Space, Typography } from "antd";
import { createFirstAdmin, login, logout, updateCredentials, type Credentials } from "./api.ts";
import { CredentialsForm, queryState } from "./components.tsx";
import { AdminsPage } from "./pages/admins.tsx";
import { InvocationDetailPage, InvocationsPage } from "./pages/invocations.tsx";
import { MemoriesPage } from "./pages/memories.tsx";
import { MessageDetailPage, MessagesPage } from "./pages/messages.tsx";
import { ModelPage } from "./pages/model.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { StickersPage } from "./pages/stickers.tsx";
import { sessionQuery } from "./queries.ts";

const MENU_ITEMS = [
  { key: "/", label: <Link to="/">Overview</Link> },
  { key: "/invocations", label: <Link to="/invocations">Tool sessions</Link> },
  { key: "/messages", label: <Link to="/messages">Messages</Link> },
  { key: "/memories", label: <Link to="/memories">Memories</Link> },
  { key: "/admins", label: <Link to="/admins">Bot admins</Link> },
  { key: "/model", label: <Link to="/model">Model</Link> },
  { key: "/stickers", label: <Link to="/stickers">Bot sticker sets</Link> },
  { key: "/settings", label: <Link to="/settings">Settings</Link> },
];

interface RouterContext {
  readonly queryClient: QueryClient;
}

function AuthGate(): React.ReactNode {
  const { data, isPending, error } = useQuery(sessionQuery);
  const placeholder = queryState({ isPending: isPending || data === undefined, error });
  if (data === undefined || placeholder !== null) return placeholder;
  if (data.setup_required) return <CredentialsCard mode="setup" />;
  if (!data.authenticated) return <CredentialsCard mode="login" />;
  return <AdminShell username={data.username ?? "admin"} />;
}

function CredentialsCard({ mode }: { readonly mode: "setup" | "login" }): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const submit = async (credentials: Credentials): Promise<void> => {
    await (mode === "setup" ? createFirstAdmin(credentials) : login(credentials));
    message.success(mode === "setup" ? "Administrator account created" : "Signed in");
    await queryClient.invalidateQueries();
  };
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
          <CredentialsForm
            onSubmit={submit}
            submitText={mode === "setup" ? "Create account" : "Sign in"}
            block
            autoFocus={mode === "setup"}
            enforcePasswordLength={mode === "setup"}
            passwordAutoComplete={mode === "setup" ? "new-password" : "current-password"}
          />
        </Space>
      </Card>
    </div>
  );
}

function SettingsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const submit = async (credentials: Credentials): Promise<void> => {
    await updateCredentials(credentials);
    message.success("Credentials updated; all other sessions were signed out");
    await queryClient.invalidateQueries();
  };
  return (
    <Card title="Admin credentials" style={{ maxWidth: 520 }}>
      <Typography.Paragraph type="secondary">
        Change the username and password. The current session remains signed in.
      </Typography.Paragraph>
      <CredentialsForm
        onSubmit={submit}
        submitText="Update credentials"
        enforcePasswordLength
        passwordLabel="New password"
      />
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

const modelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/model", component: ModelPage });

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
  modelRoute,
  messageDetailRoute,
  settingsRoute,
  stickersRoute,
]);

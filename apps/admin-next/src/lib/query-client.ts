import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api.ts';

const SESSION_QUERY_KEY = ['session'] as const;

/**
 * Returns true for 401s emitted by the admin auth gate on protected routes,
 * which the backend reports with code `unauthenticated`
 * (src/ingress/admin/server.ts). Credential failures (`invalid_credentials`
 * from login, plus 4xx validation codes from setup / change-credentials) are
 * also 401 in the case of a bad password but must stay in their form as an
 * inline error — never bounce the user back to the login gate. That is why the
 * discrimination is by error *code*, not by status alone.
 */
function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'unauthenticated';
}

let queryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (!queryClient) {
    const client = new QueryClient({
      queryCache: new QueryCache({
        onError: (error, query) => {
          if (!isSessionExpired(error)) {
            return;
          }
          if (query.queryKey.includes(SESSION_QUERY_KEY[0])) {
            // The session query itself never 401s, but never react to it to
            // avoid self-triggered refetch loops.
            return;
          }
          // A protected request lost its session: drop the stale
          // `authenticated: true` snapshot so the AuthGate re-evaluates and
          // renders the login gate instead of a dead shell.
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        },
      }),
      mutationCache: new MutationCache({
        onError: (error) => {
          if (!isSessionExpired(error)) {
            return;
          }
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        },
      }),
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 5_000,
          refetchOnWindowFocus: false,
        },
      },
    });
    queryClient = client;
  }
  return queryClient;
}

export function setQueryClient(client: QueryClient) {
  queryClient = client;
}

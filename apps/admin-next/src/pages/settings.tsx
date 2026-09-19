import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { KvList, MonoValue, ToneBadge } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, applyConfigFile, type ConfigApplyResponse, type Credentials, updateCredentials } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { configStatusQuery, sessionQuery } from '@/lib/queries';

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function PathList({ paths }: { readonly paths: readonly string[] }): React.ReactElement {
  if (paths.length === 0) {
    return <span className="text-muted-foreground">none</span>;
  }
  return <MonoValue value={paths.join(', ')} />;
}

function AppliedResult({ result }: { readonly result: ConfigApplyResponse }): React.ReactElement {
  return (
    <KvList
      className="mt-3"
      items={[
        { label: 'Applied', value: <PathList paths={result.applied} /> },
        { label: 'Restart required', value: <PathList paths={result.restart_required} /> },
        { label: 'Outside serve', value: <PathList paths={result.outside_serve} /> },
      ]}
    />
  );
}

export default function SettingsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ConfigApplyResponse | null>(null);
  const [applyFailure, setApplyFailure] = useState<string | null>(null);

  const status = useQuery(configStatusQuery);

  const mutation = useMutation({
    mutationFn: updateCredentials,
    onSuccess: async () => {
      setSuccess(true);
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setSuccess(false);
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Request failed');
    },
  });

  const applyMutation = useMutation({
    mutationFn: applyConfigFile,
    onSuccess: async (result) => {
      setApplyResult(result);
      setApplyFailure(null);
      await queryClient.invalidateQueries({ queryKey: configStatusQuery.queryKey });
    },
    onError: async (error) => {
      // Show the real error next to the button, then refresh: a failed reload
      // keeps the active configuration and the file hash, but records the error
      // as the last error.
      setApplyResult(null);
      setApplyFailure(errorMessage(error));
      await queryClient.invalidateQueries({ queryKey: configStatusQuery.queryKey });
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Credentials>();

  const onSubmit = (data: Credentials) => {
    setFailure(null);
    setSuccess(false);
    mutation.mutate(data);
  };

  const current = status.data;

  return (
    <div className="max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Admin credentials</CardTitle>
          <CardDescription>Change the username and password. The current session remains signed in.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">New username</Label>
              <Input
                id="username"
                autoComplete="username"
                {...register('username', {
                  required: 'Username is required',
                  pattern: {
                    value: /^[A-Za-z0-9._-]{3,32}$/,
                    message: '3-32 letters, digits, dot, underscore, or hyphen',
                  },
                })}
              />
              {errors.username && <p className="text-destructive text-sm">{errors.username.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register('password', {
                  required: 'Password is required',
                  minLength: { value: 12, message: 'At least 12 characters' },
                })}
              />
              {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
            </div>
            {success && (
              <p className="text-success text-sm">Credentials updated; all other sessions were signed out.</p>
            )}
            {failure && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Updating…' : 'Update credentials'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration file</CardTitle>
          <CardDescription>
            Apply config.jsonc to the running process. Fields outside the hot-update list are reported as waiting for a
            restart instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : status.isError || current === undefined ? (
            <p className="text-destructive text-sm break-words">{errorMessage(status.error)}</p>
          ) : (
            <>
              <KvList
                items={[
                  { label: 'Generation', value: current.generation },
                  { label: 'Active hash', value: <MonoValue value={shortHash(current.active_hash)} /> },
                  { label: 'File hash', value: <MonoValue value={shortHash(current.file_hash)} /> },
                  {
                    label: 'Active configuration',
                    value:
                      current.active_hash === current.file_hash ? (
                        <ToneBadge tone="success">matches the file</ToneBadge>
                      ) : (
                        <ToneBadge tone="warning">file has changes</ToneBadge>
                      ),
                  },
                  { label: 'Restart required', value: <PathList paths={current.restart_required} /> },
                  {
                    label: 'Last error',
                    value:
                      current.last_error === null ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <span className="text-destructive">
                          {current.last_error.code}: {current.last_error.message} ({current.last_error.at})
                        </span>
                      ),
                  },
                ]}
              />
              <div className="mt-4">
                <Button
                  type="button"
                  disabled={applyMutation.isPending}
                  onClick={() => {
                    applyMutation.mutate();
                  }}
                >
                  {applyMutation.isPending ? 'Applying…' : 'Apply config file'}
                </Button>
              </div>
              {applyFailure !== null && <p className="text-destructive mt-3 text-sm break-words">{applyFailure}</p>}
              {applyResult !== null && <AppliedResult result={applyResult} />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

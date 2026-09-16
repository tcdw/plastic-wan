import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, type Credentials, updateCredentials } from '@/lib/api';
import { sessionQuery } from '@/lib/queries';

export default function SettingsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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

  return (
    <Card className="max-w-lg">
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
          {success && <p className="text-success text-sm">Credentials updated; all other sessions were signed out.</p>}
          {failure && <p className="text-destructive text-sm">{failure}</p>}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Updating…' : 'Update credentials'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

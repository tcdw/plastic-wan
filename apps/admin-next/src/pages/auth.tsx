import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, type Credentials, createFirstAdmin, login } from '@/lib/api';
import { sessionQuery } from '@/lib/queries';

export function LoginForm(): React.ReactElement {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
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
    loginMutation.mutate(data);
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Plastic Wan admin sign-in</CardTitle>
          <CardDescription>Enter your credentials to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
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
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password', { required: 'Password is required' })}
              />
              {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
            </div>
            {failure && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function SetupForm(): React.ReactElement {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: createFirstAdmin,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
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
    setupMutation.mutate(data);
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create the administrator account</CardTitle>
          <CardDescription>
            First run. Choose a username and a password of at least 12 characters. Only an Argon2id hash is stored.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
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
              <Label htmlFor="password">Password</Label>
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
            {failure && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

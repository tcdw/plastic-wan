import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, type Credentials, createFirstAdmin, login } from '@/lib/api';
import { sessionQuery } from '@/lib/queries';
import { useTranslation } from 'react-i18next';

export function LoginForm(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
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
          <CardTitle>{t('pages.auth.loginTitle')}</CardTitle>
          <CardDescription>{t('pages.auth.loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('pages.auth.username')}</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                {...register('username', {
                  required: t('pages.auth.usernameRequired'),
                  pattern: {
                    value: /^[A-Za-z0-9._-]{3,32}$/,
                    message: t('pages.auth.usernamePattern'),
                  },
                })}
              />
              {errors.username && <p className="text-destructive text-sm">{errors.username.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('pages.auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password', { required: t('pages.auth.passwordRequired') })}
              />
              {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
            </div>
            {failure && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('pages.auth.signingIn') : t('pages.auth.signIn')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function SetupForm(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: createFirstAdmin,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? `${error.code}: ${error.message}` : t('common.requestFailed'));
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
          <CardTitle>{t('pages.auth.setupTitle')}</CardTitle>
          <CardDescription>{t('pages.auth.setupDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('pages.auth.username')}</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                {...register('username', {
                  required: t('pages.auth.usernameRequired'),
                  pattern: {
                    value: /^[A-Za-z0-9._-]{3,32}$/,
                    message: t('pages.auth.usernamePattern'),
                  },
                })}
              />
              {errors.username && <p className="text-destructive text-sm">{errors.username.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('pages.auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register('password', {
                  required: t('pages.auth.passwordRequired'),
                  minLength: { value: 12, message: t('pages.auth.passwordMinLength') },
                })}
              />
              {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
            </div>
            {failure && <p className="text-destructive text-sm">{failure}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? t('pages.auth.creating') : t('pages.auth.createAccount')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

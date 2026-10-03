import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/business';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { clearModelPayloads, updateDeveloperSettings } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { developerQuery } from '@/lib/queries';
import { useProviderWrite } from '@/lib/use-provider-write';

export default function DeveloperPage(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery(developerQuery);
  const write = useProviderWrite();
  const [confirmClear, setConfirmClear] = useState(false);
  const update = useMutation({
    mutationFn: ({ enabled, revision }: { enabled: boolean; revision: string }) =>
      updateDeveloperSettings(enabled, revision),
    onSuccess: (result) => {
      queryClient.setQueryData(developerQuery.queryKey, result);
      write.succeeded(result.apply);
    },
    onError: write.failed,
  });
  const clear = useMutation({
    mutationFn: clearModelPayloads,
    onSuccess: () => {
      setConfirmClear(false);
    },
    onSettled: () => {
      // Even a failed sweep may have committed earlier batches.
      void queryClient.invalidateQueries({ queryKey: ['invocation'] });
    },
  });
  const current = settings.data;

  return (
    <div className="max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('models.developer.debugTitle')}</CardTitle>
          <CardDescription>{t('models.developer.debugDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.isPending ? (
            <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
          ) : settings.isError || current === undefined ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(settings.error)}
            </p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <Label htmlFor="record-model-payloads">{t('models.developer.recordLabel')}</Label>
                  <p id="payload-description" className="text-muted-foreground text-sm">
                    {t('models.developer.recordDescription')}
                  </p>
                </div>
                <Switch
                  id="record-model-payloads"
                  aria-describedby="payload-description"
                  checked={current.record_model_payloads}
                  disabled={update.isPending}
                  onCheckedChange={(enabled) => update.mutate({ enabled, revision: current.revision })}
                />
              </div>
              <p className="text-muted-foreground text-xs">{t('models.developer.recordHint')}</p>
              {current.record_model_payloads !== current.active_record_model_payloads ? (
                <p role="status" className="text-warning text-sm">
                  {t('models.developer.stateMismatch', {
                    status: current.active_record_model_payloads ? t('common.on') : t('common.off'),
                  })}
                </p>
              ) : null}
              {update.isError ? (
                <p role="alert" className="text-destructive text-sm break-words">
                  {errorMessage(update.error)}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('models.developer.historyTitle')}</CardTitle>
          <CardDescription>{t('models.developer.historyDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="destructive"
            className="h-auto min-h-9 whitespace-normal text-left"
            disabled={clear.isPending}
            onClick={() => {
              clear.reset();
              setConfirmClear(true);
            }}
          >
            {t('models.developer.clearButton')}
          </Button>
          {clear.isSuccess ? (
            <p role="status" className="text-success text-sm">
              {t('models.developer.cleared', { count: clear.data.cleared_model_calls })}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={(open) => {
          if (!clear.isPending) {
            setConfirmClear(open);
          }
        }}
        title={t('models.developer.confirmTitle')}
        description={t('models.developer.confirmDescription')}
        confirmText={t('models.developer.confirmClear')}
        cancelText={t('common.cancel')}
        destructive
        pending={clear.isPending}
        error={clear.isError ? errorMessage(clear.error) : null}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}

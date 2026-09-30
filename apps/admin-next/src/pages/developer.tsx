import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
          <CardTitle>调试报文</CardTitle>
          <CardDescription>仅在需要调查模型调用时开启。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : settings.isError || current === undefined ? (
            <p role="alert" className="text-destructive text-sm break-words">
              {errorMessage(settings.error)}
            </p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <Label htmlFor="record-model-payloads">记录原始请求报文以便调试</Label>
                  <p id="payload-description" className="text-muted-foreground text-sm">
                    开启后保存模型调用的原始请求与响应快照，以便在 Invocation 详情中排查问题。可能显著增加数据库占用。
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
              <p className="text-muted-foreground text-xs">
                默认关闭。修改后对新的模型调用生效；关闭不会清除历史报文。
              </p>
              {current.record_model_payloads !== current.active_record_model_payloads ? (
                <p role="status" className="text-warning text-sm">
                  文件设置与运行状态不同。当前运行状态：{current.active_record_model_payloads ? '开启' : '关闭'}。 请在
                  Settings 中应用配置文件。
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
          <CardTitle>历史报文</CardTitle>
          <CardDescription>
            清除已保存的模型请求与响应快照，保留 Invocation、调用记录、Token、费用、状态和错误审计。 SQLite
            会复用释放的空间，数据库文件不一定立即缩小。
          </CardDescription>
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
            清除此前记录的原始请求报文
          </Button>
          {clear.isSuccess ? (
            <p role="status" className="text-success text-sm">
              已清除 {clear.data.cleared_model_calls} 条模型调用的调试报文。
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
        title="清除此前记录的原始请求报文？"
        description="此操作不可撤销，仅清除模型请求与响应快照，保留其他审计数据。开启记录时，新报文仍会继续保存。不会压缩数据库文件。"
        confirmText="确认清除"
        cancelText="取消"
        destructive
        pending={clear.isPending}
        error={clear.isError ? errorMessage(clear.error) : null}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}

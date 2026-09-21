import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Pending-restart banner. `serve` has to be restarted by something outside the
 * process, so the button only appears when the deployment declared a supervisor
 * (`PLASTICWAN_SUPERVISED=1`); the paths are listed either way.
 */
export function RestartBanner({
  paths,
  supervised,
  pending,
  onRestart,
}: {
  readonly paths: readonly string[];
  readonly supervised: boolean;
  readonly pending: boolean;
  readonly onRestart: () => void;
}): React.ReactElement | null {
  if (paths.length === 0) {
    return null;
  }
  return (
    <Alert>
      <AlertTriangle className="text-warning" />
      <AlertTitle>有 {paths.length} 处配置等待重启</AlertTitle>
      <AlertDescription>
        <div className="space-y-2">
          <p className="text-xs">这些字段已经写入 config.jsonc，但运行中的进程仍在使用旧值：</p>
          {/* One chip per path: a long joined line wraps into an unreadable
              paragraph as soon as a few fields are waiting. */}
          <ul className="flex flex-wrap gap-1.5">
            {paths.map((path) => (
              <li key={path} className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 font-mono text-xs">
                {path}
              </li>
            ))}
          </ul>
          {supervised ? (
            <Button type="button" size="sm" disabled={pending} onClick={onRestart}>
              {pending ? '重启中…' : '立即重启'}
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              部署方未声明进程监督（PLASTICWAN_SUPERVISED=1），这里不提供重启按钮，请人工重启服务端。
            </p>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

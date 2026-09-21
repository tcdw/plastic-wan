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
      <AlertTitle>
        {paths.length} {paths.length === 1 ? 'setting is' : 'settings are'} waiting for a restart
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-2">
          <p className="text-xs">Written to config.jsonc, but the running process still uses the old values:</p>
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
              {pending ? 'Restarting…' : 'Restart now'}
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              This deployment does not declare a supervisor (PLASTICWAN_SUPERVISED=1), so there is no restart button -
              restart the server by hand.
            </p>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

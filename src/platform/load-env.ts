import { existsSync } from 'node:fs';

// Bun auto-loaded a `.env` file from the working directory; Node does not, so the
// CLI entry restores it explicitly. A missing file is a no-op, and variables
// already present in the real environment always win (`process.loadEnvFile`
// never overrides), so systemd or compose injection keeps precedence.
export function loadEnvFileIfPresent(path: string = '.env'): void {
  if (!existsSync(path)) {
    return;
  }
  process.loadEnvFile(path);
}

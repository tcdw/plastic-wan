import { config } from 'dotenv';

// Bun auto-loaded the `.env*` file family from the working directory; Node does
// not, so the CLI entry restores it with dotenv. Files load in order, dotenv
// never overrides already-set variables, so precedence is: real environment >
// `.env.local` > `.env`. Missing files are skipped silently.
const ENV_FILES = ['.env.local', '.env'] as const;

export function loadEnvFiles(paths: readonly string[] = ENV_FILES): void {
  for (const path of paths) {
    config({ path, quiet: true });
  }
}

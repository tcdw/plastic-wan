import { config } from 'dotenv';

// Node does not read `.env*` files, so the CLI entry loads them with dotenv.
// Files load in order and dotenv never overrides an already-set variable, so
// precedence is: real environment > `.env.local` > `.env`. Missing files are
// skipped silently.
const ENV_FILES = ['.env.local', '.env'] as const;

export function loadEnvFiles(paths: readonly string[] = ENV_FILES): void {
  for (const path of paths) {
    config({ path, quiet: true });
  }
}

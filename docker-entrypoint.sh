#!/usr/bin/env bash
set -euo pipefail

# Default UID/GID for the plasticwan user inside the container.
# Override with PUID/PGID env vars to match the host user when using
# bind mounts — this avoids file ownership conflicts.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u plasticwan)" != "$PUID" ] || [ "$(id -g plasticwan)" != "$PGID" ]; then
  groupmod -o -g "$PGID" plasticwan
  usermod -o -u "$PUID" -g "$PGID" plasticwan
fi

# Fix ownership and permissions for mounted volumes.
# assertConfigPermissions requires: config parent dir 0700, config file 0600.
chown -R plasticwan:plasticwan /data /config 2>/dev/null || true
chmod 700 /config /data 2>/dev/null || true
[ -f /config/config.jsonc ] && chmod 600 /config/config.jsonc 2>/dev/null || true

# Drop to non-root user and execute
exec gosu plasticwan bun run /app/src/cli.ts "$@"

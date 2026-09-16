# ── Stage 1: Build admin panel + install production deps ────────
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# pnpm 是包管理器；bun 仍是运行时（切换见 agent-doc/design/20260901 Bun 到 Node 迁移 Epic.md，Phase 5）
RUN npm install --global pnpm@12.4.2

# Cache layer: install deps before copying source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin-next/package.json ./apps/admin-next/
RUN pnpm install --frozen-lockfile

# Copy source and build admin panel
COPY . .
RUN pnpm run admin:build

# Prune devDependencies — runtime only needs production deps
RUN pnpm install --prod --frozen-lockfile

# ── Stage 2: Runtime (Bun，Phase 5 切换 Node) ────────────────────
FROM oven/bun:1.4-debian

# Runtime system dependencies:
#   ffmpeg / ffprobe — video sticker representative frame extraction
#   python3 + pip    — python-lottie (TGS → SVG → PNG)
#   gosu             — privilege drop in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      gosu \
      python3 \
      python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages lottie

# Non-root user
RUN groupadd --system plasticwan \
    && useradd --system --gid plasticwan --home-dir /app --shell /usr/sbin/nologin plasticwan

WORKDIR /app

# Copy built application from builder
COPY --from=builder --chown=plasticwan:plasticwan /app/src ./src
COPY --from=builder --chown=plasticwan:plasticwan /app/node_modules ./node_modules
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin-next/dist ./apps/admin-next/dist
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin-next/LICENSE ./apps/admin-next/LICENSE
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin-next/NOTICE ./apps/admin-next/NOTICE
COPY --from=builder --chown=plasticwan:plasticwan /app/package.json ./package.json

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data and config volume mount points
RUN mkdir -p /data /config && chown plasticwan:plasticwan /data /config

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["serve", "--config", "/config/config.jsonc"]

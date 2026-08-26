# ── Stage 1: Build admin panel + install production deps ────────
FROM oven/bun:1.4-debian AS builder

WORKDIR /app

# Cache layer: install deps before copying source
COPY package.json bun.lock ./
COPY apps/admin/package.json ./apps/admin/
RUN bun install --frozen-lockfile

# Copy source and build admin panel
COPY . .
RUN bun run admin:build

# Prune devDependencies — runtime only needs production deps
RUN bun install --frozen-lockfile --production

# ── Stage 2: Runtime ────────────────────────────────────────────
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
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin/dist ./apps/admin/dist
COPY --from=builder --chown=plasticwan:plasticwan /app/package.json ./package.json

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data and config volume mount points
RUN mkdir -p /data /config && chown plasticwan:plasticwan /data /config

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["serve", "--config", "/config/config.jsonc"]

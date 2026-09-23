import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { tanstackRouter } from '@tanstack/router-plugin/rspack';

const ADMIN_API_TARGET = process.env.ADMIN_API_TARGET ?? 'http://127.0.0.1:8787';
const API_TARGET_ORIGIN = new URL(ADMIN_API_TARGET).origin;

// Only the two local dev origins may have their Origin rewritten to the API
// target. Anything else is left untouched so the backend origin check rejects
// it (server.ts compares origin host vs forwarded Host host).
const ALLOWED_ORIGINS = ['http://localhost:5273', 'http://127.0.0.1:5273'];

export default defineConfig({
  plugins: [pluginReact(), pluginTailwindcss()],
  source: {
    entry: { index: './src/main.tsx' },
  },
  html: {
    template: './index.html',
  },
  tools: {
    rspack: {
      plugins: [
        // File-based routing: generates src/routeTree.gen.ts from src/routes/
        // and splits every route's component into its own async chunk.
        tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      ],
    },
  },
  server: {
    port: 5273,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: ADMIN_API_TARGET,
        // Forward the request with the target's host so Host and Origin agree.
        changeOrigin: true,
        on: {
          proxyReq: (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin !== undefined && ALLOWED_ORIGINS.includes(origin)) {
              proxyReq.setHeader('origin', API_TARGET_ORIGIN);
            }
          },
        },
      },
    },
  },
});

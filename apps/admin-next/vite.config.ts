import tailwindcss from '@tailwindcss/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const ADMIN_API_TARGET = process.env.ADMIN_API_TARGET ?? 'http://127.0.0.1:8787';
const API_TARGET_ORIGIN = new URL(ADMIN_API_TARGET).origin;

// Only the two local dev origins may have their Origin rewritten to the API
// target. Anything else is left untouched so the backend origin check rejects
// it (server.ts compares origin host vs forwarded Host host).
const ALLOWED_ORIGINS = ['http://localhost:5273', 'http://127.0.0.1:5273'];

export default defineConfig({
  server: {
    port: 5273,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: ADMIN_API_TARGET,
        // Forward the request with the target's host so Host and Origin agree.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin !== undefined && ALLOWED_ORIGINS.includes(origin)) {
              proxyReq.setHeader('origin', API_TARGET_ORIGIN);
            }
          });
        },
      },
    },
  },
  plugins: [tsconfigPaths(), tailwindcss(), viteReact()],
});

import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const ADMIN_DEV_PORT = 5273;
const ADMIN_API_TARGET = process.env["ADMIN_API_TARGET"] ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: { index: "./src/main.tsx" },
  },
  html: {
    title: "Plastic Wan Admin",
  },
  output: {
    distPath: { root: "dist" },
    // The panel is always served from the admin server root.
    assetPrefix: "/",
  },
  server: {
    port: ADMIN_DEV_PORT,
    proxy: {
      "/api": { target: ADMIN_API_TARGET, changeOrigin: true },
    },
  },
});

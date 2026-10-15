import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_URL lets the static build live under a GitHub Pages sub-path, e.g. BASE_URL=/tripwire/ pnpm build.
export default defineConfig({
  base: process.env.BASE_URL ?? "./",
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: !!process.env.PORT,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});

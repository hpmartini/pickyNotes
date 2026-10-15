import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // polling: fsevents silently dropped file changes on a busy machine, leaving the dev window on stale code
  server: { port: 1420, strictPort: true, watch: { usePolling: true, interval: 300 } },
  test: { environment: "jsdom", setupFiles: ["src/test-setup.ts"], server: { deps: { inline: ["@atomic-editor/editor"] } }, include: ["src/**/*.test.{ts,tsx}"] },
});

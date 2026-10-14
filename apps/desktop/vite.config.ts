import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { environment: "jsdom", setupFiles: ["src/test-setup.ts"], server: { deps: { inline: ["@atomic-editor/editor"] } }, include: ["src/**/*.test.{ts,tsx}"] },
});

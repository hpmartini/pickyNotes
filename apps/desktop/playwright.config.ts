import { defineConfig } from "@playwright/test";

// Runs the real web bundle (the same code the Tauri webview shows) against the Vite dev server in headless Chromium.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:1421", headless: true },
  webServer: { command: "npx vite --port 1421 --strictPort", url: "http://localhost:1421", reuseExistingServer: false, timeout: 60_000 },
});

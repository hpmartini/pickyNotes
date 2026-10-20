import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// README images only; kept out of the normal e2e run (`*.shot.ts` does not match its `*.spec.ts` pattern).
export default defineConfig({ ...base, testMatch: "*.shot.ts", fullyParallel: false, workers: 1 });

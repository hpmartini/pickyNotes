import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  VAULT_PATH: z.string().min(1),
  PORT: z.coerce.number().default(8787),
  /** Extra CIDRs/IPs allowed on /admin besides the Tailscale range 100.64.0.0/10. */
  ADMIN_ALLOWLIST: z.string().default(""),
  /** Trust X-Forwarded-For (only behind a reverse proxy you control). */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  /** Browser origins allowed to call the API (the desktop app's webview). */
  CORS_ORIGINS: z.string().default("tauri://localhost,http://tauri.localhost,http://localhost:1420"),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(30),
  CLAUDE_DAILY_LIMIT: z.coerce.number().default(200),
  MAX_ATTACHMENT_MB: z.coerce.number().default(10),
  /** WhisperStorm endpoint; unset = voice captures fail visibly. */
  WHISPER_URL: z.string().optional(),
  WHISPER_TOKEN: z.string().optional(),
});
export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    vaultPath: e.VAULT_PATH,
    port: e.PORT,
    adminAllowlist: e.ADMIN_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: e.TRUST_PROXY === "true",
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    claudeDailyLimit: e.CLAUDE_DAILY_LIMIT,
    maxAttachmentBytes: e.MAX_ATTACHMENT_MB * 1024 * 1024,
    whisperUrl: e.WHISPER_URL,
    whisperToken: e.WHISPER_TOKEN,
  };
}

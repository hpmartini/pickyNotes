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
  /** Transcription endpoint (local speaches service or WhisperStorm); unset = voice captures fail visibly and are retried. */
  WHISPER_URL: z.string().optional(),
  WHISPER_TOKEN: z.string().optional(),
  /** Request format: openai (OpenAI-compatible /v1/audio/transcriptions) or whisperstorm (assumed contract). */
  WHISPER_API: z.enum(["openai", "whisperstorm"]).default("openai"),
  WHISPER_MODEL: z.string().default("Systran/faster-whisper-small"),
  /** S3-compatible object store for attachments above MAX_ATTACHMENT_MB. Unset S3_ENDPOINT = such captures get 413. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().default("pickynotes"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_MAX_ATTACHMENT_MB: z.coerce.number().default(100),
}).refine((e) => !e.S3_ENDPOINT || (e.S3_ACCESS_KEY && e.S3_SECRET_KEY), { message: "S3_ENDPOINT needs S3_ACCESS_KEY and S3_SECRET_KEY" });
export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  // `.env` lines like `S3_ENDPOINT=` (set but empty) mean "unset"
  const e = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
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
    whisperApi: e.WHISPER_API,
    whisperModel: e.WHISPER_MODEL,
    s3: e.S3_ENDPOINT
      ? { endpoint: e.S3_ENDPOINT, bucket: e.S3_BUCKET, accessKey: e.S3_ACCESS_KEY!, secretKey: e.S3_SECRET_KEY!, region: e.S3_REGION, maxAttachmentBytes: e.S3_MAX_ATTACHMENT_MB * 1024 * 1024 }
      : undefined,
  };
}

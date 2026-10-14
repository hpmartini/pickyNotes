import { serve } from "@hono/node-server";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { handlers } from "./jobs.js";
import { S3ObjectStore } from "./object-store.js";
import { ClaudeCliProvider, LimitedLlm, LocalEmbedding, WhisperTranscription } from "./providers.js";
import { PgRepo, migrate } from "./pg-repo.js";
import type { Deps, JobName, JobQueue } from "./services.js";
import { Vault } from "./vault.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
await migrate(pool);
const repo = new PgRepo(pool);

const boss = new PgBoss(config.databaseUrl);
boss.on("error", (e) => console.error("pg-boss", e));
await boss.start();

const retry = { retryLimit: 8, retryDelay: 30, retryBackoff: true }; // also covers daily-limit waits and sync conflicts
const queue: JobQueue = { send: async (name, data) => void (await boss.send(name, data, retry)) };

const deps: Deps = {
  repo,
  vault: new Vault(config.vaultPath),
  llm: new LimitedLlm(new ClaudeCliProvider(), repo, config.claudeDailyLimit),
  embedding: new LocalEmbedding(),
  transcription: new WhisperTranscription({ url: config.whisperUrl, token: config.whisperToken, api: config.whisperApi, model: config.whisperModel }),
  queue,
  maxAttachmentBytes: config.maxAttachmentBytes,
  rerankDefault: config.searchRerank,
  objectStore: config.s3 && new S3ObjectStore(config.s3),
};

for (const name of Object.keys(handlers) as JobName[]) {
  await boss.createQueue(name);
  await boss.work(name, async ([job]) => {
    if (job) await handlers[name](deps, job.data as Record<string, unknown>);
  });
}

serve({ fetch: createApp({ ...deps, ...config }).fetch, port: config.port }, (i) => console.log(`pickyNotes listening on :${i.port}`));

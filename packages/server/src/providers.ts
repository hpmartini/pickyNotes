import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { Repo } from "./repo.js";

// ---------- LLM ----------
export interface LlmRequest {
  prompt: string;
  system?: string;
  /** Absolute path of an image/PDF the model may read (vision/extraction). */
  filePath?: string;
}
export interface LlmProvider {
  complete(req: LlmRequest): Promise<string>;
}
export class QuotaExceededError extends Error {}

/** Runs `claude -p` through the user's subscription login. Never passes an API key. */
export class ClaudeCliProvider implements LlmProvider {
  constructor(private bin = "claude", private timeoutMs = 120_000) {}

  complete({ prompt, system, filePath }: LlmRequest): Promise<string> {
    // Only the Read tool, and only when a file must be looked at: notes are untrusted input.
    // Read is limited to exactly that file (`//` = absolute path in permission rules; a single `/` is project-relative) (anything else is denied in -p mode) and the cwd holds no secrets.
    const args = ["-p", "--no-session-persistence", ...(system ? ["--append-system-prompt", system] : []), ...(filePath ? ["--allowedTools", `Read(/${filePath})`, "--tools", "Read"] : ["--tools", ""])];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // subscription only
    delete env.ANTHROPIC_AUTH_TOKEN;
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, args, { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], timeout: this.timeoutMs });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))));
      p.stdin.end(filePath ? `${prompt}\n\nFile to read: ${filePath}` : prompt);
    });
  }
}

/** Counts every call against a per-day budget stored in the DB. */
export class LimitedLlm implements LlmProvider {
  constructor(private inner: LlmProvider, private repo: Repo, private dailyLimit: number, private today = () => new Date().toISOString().slice(0, 10)) {}
  async complete(req: LlmRequest) {
    if (!(await this.repo.consumeLlmQuota(this.today(), this.dailyLimit))) throw new QuotaExceededError(`daily LLM limit ${this.dailyLimit} reached`);
    return this.inner.complete(req);
  }
}

export class FakeLlm implements LlmProvider {
  calls: LlmRequest[] = [];
  constructor(private reply: (r: LlmRequest) => string = () => "ok") {}
  async complete(r: LlmRequest) {
    this.calls.push(r);
    return this.reply(r);
  }
}

// ---------- Embeddings ----------
export const EMBED_DIM = 384;
export interface EmbeddingProvider {
  embed(text: string, kind: "query" | "passage"): Promise<number[]>;
}

/** Local multilingual-e5-small via transformers.js; the model is loaded lazily on first use. */
export class LocalEmbedding implements EmbeddingProvider {
  private pipe?: Promise<(t: string, o: object) => Promise<{ data: Float32Array }>>;
  async embed(text: string, kind: "query" | "passage") {
    const mod = "@huggingface/transformers"; // variable: keeps the heavy optional dependency out of typecheck/tests
    this.pipe ??= import(mod).then((m) => m.pipeline("feature-extraction", "Xenova/multilingual-e5-small"));
    try {
      const out = await (await this.pipe)(`${kind}: ${text.slice(0, 2000)}`, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    } catch (e) {
      this.pipe = undefined; // don't cache a failed (e.g. interrupted) model download; the queue retries
      throw e;
    }
  }
}

/** Deterministic bag-of-words hashing embedding for tests; similar texts get similar vectors. */
export class FakeEmbedding implements EmbeddingProvider {
  async embed(text: string, _kind?: "query" | "passage") {
    const v = new Array<number>(EMBED_DIM).fill(0);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[createHash("md5").update(w).digest().readUInt16BE(0) % EMBED_DIM]! += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  }
}

// ---------- Transcription ----------
export interface TranscriptionProvider {
  transcribe(audio: Buffer, filename: string, mime: string): Promise<string>;
}

/**
 * WhisperStorm HTTP API. ASSUMED contract (unverified): POST multipart field "file" to WHISPER_URL,
 * optional bearer token, JSON response {"text": "..."}.
 */
export class WhisperStormTranscription implements TranscriptionProvider {
  constructor(private url: string | undefined, private token?: string, private f: typeof fetch = fetch) {}
  async transcribe(audio: Buffer, filename: string, mime: string) {
    if (!this.url) throw new Error("WHISPER_URL not configured");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
    const res = await this.f(this.url, { method: "POST", body: form, headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new Error(`whisper ${res.status}`);
    const j = (await res.json()) as { text?: string };
    if (typeof j.text !== "string") throw new Error("whisper: response has no text");
    return j.text;
  }
}

export class FakeTranscription implements TranscriptionProvider {
  constructor(private text = "transcribed text") {}
  async transcribe() {
    return this.text;
  }
}

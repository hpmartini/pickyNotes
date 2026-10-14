import { ulid } from "ulid";
import type { CaptureInput, SearchHit, WebhookEvent } from "@pickynotes/shared";
import { mentionsClaude } from "./claude-instructions.js";
import type { EmbeddingProvider, LlmProvider, TranscriptionProvider } from "./providers.js";
import type { NoteRow, Repo } from "./repo.js";
import { rrf } from "./search.js";
import type { Vault } from "./vault.js";

export type JobName = "transcribe" | "extract" | "embed" | "curate" | "claude-instruction" | "webhook-deliver";
export interface JobQueue {
  send(name: JobName, data: Record<string, unknown>): Promise<void>;
}

export interface Deps {
  repo: Repo;
  vault: Vault;
  llm: LlmProvider;
  embedding: EmbeddingProvider;
  transcription: TranscriptionProvider;
  queue: JobQueue;
  maxAttachmentBytes: number;
  fetch?: typeof fetch;
}

export class PayloadTooLargeError extends Error {}
export class BadCaptureError extends Error {}

export const titleOf = (text: string, fallback = "Notiz") =>
  (text.split("\n").map((l) => l.replace(/^[#>\s-]+/, "").trim()).find(Boolean) ?? fallback).slice(0, 80);

export async function emit(deps: Deps, event: WebhookEvent["event"], noteId: string, data?: Record<string, unknown>) {
  const body = JSON.stringify({ event, noteId, at: new Date().toISOString(), data } satisfies WebhookEvent);
  for (const w of await deps.repo.listWebhooks()) await deps.queue.send("webhook-deliver", { url: w.url, secret: w.secret, body });
}

/** Writes raw/<id>.md and kicks off the async pipeline. Shared by text captures and finished voice/file jobs. */
export async function finishNote(deps: Deps, p: { id: string; body: string; source: NoteRow["source"]; kind: string; title?: string; createdAt: string }) {
  const ignored = p.source === "imported" && mentionsClaude(p.body);
  const fm = { id: p.id, kind: p.kind, source: p.source, created: p.createdAt, status: "pending", tags: [] as string[], ...(ignored ? { claude: "ignored" } : {}) };
  const path = await deps.vault.writeNew(p.id, fm, p.body).catch((e) => {
    if (e?.code === "EEXIST") return `raw/${p.id}.md`; // job retry after a partial run
    throw e;
  });
  await deps.repo.upsertNote({ id: p.id, path, title: p.title ?? titleOf(p.body), body: p.body, tags: [], summary: null, source: p.source, status: "pending", contentHash: null, createdAt: p.createdAt });
  await deps.queue.send("embed", { noteId: p.id });
  await deps.queue.send("curate", { noteId: p.id });
  if (p.source !== "imported" && mentionsClaude(p.body)) await deps.queue.send("claude-instruction", { noteId: p.id });
  await emit(deps, "note.created", p.id, { path });
}

/** Accepts a capture: validates, stores attachments, answers with an id. Heavy work runs in the queue. */
export async function capture(deps: Deps, input: CaptureInput): Promise<{ id: string }> {
  const id = ulid();
  const createdAt = new Date().toISOString();
  if (input.kind === "text") {
    if (!input.text?.trim()) throw new BadCaptureError("text required");
    await finishNote(deps, { id, body: input.text, source: input.source, kind: "text", createdAt });
    return { id };
  }
  if (!input.data) throw new BadCaptureError("data required");
  const bytes = Buffer.from(input.data, "base64");
  // shortcut: no S3-compatible store yet, larger files are rejected; upgrade when needed
  if (bytes.length > deps.maxAttachmentBytes) throw new PayloadTooLargeError(`attachment exceeds ${deps.maxAttachmentBytes} bytes`);
  const filename = input.filename ?? `${input.kind}.bin`;
  const attachment = await deps.vault.writeAttachment(id, filename, bytes);
  const source = input.kind === "voice" ? input.source : "imported"; // OCR/PDF/file content never counts as own input
  const job = { noteId: id, attachment, filename, mime: input.mime ?? "application/octet-stream", source, kind: input.kind, caption: input.text ?? "", createdAt };
  await deps.repo.upsertNote({ id, path: `raw/${id}.md`, title: filename, body: "", tags: [], summary: null, source, status: "pending", contentHash: null, createdAt });
  await deps.queue.send(input.kind === "voice" ? "transcribe" : "extract", job);
  return { id };
}

export async function hybridSearch(deps: Pick<Deps, "repo" | "embedding">, q: string, limit = 10, exclude?: string): Promise<SearchHit[]> {
  const vec = await deps.embedding.embed(q, "query");
  const [fts, trgm, vector] = await Promise.all([deps.repo.searchFts(q, 50), deps.repo.searchTrgm(q, 50), deps.repo.searchVector(vec, 50)]);
  // shortcut: no LLM reranking yet (RRF only); add a rerank pass over the top N when quality demands it
  const top = rrf([fts, trgm, vector]).filter((r) => r.id !== exclude).slice(0, limit);
  const notes = new Map((await deps.repo.getNotes(top.map((t) => t.id))).map((n) => [n.id, n]));
  return top.flatMap((t) => {
    const n = notes.get(t.id);
    return n ? [{ id: n.id, title: n.title, snippet: (n.summary ?? n.body).slice(0, 240), score: t.score, path: n.path, tags: n.tags }] : [];
  });
}

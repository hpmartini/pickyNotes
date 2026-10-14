import { access } from "node:fs/promises";
import { ulid } from "ulid";
import type { CaptureInput, MailCapture, SearchHit, WebhookEvent } from "@pickynotes/shared";
import { mentionsClaude } from "./claude-instructions.js";
import type { EmbeddingProvider, LlmProvider, TranscriptionProvider } from "./providers.js";
import type { NoteRow, Repo } from "./repo.js";
import { rrf } from "./search.js";
import type { ObjectStore } from "./object-store.js";
import { readSummary, safeFilename, stripPickyBlocks, type Vault } from "./vault.js";

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
  /** Optional S3-compatible store for attachments above maxAttachmentBytes. */
  objectStore?: ObjectStore;
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
export async function finishNote(deps: Deps, p: { id: string; body: string; source: NoteRow["source"]; kind: string; title?: string; createdAt: string; clientId?: string; frontmatter?: Record<string, unknown> }) {
  const ignored = p.source === "imported" && mentionsClaude(p.body);
  const fm = { id: p.id, kind: p.kind, source: p.source, created: p.createdAt, status: "pending", tags: [] as string[], ...p.frontmatter, ...(ignored ? { claude: "ignored" } : {}) };
  // The note may have been moved/edited since the first attempt (reindex points the row at the new path): resume from there, never write a second raw/<id>.md.
  const existing = await deps.repo.getNote(p.id);
  const moved = existing && existing.body !== "" && existing.path !== `raw/${p.id}.md` && (await access(deps.vault.absPath(existing.path)).then(() => true, () => false)) ? existing.path : null;
  let resumed = !!moved;
  const path = moved ?? await deps.vault.writeNew(p.id, fm, p.body).catch((e) => {
    if (e?.code !== "EEXIST") throw e;
    resumed = true; // job retry after a partial run: the file is the truth, redo only what is unfinished
    return `raw/${p.id}.md`;
  });
  const file = resumed ? await deps.vault.read(path) : null;
  const row = resumed ? existing : null;
  const instructions = resumed ? await deps.repo.getInstructions(p.id) : [];
  // Index fields come from the file on resume (the truth), so a curation that landed in the vault but not in the row is restored.
  const body = file ? stripPickyBlocks(file.body) : p.body;
  const status = file?.data.status === "curated" ? "curated" : file?.data.status === "failed" ? "failed" : "pending";
  const curated = status === "curated";
  const indexed = !!row && row.body !== ""; // a capture's placeholder row (voice/file) has an empty body
  if (!indexed || (file && row && (row.status !== status || row.contentHash !== file.hash))) {
    const tags = Array.isArray(file?.data.tags) ? file.data.tags.map(String) : [];
    const title = typeof file?.data.title === "string" ? file.data.title : (p.title ?? titleOf(body));
    await deps.repo.upsertNote({ id: p.id, path, title, body, tags, summary: file ? readSummary(file.body) : null, source: p.source, status, contentHash: file?.hash ?? null, createdAt: p.createdAt, clientId: p.clientId });
  }
  // shortcut: no hasEmbedding check, so a resume always re-embeds (idempotent); add one if embedding gets expensive.
  await deps.queue.send("embed", { noteId: p.id });
  if (!curated) await deps.queue.send("curate", { noteId: p.id });
  if (p.source !== "imported" && mentionsClaude(p.body) && (!instructions.length || instructions.some((i) => i.stage !== "published")))
    await deps.queue.send("claude-instruction", { noteId: p.id });
  if (!indexed) await emit(deps, "note.created", p.id, { path });
}

/** Accepts a capture: validates, stores attachments, answers with an id. Heavy work runs in the queue. */
export async function capture(deps: Deps, input: CaptureInput): Promise<{ id: string }> {
  // A retried capture (offline queue, lost response) resolves to the note it already created.
  // shortcut: two simultaneous first attempts can both pass this check; the unique index rejects the second (500) and the client's next retry resolves here.
  const dup = input.clientId ? await deps.repo.getNoteByClientId(input.clientId) : null;
  // A placeholder row (voice/file) without raw/<id>.md means the first attempt died before the pipeline job was queued: resume it.
  const incomplete = !!dup && dup.body === "" && !(await access(deps.vault.absPath(dup.path)).then(() => true, () => false));
  // A text capture queues its pipeline inside finishNote, so a row proves nothing about the jobs: always resume (idempotent, re-queues only unfinished work).
  // shortcut: a retry while the first attempt's curate is still queued sends a second curate; it returns early once the note is curated.
  if (dup && !incomplete && input.kind !== "text") return { id: dup.id };
  const id = dup?.id ?? ulid();
  const createdAt = dup?.createdAt ?? new Date().toISOString();
  if (input.kind === "text") {
    if (!input.text?.trim()) throw new BadCaptureError("text required");
    await finishNote(deps, { id, body: input.text, source: input.source, kind: "text", createdAt, clientId: input.clientId });
    return { id };
  }
  if (!input.data) throw new BadCaptureError("data required");
  const bytes = Buffer.from(input.data, "base64");
  // Above the vault limit an attachment goes to the object store (if configured); without one it is rejected.
  const large = bytes.length > deps.maxAttachmentBytes;
  const limit = large && deps.objectStore ? deps.objectStore.maxBytes : deps.maxAttachmentBytes;
  if (bytes.length > limit) throw new PayloadTooLargeError(`attachment exceeds ${limit} bytes`);
  const filename = input.filename ?? `${input.kind}.bin`;
  const mime = input.mime ?? "application/octet-stream";
  const objectKey = large ? `attachments/${id}/${safeFilename(filename)}` : undefined;
  if (objectKey) await deps.objectStore!.put(objectKey, bytes, mime);
  const attachment = objectKey ? undefined : await deps.vault.writeAttachment(id, filename, bytes);
  const source = input.kind === "voice" ? input.source : "imported"; // OCR/PDF/file content never counts as own input
  const job = { noteId: id, attachment, objectKey, filename, mime, source, kind: input.kind, caption: input.text ?? "", createdAt };
  if (!dup) await deps.repo.upsertNote({ id, path: `raw/${id}.md`, title: filename, body: "", tags: [], summary: null, source, status: "pending", contentHash: null, createdAt, clientId: input.clientId });
  await deps.queue.send(input.kind === "voice" ? "transcribe" : "extract", job);
  return { id };
}

/** Forwarded mail → imported note. Sender in frontmatter and body (so /context?sender= finds it); messageId makes redelivery idempotent. */
export async function captureMail(deps: Deps, m: MailCapture): Promise<{ id: string }> {
  const clientId = m.messageId ? `mail:${m.messageId}` : undefined;
  const dup = clientId ? await deps.repo.getNoteByClientId(clientId) : null;
  const body = `Von: ${m.from}\n${m.subject ? `Betreff: ${m.subject}\n` : ""}\n${m.text}`;
  const id = dup?.id ?? ulid();
  // Resumes like a text capture when a redelivery finds a half-finished first attempt.
  await finishNote(deps, { id, body, source: "imported", kind: "mail", title: m.subject || titleOf(m.text, "Mail"), createdAt: dup?.createdAt ?? new Date().toISOString(), clientId, frontmatter: { from: m.from, ...(m.subject ? { subject: m.subject } : {}) } });
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

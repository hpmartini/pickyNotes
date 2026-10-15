import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { ulid } from "ulid";
import type { CaptureInput, MailCapture, SearchHit, WebhookEvent } from "@pickynotes/shared";
import { mentionsClaude } from "./claude-instructions.js";
import type { EmbeddingProvider, LlmProvider, TranscriptionProvider } from "./providers.js";
import type { NoteRow, Repo } from "./repo.js";
import { rerankByLlm, rrf } from "./search.js";
import type { ObjectStore } from "./object-store.js";
import { readSummary, safeFilename, stripPickyBlocks, type Vault } from "./vault.js";

export type JobName = "transcribe" | "extract" | "extract-inline" | "embed" | "curate" | "claude-instruction" | "webhook-deliver";
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
  /** Default for the `rerank` query parameter of /search and /context. */
  rerankDefault?: boolean;
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
    // Store each inline attachment under raw/attachments/<id>-<attachmentId>-<safe>; rewrite `pending:<id>` in the body to the vault-relative path.
    const { body, stored } = await storeAttachmentsAndRewrite(deps, id, input.text, input.attachments);
    await finishNote(deps, { id, body, source: input.source, kind: "text", createdAt, clientId: input.clientId });
    // OCR / PDF text for pasted images and documents; also on a retry (the job is idempotent). Other mime types stay plain links.
    for (const a of stored.filter((s) => s.mime.startsWith("image/") || s.mime === "application/pdf"))
      await deps.queue.send("extract-inline", { noteId: id, attachment: a.rel, filename: a.name, mime: a.mime });
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

/**
 * Stores each inline attachment and rewrites `pending:<attachmentId>` references in the body
 * to `raw/attachments/<noteId>-<sha256(attachmentId)[0:16]>-<safe-name>` (vault-relative). Unknown IDs are left as-is so a
 * truncated payload doesn't silently drop the user's references.
 */
async function storeAttachmentsAndRewrite(deps: Deps, noteId: string, body: string, attachments?: { id: string; name: string; mime: string; data: string }[]): Promise<{ body: string; stored: { rel: string; name: string; mime: string }[] }> {
  if (!attachments || attachments.length === 0) return { body, stored: [] };
  if (new Set(attachments.map((a) => a.id)).size !== attachments.length) throw new BadCaptureError("duplicate attachment id");
  const paths = new Map<string, string>();
  const stored: { rel: string; name: string; mime: string }[] = [];
  for (const a of attachments) {
    const bytes = Buffer.from(a.data, "base64");
    if (bytes.length > deps.maxAttachmentBytes) throw new PayloadTooLargeError(`attachment exceeds ${deps.maxAttachmentBytes} bytes`);
    // Same-named payloads (two screenshot.png) must not overwrite each other. The id is client input: a fixed-length hex digest is path-safe and keeps id and name unambiguous (no "-" or sanitizing collisions).
    const rel = await deps.vault.writeAttachment(`${noteId}-${createHash("sha256").update(a.id).digest("hex").slice(0, 16)}`, a.name, bytes);
    paths.set(a.id, rel);
    stored.push({ rel, name: a.name, mime: a.mime });
  }
  return { body: body.replace(/pending:([a-zA-Z0-9_-]+)/g, (match, id: string) => paths.get(id) ?? match), stored };
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

const RERANK_CANDIDATES = 20;

/** `rerank`: after RRF fusion, let the LLM reorder the top candidates (one call, counts against the daily limit). */
export async function hybridSearch(deps: Pick<Deps, "repo" | "embedding" | "llm">, q: string, limit = 10, exclude?: string, rerank = false): Promise<SearchHit[]> {
  const vec = await deps.embedding.embed(q, "query");
  const [fts, trgm, vector] = await Promise.all([deps.repo.searchFts(q, 50), deps.repo.searchTrgm(q, 50), deps.repo.searchVector(vec, 50)]);
  const top = rrf([fts, trgm, vector]).filter((r) => r.id !== exclude).slice(0, rerank ? Math.max(limit, RERANK_CANDIDATES) : limit);
  const notes = new Map((await deps.repo.getNotes(top.map((t) => t.id))).map((n) => [n.id, n]));
  const hits = top.flatMap((t) => {
    const n = notes.get(t.id);
    return n ? [{ id: n.id, title: n.title, snippet: (n.summary ?? n.body).slice(0, 240), score: t.score, path: n.path, tags: n.tags }] : [];
  });
  if (!rerank || hits.length < 2) return hits.slice(0, limit);
  const order = await rerankByLlm(deps.llm, q, hits);
  const rank = new Map((order ?? []).map((id, i) => [id, i]));
  return (order ? [...hits].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!) : hits).slice(0, limit);
}

import { z } from "zod";

export const CaptureKind = z.enum(["text", "voice", "screenshot", "file"]);
/** typed/dictated = own input (may contain @claude); imported = OCR/PDF/file/web (never executed). */
export const CaptureSource = z.enum(["typed", "dictated", "imported"]);

export const CaptureInput = z.object({
  kind: CaptureKind,
  source: CaptureSource,
  text: z.string().max(200_000).optional(),
  /** Base64 payload for voice/screenshot/file. */
  data: z.string().optional(),
  filename: z.string().max(255).optional(),
  mime: z.string().max(100).optional(),
  clientId: z.string().max(100).optional(),
});
export type CaptureInput = z.infer<typeof CaptureInput>;

export const CaptureAccepted = z.object({ id: z.string() });

export const Note = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  summary: z.string().nullable(),
  source: CaptureSource,
  status: z.enum(["pending", "curated", "failed"]),
  createdAt: z.string(),
});
export type Note = z.infer<typeof Note>;

export const SearchHit = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  path: z.string(),
  tags: z.array(z.string()),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({ hits: z.array(SearchHit) });
export type SearchResponse = z.infer<typeof SearchResponse>;

export const ContextQuery = z.object({
  repo: z.string().optional(),
  event: z.string().optional(),
  sender: z.string().optional(),
});
export type ContextQuery = z.infer<typeof ContextQuery>;

export const WebhookEventName = z.enum(["note.created", "note.curated", "suggestion.created"]);
export const WebhookEvent = z.object({
  event: WebhookEventName,
  noteId: z.string(),
  at: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const DeviceCreate = z.object({ name: z.string().min(1).max(100) });
export const DeviceCreated = z.object({ id: z.string(), name: z.string(), token: z.string() });
export const WebhookCreate = z.object({ url: z.string().url(), secret: z.string().min(16).max(200) });

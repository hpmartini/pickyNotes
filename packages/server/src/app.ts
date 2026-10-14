import { createHash, randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Context, MiddlewareHandler } from "hono";
import { ulid } from "ulid";
import { CaptureAccepted, CaptureInput, DeviceCreate, DeviceCreated, MailCapture, Note, SearchResponse, Suggestion, SuggestionStatus, WebhookCreate } from "@pickynotes/shared";
import { reindex } from "./indexer.js";
import { isTailscaleOrAllowed } from "./net.js";
import { BadCaptureError, Deps, PayloadTooLargeError, capture, captureMail, hybridSearch } from "./services.js";

export interface AppDeps extends Deps {
  adminAllowlist: string[];
  trustProxy: boolean;
  corsOrigins: string[];
  rateLimitPerMin: number;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

const Err = z.object({ error: z.string() });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } } });
const res = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, ...body(schema) });
const secured = [{ bearerAuth: [] }];

const routes = {
  health: createRoute({ method: "get", path: "/health", responses: { 200: res("ok", z.object({ ok: z.boolean() })) } }),
  capture: createRoute({
    method: "post", path: "/captures", security: secured, summary: "Capture a thought (text, voice, screenshot, file). Answers immediately; processing is async.",
    request: { body: body(CaptureInput) },
    responses: { 202: res("Accepted", CaptureAccepted), 400: res("Invalid", Err), 401: res("Unauthorized", Err), 413: res("Too large", Err), 429: res("Rate limited", Err) },
  }),
  captureMail: createRoute({
    method: "post", path: "/captures/mail", security: secured,
    summary: "Mail intake for a mail-to-webhook service (device token). The mail becomes an imported note: @claude inside is never executed; the sender is stored and found via GET /context?sender=.",
    request: { body: body(MailCapture) },
    responses: { 202: res("Accepted", CaptureAccepted), 400: res("Invalid", Err), 401: res("Unauthorized", Err), 413: res("Too large", Err), 429: res("Rate limited", Err) },
  }),
  note: createRoute({
    method: "get", path: "/notes/{id}", security: secured,
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: res("Note", Note), 404: res("Not found", Err), 401: res("Unauthorized", Err) },
  }),
  search: createRoute({
    method: "get", path: "/search", security: secured, summary: "Hybrid search: FTS + trigram + vector, merged with RRF.",
    request: { query: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).default(10) }) },
    responses: { 200: res("Hits", SearchResponse), 401: res("Unauthorized", Err) },
  }),
  context: createRoute({
    method: "get", path: "/context", security: secured, summary: "Notes relevant to a repo / event / sender.",
    request: { query: z.object({ repo: z.string().optional(), event: z.string().optional(), sender: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(8) }) },
    responses: { 200: res("Hits", SearchResponse), 400: res("Invalid", Err), 401: res("Unauthorized", Err) },
  }),
  suggestions: createRoute({
    method: "get", path: "/suggestions", security: secured, summary: "Follow-up proposals (tasks, appointments, issues) the curator found. Proposals only.",
    request: { query: z.object({ status: SuggestionStatus.default("pending") }) },
    responses: { 200: res("Suggestions", z.object({ suggestions: z.array(Suggestion) })), 401: res("Unauthorized", Err) },
  }),
  suggestionAccept: createRoute({
    method: "post", path: "/suggestions/{id}/accept", security: secured, summary: "Mark a suggestion as accepted. Only records the decision: never executes anything (no task, mail, appointment or issue is created).",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: res("Updated", Suggestion), 404: res("Not found", Err), 401: res("Unauthorized", Err) },
  }),
  suggestionDismiss: createRoute({
    method: "post", path: "/suggestions/{id}/dismiss", security: secured, summary: "Mark a suggestion as dismissed. Only records the decision; never executes anything.",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: res("Updated", Suggestion), 404: res("Not found", Err), 401: res("Unauthorized", Err) },
  }),
  deviceCreate: createRoute({
    method: "post", path: "/admin/devices", summary: "Create a device token (shown once). Tailscale/allowlist only.",
    request: { body: body(DeviceCreate) },
    responses: { 201: res("Created", DeviceCreated), 403: res("Forbidden", Err) },
  }),
  deviceList: createRoute({
    method: "get", path: "/admin/devices",
    responses: { 200: res("Devices", z.object({ devices: z.array(z.object({ id: z.string(), name: z.string() })) })), 403: res("Forbidden", Err) },
  }),
  webhookCreate: createRoute({
    method: "post", path: "/admin/webhooks", summary: "Register a webhook (note.created, note.curated, suggestion.created); HMAC-SHA256 in X-Picky-Signature.",
    request: { body: body(WebhookCreate) },
    responses: { 201: res("Created", z.object({ id: z.string() })), 403: res("Forbidden", Err) },
  }),
  reindex: createRoute({
    method: "post", path: "/admin/reindex", summary: "Rebuild the DB index from the vault (read-only on the vault).",
    responses: { 200: res("Done", z.object({ indexed: z.number(), conflicts: z.number(), removed: z.number() })), 403: res("Forbidden", Err) },
  }),
};

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });

  const clientIp = (c: Context): string | undefined => {
    if (deps.trustProxy) return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim(); // last hop = the one our proxy saw
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined; // no socket (app.request in tests)
    }
  };

  const auth: MiddlewareHandler = async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token || !(await deps.repo.findDeviceByTokenHash(hashToken(token)))) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  const admin: MiddlewareHandler = async (c, next) =>
    isTailscaleOrAllowed(clientIp(c), deps.adminAllowlist) ? next() : c.json({ error: "admin only via Tailscale/allowlist" }, 403);

  // First, so OPTIONS preflights (which carry no Authorization header) are answered before auth and rate limiting.
  app.use("*", cors({ origin: deps.corsOrigins, allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 600 }));

  // Rate limit before auth so token guessing is throttled too.
  app.use("/captures", rateLimiter({ windowMs: 60_000, limit: deps.rateLimitPerMin, keyGenerator: (c) => clientIp(c) ?? "unknown", standardHeaders: "draft-6" }));
  // base64 inflates by 4/3; the largest accepted attachment is the object store's limit when one is configured
  app.use("/captures", bodyLimit({ maxSize: Math.ceil(Math.max(deps.maxAttachmentBytes, deps.objectStore?.maxBytes ?? 0) * 1.4) + 1_000_000, onError: (c) => c.json({ error: "payload too large" }, 413) }));
  app.use("/captures/mail", rateLimiter({ windowMs: 60_000, limit: deps.rateLimitPerMin, keyGenerator: (c) => clientIp(c) ?? "unknown", standardHeaders: "draft-6" }));
  app.use("/captures/mail", bodyLimit({ maxSize: 2_000_000, onError: (c) => c.json({ error: "payload too large" }, 413) }));
  for (const p of ["/captures", "/captures/mail", "/notes/*", "/search", "/context", "/suggestions", "/suggestions/*"]) app.use(p, auth);
  app.use("/admin/*", admin);

  app.onError((e, c) => {
    if (e instanceof BadCaptureError) return c.json({ error: e.message }, 400);
    if (e instanceof PayloadTooLargeError) return c.json({ error: e.message }, 413);
    console.error(e);
    return c.json({ error: "internal error" }, 500);
  });

  app.openapi(routes.health, (c) => c.json({ ok: true }, 200));
  app.openapi(routes.capture, async (c) => c.json(await capture(deps, c.req.valid("json")), 202));
  app.openapi(routes.captureMail, async (c) => c.json(await captureMail(deps, c.req.valid("json")), 202));
  app.openapi(routes.note, async (c) => {
    const n = await deps.repo.getNote(c.req.valid("param").id);
    if (!n) return c.json({ error: "not found" }, 404);
    const { contentHash: _h, clientId: _c, ...note } = n;
    return c.json(note, 200);
  });
  app.openapi(routes.search, async (c) => {
    const { q, limit } = c.req.valid("query");
    return c.json({ hits: await hybridSearch(deps, q, limit) }, 200);
  });
  app.openapi(routes.context, async (c) => {
    const { repo, event, sender, limit } = c.req.valid("query");
    const q = [repo, event, sender].filter(Boolean).join(" ");
    if (!q) return c.json({ error: "repo, event or sender required" }, 400);
    return c.json({ hits: await hybridSearch(deps, q, limit) }, 200);
  });
  app.openapi(routes.suggestions, async (c) => c.json({ suggestions: await deps.repo.listSuggestions(c.req.valid("query").status) }, 200));
  for (const [route, status] of [[routes.suggestionAccept, "accepted"], [routes.suggestionDismiss, "dismissed"]] as const)
    app.openapi(route, async (c) => {
      const s = await deps.repo.setSuggestionStatus(c.req.valid("param").id, status);
      return s ? c.json(s, 200) : c.json({ error: "not found" }, 404);
    });
  app.openapi(routes.deviceCreate, async (c) => {
    const { name } = c.req.valid("json");
    const token = "pk_" + randomBytes(32).toString("base64url");
    const id = ulid();
    await deps.repo.createDevice(id, name, hashToken(token));
    return c.json({ id, name, token }, 201);
  });
  app.openapi(routes.deviceList, async (c) => c.json({ devices: await deps.repo.listDevices() }, 200));
  app.openapi(routes.webhookCreate, async (c) => {
    const id = ulid();
    await deps.repo.addWebhook({ id, ...c.req.valid("json") });
    return c.json({ id }, 201);
  });
  app.openapi(routes.reindex, async (c) => c.json(await reindex(deps), 200));

  app.doc("/openapi.json", { openapi: "3.0.3", info: { title: "pickyNotes API", version: "0.1.0" } });
  return app;
}

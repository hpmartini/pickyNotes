import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVaultState, retryQueued, sendNote, vaultStatusLine, type VaultConfig, type VaultDeps, type VaultPost } from "./vault";

interface Hit {
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: Buffer;
}

let server: Server;
let hits: Hit[];
/** Status the mock inbox answers with; 201 makes up a receipt like MAGOS does. */
let answer: number;
let base: string;

beforeEach(async () => {
  localStorage.clear();
  hits = [];
  answer = 201;
  server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ url: req.url!, auth: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks) });
    const ok = answer === 201;
    res.writeHead(answer, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, id: 7, pfad: "raw/inbox/x.md" } : { error: "nope" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

/** Like Rust `vault_post`: adds the Bearer token, returns HTTP errors as a reply, rejects only on a failed connection. */
const post: VaultPost = (url, contentType, body) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { Authorization: "Bearer tok-123", "Content-Type": contentType } }, (res) => {
      const out: Buffer[] = [];
      res.on("data", (c) => out.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(out).toString() }));
    });
    req.on("error", reject);
    req.end(Buffer.from(body));
  });

const cfg = (): VaultConfig => ({ url: base, geraet: "mac", auto: false });
const deps = (over: Partial<VaultDeps> = {}): VaultDeps => ({ post, hasToken: async () => true, attachment: async () => undefined, now: () => new Date(2026, 10, 12, 9, 5), ...over });

describe("sendNote", () => {
  it("posts the note as JSON with app, device and the note id as ref, and keeps the receipt", async () => {
    const r = await sendNote(cfg(), deps(), "note-1", "# Idee\n\nRückruf Kanzlei");
    expect(r.outcome).toBe("sent");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe("/api/vault/eingang");
    expect(hits[0]!.auth).toBe("Bearer tok-123");
    expect(hits[0]!.type).toBe("application/json");
    const body = JSON.parse(hits[0]!.body.toString());
    expect(body).toMatchObject({ geraet: "mac", app: "pickynotes", ref: "note-1", name: "2026-11-12-0905-idee" });
    expect(body.text).toContain("Rückruf Kanzlei");
    expect(vaultStatusLine("note-1")).toBe("Vault: gesendet → raw/inbox/x.md (Eingang 7)");
  });

  it("does not send the same note version twice, but sends an edited one", async () => {
    await sendNote(cfg(), deps(), "n", "eins");
    expect((await sendNote(cfg(), deps(), "n", "eins")).outcome).toBe("duplicate");
    expect(hits).toHaveLength(1);
    expect((await sendNote(cfg(), deps(), "n", "eins zwei")).outcome).toBe("sent");
    expect(hits).toHaveLength(2);
  });

  it("sends referenced attachments as raw bodies with name, device and ref in the query", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const attachment = async (id: string) => (id === "a1" ? { id, name: "aufnahme.m4a", mime: "audio/mp4", bytes } : undefined);
    const r = await sendNote(cfg(), deps({ attachment }), "n", "Text\n\n[Aufnahme](pending:a1) [weg](pending:gone)");
    expect(r.outcome).toBe("sent");
    expect(hits).toHaveLength(2);
    const file = hits[1]!;
    const q = new URL(file.url, base).searchParams;
    expect([q.get("name"), q.get("geraet"), q.get("app"), q.get("ref")]).toEqual(["aufnahme.m4a", "mac", "pickynotes", "n/a1"]);
    expect(file.type).toBe("audio/mp4");
    expect([...file.body]).toEqual([1, 2, 3, 4]);
    await sendNote(cfg(), deps({ attachment }), "n", "Text\n\n[Aufnahme](pending:a1) [weg](pending:gone)");
    expect(hits).toHaveLength(2);
  });

  it.each([
    [401, /Token ungültig/],
    [403, /Token ungültig/],
    [413, /max\. 25 MB/],
  ])("%i is a clear error, not queued", async (status, msg) => {
    answer = status;
    const r = await sendNote(cfg(), deps(), "n", "x");
    expect(r.outcome).toBe("error");
    expect(r.message).toMatch(msg);
    expect(loadVaultState().n!.status).toBe("error");
    expect(await retryQueued(cfg(), deps())).toBe(0);
    expect(hits).toHaveLength(1);
  });

  it("500 and a refused connection queue the text; the retry sends it unchanged once the inbox answers", async () => {
    answer = 500;
    expect((await sendNote(cfg(), deps(), "n", "Wichtig")).outcome).toBe("queued");
    expect(vaultStatusLine("n")).toMatch(/1 in Warteschlange/);
    const first = JSON.parse(hits[0]!.body.toString());

    answer = 201;
    expect(await retryQueued(cfg(), deps())).toBe(1);
    expect(JSON.parse(hits[1]!.body.toString())).toEqual(first);
    expect(loadVaultState().n!.status).toBe("sent");
    expect(loadVaultState().n!.text).toBeUndefined();
    expect(await retryQueued(cfg(), deps())).toBe(0);

    const dead = { ...cfg(), url: "http://127.0.0.1:1" };
    expect((await sendNote(dead, deps(), "m", "offline")).outcome).toBe("queued");
    expect(loadVaultState().m!.status).toBe("queued");
  });

  it("an error entry is tried again when the user sends again", async () => {
    answer = 401;
    await sendNote(cfg(), deps(), "n", "x");
    answer = 201;
    expect((await sendNote(cfg(), deps(), "n", "x")).outcome).toBe("sent");
  });

  it("without URL, device name or token nothing leaves the app", async () => {
    expect((await sendNote({ ...cfg(), url: "" }, deps(), "n", "x")).message).toMatch(/URL fehlt/);
    expect((await sendNote({ ...cfg(), geraet: "a/b" }, deps(), "n", "x")).message).toMatch(/Gerätename/);
    expect((await sendNote(cfg(), deps({ hasToken: async () => false }), "n", "x")).message).toMatch(/Token fehlt/);
    expect(hits).toHaveLength(0);
  });
});

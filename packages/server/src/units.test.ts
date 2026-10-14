import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseInstructions, renderCallout, upsertCallout } from "./claude-instructions.js";
import { loadConfig } from "./config.js";
import { isTailscaleOrAllowed } from "./net.js";
import { ClaudeCliProvider, FakeEmbedding, FakeLlm, LimitedLlm, QuotaExceededError, WhisperTranscription } from "./providers.js";
import { MemoryRepo } from "./memory-repo.js";
import { rrf } from "./search.js";

describe("rrf", () => {
  it("rewards ids that appear in several lists", () => {
    const r = rrf([["a", "b", "c"], ["c", "b"], ["b"]]);
    expect(r.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("@claude parser", () => {
  it("finds instructions, dedups, ignores own blocks and quoted lines", () => {
    const body = "Idee\n@claude fasse das zusammen\nzweite Zeile\n\n@claude fasse das zusammen\nzweite Zeile\n\n> @claude quoted\n<!-- picky:claude -->\n> [!claude] id:c_1 status:done\n> @claude loop\n<!-- /picky:claude -->";
    const ins = parseInstructions(body, "n1");
    expect(ins).toHaveLength(1);
    expect(ins[0]!.text).toBe("fasse das zusammen zweite Zeile");
    expect(parseInstructions(body, "n2")[0]!.id).not.toBe(ins[0]!.id); // same text, other note, other id
  });
  it("callouts carry id and status and are updated in place", () => {
    expect(renderCallout("c_1", "pending")).toBe("> [!claude] id:c_1 status:pending");
    let b = upsertCallout("", "c_1", "pending");
    b = upsertCallout(b, "c_2", "pending");
    b = upsertCallout(b, "c_1", "done", "Ergebnis\nzwei");
    expect(b).toBe("> [!claude] id:c_1 status:done\n> Ergebnis\n> zwei\n\n> [!claude] id:c_2 status:pending");
  });
});

describe("providers", () => {
  it("LimitedLlm stops at the daily limit", async () => {
    const llm = new LimitedLlm(new FakeLlm(), new MemoryRepo(), 2, () => "2026-01-01");
    await llm.complete({ prompt: "1" });
    await llm.complete({ prompt: "2" });
    await expect(llm.complete({ prompt: "3" })).rejects.toBeInstanceOf(QuotaExceededError);
  });
  it("ClaudeCliProvider pipes the prompt via stdin and never forwards an API key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bin-"));
    const bin = path.join(dir, "claude");
    await writeFile(bin, '#!/bin/sh\necho "key=[$ANTHROPIC_API_KEY] args=$*"; cat\n');
    await chmod(bin, 0o755);
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    const out = await new ClaudeCliProvider(bin).complete({ prompt: "PROMPT" });
    const withFile = await new ClaudeCliProvider(bin).complete({ prompt: "P", filePath: "/vault/raw/attachments/x.png" });
    expect(withFile).toContain("Read(//vault/raw/attachments/x.png)");
    delete process.env.ANTHROPIC_API_KEY;
    expect(out).toContain("key=[]");
    expect(out).toContain("-p");
    expect(out).toContain("PROMPT");
    expect(out).not.toContain("sk-secret");
  });
  it("Whisper (whisperstorm mode) posts multipart without a model and returns text", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ text: "hallo" })));
    const t = new WhisperTranscription({ url: "http://w/transcribe", token: "tok", api: "whisperstorm", model: "ignored" }, f as never);
    expect(await t.transcribe(Buffer.from("x"), "a.webm", "audio/webm")).toBe("hallo");
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const form = init.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.has("model")).toBe(false);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    await expect(new WhisperTranscription({}).transcribe(Buffer.from(""), "a", "b")).rejects.toThrow("WHISPER_URL");
  });
  it("Whisper (openai mode, the default) sends the model field; unreachable service, 5xx and bad bodies throw so the job retries", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ text: "hallo welt" })));
    const t = new WhisperTranscription({ url: "http://whisper:8000/v1/audio/transcriptions", model: "Systran/faster-whisper-tiny" }, f as never);
    expect(await t.transcribe(Buffer.from("x"), "a.webm", "audio/webm")).toBe("hallo welt");
    const form = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("model")).toBe("Systran/faster-whisper-tiny");
    expect(form.get("file")).toBeInstanceOf(Blob);
    const fail = (impl: () => Promise<Response>) => new WhisperTranscription({ url: "http://w" }, vi.fn(impl) as never).transcribe(Buffer.from("x"), "a", "audio/webm");
    await expect(fail(async () => { throw new TypeError("fetch failed"); })).rejects.toThrow("fetch failed");
    await expect(fail(async () => new Response("boom", { status: 503 }))).rejects.toThrow("whisper 503");
    await expect(fail(async () => new Response("{}"))).rejects.toThrow("no text");
  });
  it("FakeEmbedding is normalized and similar for similar text", async () => {
    const e = new FakeEmbedding();
    const [a, b, c] = await Promise.all([e.embed("rotes auto fahren"), e.embed("rotes auto"), e.embed("steuer bescheid")]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x", VAULT_PATH: "/v" };
  it("S3 and Whisper are optional with safe defaults; S3 needs both keys", () => {
    expect(loadConfig(base)).toMatchObject({ s3: undefined, whisperApi: "openai" });
    expect(() => loadConfig({ ...base, S3_ENDPOINT: "http://s3:9000" })).toThrow("S3_ACCESS_KEY");
    expect(loadConfig({ ...base, S3_ENDPOINT: "http://s3:9000", S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b" }).s3).toMatchObject({ bucket: "pickynotes", maxAttachmentBytes: 100 * 1024 * 1024 });
    expect(() => loadConfig({ ...base, WHISPER_API: "bogus" })).toThrow();
  });
});

describe("admin network check", () => {
  it("allows tailnet and allowlist only", () => {
    expect(isTailscaleOrAllowed("100.100.1.2", [])).toBe(true);
    expect(isTailscaleOrAllowed("::ffff:100.127.255.255", [])).toBe(true);
    expect(isTailscaleOrAllowed("100.128.0.1", [])).toBe(false);
    expect(isTailscaleOrAllowed("203.0.113.9", [])).toBe(false);
    expect(isTailscaleOrAllowed("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(isTailscaleOrAllowed("fd7a:115c:a1e0::1", [])).toBe(true);
    expect(isTailscaleOrAllowed(undefined, [])).toBe(false);
  });
});

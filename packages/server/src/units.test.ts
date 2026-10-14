import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseInstructions, renderCallout, upsertCallout } from "./claude-instructions.js";
import { isTailscaleOrAllowed } from "./net.js";
import { ClaudeCliProvider, FakeEmbedding, FakeLlm, LimitedLlm, QuotaExceededError, WhisperStormTranscription } from "./providers.js";
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
    const ins = parseInstructions(body);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.text).toBe("fasse das zusammen zweite Zeile");
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
    delete process.env.ANTHROPIC_API_KEY;
    expect(out).toContain("key=[]");
    expect(out).toContain("-p");
    expect(out).toContain("PROMPT");
    expect(out).not.toContain("sk-secret");
  });
  it("Whisper provider posts multipart and returns text", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ text: "hallo" })));
    const t = new WhisperStormTranscription("http://w/transcribe", "tok", f as never);
    expect(await t.transcribe(Buffer.from("x"), "a.webm", "audio/webm")).toBe("hallo");
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    await expect(new WhisperStormTranscription(undefined).transcribe(Buffer.from(""), "a", "b")).rejects.toThrow("WHISPER_URL");
  });
  it("FakeEmbedding is normalized and similar for similar text", async () => {
    const e = new FakeEmbedding();
    const [a, b, c] = await Promise.all([e.embed("rotes auto fahren"), e.embed("rotes auto"), e.embed("steuer bescheid")]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
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

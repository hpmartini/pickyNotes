import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@pickynotes/shared";
import { loadConfig, repoName, run } from "./cli.js";

const setup = (reply: unknown = { id: "N1", hits: [] }, stdin?: string) => {
  const f = vi.fn(async () => new Response(JSON.stringify(reply)));
  const out: string[] = [];
  const env = { client: createClient({ baseUrl: "http://h", token: "t", fetch: f as never }), out: (s: string) => out.push(s), readStdin: async () => stdin };
  return { f, out, env };
};
const urlOf = (f: ReturnType<typeof vi.fn>) => (f.mock.calls[0] as unknown as [string, RequestInit])[0];
const initOf = (f: ReturnType<typeof vi.fn>) => (f.mock.calls[0] as unknown as [string, RequestInit])[1];

describe("note CLI", () => {
  it("add joins arguments and captures as typed text", async () => {
    const { f, out, env } = setup();
    await run(["node", "note", "add", "kauf", "Milch"], env);
    expect(JSON.parse(initOf(f).body as string)).toEqual({ kind: "text", source: "typed", text: "kauf Milch" });
    expect(out).toEqual(["captured N1"]);
  });
  it("add reads stdin when no arguments, and fails on empty input", async () => {
    const a = setup(undefined, "aus stdin");
    await run(["node", "note", "add"], a.env);
    expect(JSON.parse(initOf(a.f).body as string).text).toBe("aus stdin");
    await expect(run(["node", "note", "add"], setup(undefined, "  ").env)).rejects.toThrow("No text");
  });
  it("search sends q and limit; --json prints hits", async () => {
    const hit = { id: "a", title: "T", snippet: "S", score: 1, path: "raw/a.md", tags: [] };
    const { f, out, env } = setup({ hits: [hit] });
    await run(["node", "note", "search", "rotes", "Auto", "-n", "3", "--json"], env);
    expect(urlOf(f)).toBe("http://h/search?q=rotes+Auto&limit=3");
    expect(JSON.parse(out[0]!)).toEqual([hit]);
  });
  it("context --repo uses the directory name when there is no git remote", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "cli-")), "meinrepo");
    await mkdir(dir);
    expect(repoName(dir)).toBe("meinrepo");
    const { f, out, env } = setup({ hits: [] });
    await run(["node", "note", "context", "--repo", dir], env);
    expect(urlOf(f)).toBe("http://h/context?repo=meinrepo");
    expect(out).toEqual(["No results."]);
  });
  it("config: env wins, missing config is a clear error", () => {
    expect(loadConfig({ PICKY_URL: "u", PICKY_TOKEN: "t" }, "/nonexistent")).toEqual({ url: "u", token: "t" });
    expect(() => loadConfig({}, "/nonexistent")).toThrow("PICKY_URL");
  });
});

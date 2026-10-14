import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, Vault } from "./vault.js";

let root: string;
let vault: Vault;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vault-"));
  vault = new Vault(root);
});

describe("Vault guardrails", () => {
  it("exposes no delete/move/rename", () => {
    const names = Object.getOwnPropertyNames(Vault.prototype);
    expect(names.filter((n) => /delete|remove|unlink|move|rename|rm/i.test(n))).toEqual([]);
  });

  it("writes new notes only into raw/ and never overwrites", async () => {
    const rel = await vault.writeNew("01A", { id: "01A" }, "hello");
    expect(rel).toBe("raw/01A.md");
    expect(await readFile(path.join(root, rel), "utf8")).toContain("hello");
    await expect(vault.writeNew("01A", { id: "01A" }, "other")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, rel), "utf8")).toContain("hello");
  });

  it("rejects paths escaping the vault", async () => {
    await expect(vault.read("../etc/passwd")).rejects.toThrow("escapes");
  });

  it("curate changes only frontmatter + summary block; body stays byte-identical", async () => {
    await vault.writeNew("01B", { id: "01B", status: "pending" }, "# Titel\n\nText mit  Leerzeichen\n");
    const before = await vault.read("raw/01B.md");
    const after = await vault.curate("raw/01B.md", before.hash, { summary: "Kurz.", frontmatter: { status: "curated", tags: ["a"] } });
    expect(after.data).toMatchObject({ id: "01B", status: "curated", tags: ["a"] });
    expect(after.body).toContain("<!-- picky:summary -->\n> Kurz.\n<!-- /picky:summary -->");
    expect(after.body.replace(/<!-- picky:summary -->[\s\S]*?<!-- \/picky:summary -->\n\n/, "")).toBe(before.body);
    // second curation replaces the block instead of duplicating it
    const again = await vault.curate("raw/01B.md", after.hash, { summary: "Neu." });
    expect(again.body.match(/picky:summary -->/g)).toHaveLength(2);
    expect(again.body).toContain("> Neu.");
  });

  it("aborts with ConflictError when the file changed since it was read", async () => {
    await vault.writeNew("01C", { id: "01C" }, "x");
    const f = await vault.read("raw/01C.md");
    await writeFile(path.join(root, "raw/01C.md"), "---\nid: 01C\n---\nedited by sync\n");
    await expect(vault.curate("raw/01C.md", f.hash, { summary: "s" })).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(path.join(root, "raw/01C.md"), "utf8")).toContain("edited by sync");
  });

  it("never executes ---js frontmatter and never scans attachments as notes", async () => {
    await mkdir(path.join(root, "raw/attachments"), { recursive: true });
    await writeFile(path.join(root, "x.md"), "---js\n(globalThis.__pwned = true, {})\n---\nbody");
    await writeFile(path.join(root, "raw/attachments/evil.md"), "x");
    await expect(vault.read("x.md")).rejects.toThrow("disabled");
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect((await vault.scan()).files).toEqual(["x.md"]);
  });

  it("keeps a ---js body verbatim and never executes it (new note and curate)", async () => {
    const body = "---js\n(globalThis.__pwned2 = true, {})\n---\nrest\n";
    await vault.writeNew("01D", { id: "01D" }, body);
    const f = await vault.read("raw/01D.md");
    expect(f.body).toBe(body);
    const after = await vault.curate("raw/01D.md", f.hash, { summary: "s", frontmatter: { status: "curated" } });
    expect(after.data).toMatchObject({ id: "01D", status: "curated" });
    expect(after.body.endsWith(body)).toBe(true);
    expect((globalThis as Record<string, unknown>).__pwned2).toBeUndefined();
  });

  it("serialises parallel curates per path: one wins, the rest conflict cleanly (no ENOENT)", async () => {
    await vault.writeNew("01E", { id: "01E" }, "x");
    const f = await vault.read("raw/01E.md");
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => vault.curate("raw/01E.md", f.hash, { frontmatter: { n: i } })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
    expect((await vault.scan()).files).toEqual(["raw/01E.md"]); // no leftover .tmp
  });

  it("scan skips sync-conflict files and .obsidian, reports conflicts separately", async () => {
    await mkdir(path.join(root, "wiki_x"), { recursive: true });
    await mkdir(path.join(root, ".obsidian"));
    await writeFile(path.join(root, "wiki_x/a.md"), "a");
    await writeFile(path.join(root, "wiki_x/a.sync-conflict-20240101-000000-ABC.md"), "a2");
    await writeFile(path.join(root, ".obsidian/n.md"), "n");
    expect(await vault.scan()).toEqual({ files: ["wiki_x/a.md"], conflicts: ["wiki_x/a.sync-conflict-20240101-000000-ABC.md"] });
  });
});

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRepo } from "./memory-repo.js";
import { PgRepo, migrate } from "./pg-repo.js";
import { EMBED_DIM, FakeEmbedding } from "./providers.js";
import type { NoteUpsert, Repo } from "./repo.js";

const note = (id: string, title: string, body: string): NoteUpsert => ({
  id, path: `raw/${id}.md`, title, body, tags: [], summary: null, source: "typed", status: "pending", contentHash: null,
});

/** Behaviour both repository implementations must share. Postgres runs only when DATABASE_URL is set. */
function contract(name: string, make: () => Promise<Repo>, skip = false) {
  describe.skipIf(skip)(`Repo contract: ${name}`, () => {
    let repo: Repo;
    beforeAll(async () => {
      repo = await make();
      const e = new FakeEmbedding();
      await repo.upsertNote(note("a", "Rotes Auto", "Ich will ein rotes Auto kaufen"));
      await repo.upsertNote(note("b", "Steuer", "Umsatzsteuer Voranmeldung abgeben"));
      for (const id of ["a", "b"]) await repo.setEmbedding(id, await e.embed((await repo.getNote(id))!.body, "passage"));
    });

    it("finds notes via FTS, trigram and vector", async () => {
      const e = new FakeEmbedding();
      expect((await repo.searchFts("Auto", 5))[0]).toBe("a");
      expect((await repo.searchTrgm("Voranmeldun", 5))[0]).toBe("b");
      expect((await repo.searchVector(await e.embed("rotes auto kaufen", "query"), 5))[0]).toBe("a");
      expect(EMBED_DIM).toBe(384);
    });

    it("upsert by path keeps one row and deleteMissing only drops index rows", async () => {
      await repo.upsertNote({ ...note("a", "Rotes Auto", "geändert"), contentHash: "h" });
      expect((await repo.getNote("a"))!.body).toBe("geändert");
      expect(await repo.deleteMissing(["raw/a.md"])).toBe(1);
      expect(await repo.getNote("b")).toBeNull();
    });

    it("claims an instruction exactly once per (note, hash)", async () => {
      const i = { id: "c_1", noteId: "a", hash: "H", status: "pending" as const, stage: "claimed" as const, result: null };
      expect(await repo.claimInstruction(i)).toBe(true);
      expect(await repo.claimInstruction({ ...i, id: "c_2" })).toBe(false);
      expect(await repo.claimInstruction({ ...i, id: "c_3", hash: "H2" })).toBe(true);
    });

    it("the same instruction in two notes is two instructions", async () => {
      const i = { id: "c_n1", noteId: "n1", hash: "SAME", status: "pending" as const, stage: "claimed" as const, result: null };
      expect(await repo.claimInstruction(i)).toBe(true);
      expect(await repo.claimInstruction({ ...i, id: "c_n2", noteId: "n2" })).toBe(true);
      expect((await repo.getInstructions("n1")).map((x) => x.id)).toEqual(["c_n1"]);
      expect((await repo.getInstructions("n2")).map((x) => x.id)).toEqual(["c_n2"]);
    });

    it("persists instruction stages and the stored result", async () => {
      await repo.claimInstruction({ id: "c_s", noteId: "s", hash: "S", status: "pending", stage: "claimed", result: null });
      await repo.updateInstruction("c_s", { stage: "executed", status: "done", result: "Antwort" });
      expect(await repo.getInstructions("s")).toEqual([{ id: "c_s", noteId: "s", hash: "S", status: "done", stage: "executed", result: "Antwort" }]);
      await repo.updateInstruction("c_s", { stage: "published" });
      expect(await repo.getInstructions("s")).toMatchObject([{ stage: "published", result: "Antwort" }]);
    });

    it("counts the daily LLM quota atomically up to the limit", async () => {
      const r = [await repo.consumeLlmQuota("2026-01-01", 2), await repo.consumeLlmQuota("2026-01-01", 2), await repo.consumeLlmQuota("2026-01-01", 2), await repo.consumeLlmQuota("2026-01-02", 2)];
      expect(r).toEqual([true, true, false, true]);
    });

    it("a zero limit never consumes (and leaves no row that eats the later quota)", async () => {
      expect(await repo.consumeLlmQuota("2026-02-01", 0)).toBe(false);
      expect(await repo.consumeLlmQuota("2026-02-01", 1)).toBe(true);
      expect(await repo.consumeLlmQuota("2026-02-01", 1)).toBe(false);
    });

    it("upserts by id (path may change), keeps the client id and finds notes by it", async () => {
      await repo.upsertNote({ ...note("u1", "Eins", "eins"), clientId: "cid-1" });
      await repo.upsertNote({ ...note("u1", "Eins", "eins neu"), path: "wiki/u1.md" }); // moved file, same id; no client id in this write
      expect(await repo.getNote("u1")).toMatchObject({ path: "wiki/u1.md", body: "eins neu", clientId: "cid-1" });
      expect((await repo.getNoteByClientId("cid-1"))?.id).toBe("u1");
      expect(await repo.getNoteByClientId("nope")).toBeNull();
      await repo.upsertNote(note("u2", "Zwei", "zwei")); // different note replacing the path of u1 drops the stale index row
      await repo.upsertNote({ ...note("u3", "Drei", "drei"), path: "wiki/u1.md" });
      expect(await repo.getNote("u1")).toBeNull();
      expect(await repo.getNote("u3")).toMatchObject({ path: "wiki/u1.md" });
    });

    it("looks up devices by token hash and de-duplicates conflicts", async () => {
      await repo.createDevice("d", "mac", "hash1");
      expect(await repo.findDeviceByTokenHash("hash1")).toMatchObject({ id: "d" });
      expect(await repo.findDeviceByTokenHash("nope")).toBeNull();
      await repo.recordConflict("x.md", "sync-conflict");
      await repo.recordConflict("x.md", "sync-conflict");
      expect(await repo.listConflicts()).toHaveLength(1);
    });
  });
}

contract("memory", async () => new MemoryRepo());

const url = process.env.DATABASE_URL;
let pool: pg.Pool | undefined;
contract(
  "postgres",
  async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    return new PgRepo(pool);
  },
  !url,
);
afterAll(() => pool?.end());

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
      const i = { id: "c_1", noteId: "a", hash: "H", status: "pending" as const };
      expect(await repo.claimInstruction(i)).toBe(true);
      expect(await repo.claimInstruction({ ...i, id: "c_2" })).toBe(false);
      expect(await repo.claimInstruction({ ...i, id: "c_3", hash: "H2" })).toBe(true);
    });

    it("counts the daily LLM quota atomically up to the limit", async () => {
      const r = [await repo.consumeLlmQuota("2026-01-01", 2), await repo.consumeLlmQuota("2026-01-01", 2), await repo.consumeLlmQuota("2026-01-01", 2), await repo.consumeLlmQuota("2026-01-02", 2)];
      expect(r).toEqual([true, true, false, true]);
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

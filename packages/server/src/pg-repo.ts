import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Device, InstructionRow, NoteRow, NoteUpsert, Repo, Webhook } from "./repo.js";

const COLS = "id, path, title, body, tags, summary, source, status, content_hash, client_id, created_at";
const toNote = (r: any): NoteRow => ({
  id: r.id,
  path: r.path,
  title: r.title,
  body: r.body,
  tags: r.tags,
  summary: r.summary,
  source: r.source,
  status: r.status,
  contentHash: r.content_hash,
  clientId: r.client_id,
  createdAt: new Date(r.created_at).toISOString(),
});
const vec = (v: number[]) => `[${v.join(",")}]`;

export async function migrate(pool: pg.Pool) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

export class PgRepo implements Repo {
  constructor(readonly pool: pg.Pool) {}

  async upsertNote(n: NoteUpsert) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Both id and path are unique: a different row on this path (file replaced by another note) is an index row only, drop it first.
      await c.query("DELETE FROM notes WHERE path=$1 AND id<>$2", [n.path, n.id]);
      await c.query(
        `INSERT INTO notes (id, path, title, body, tags, summary, source, status, content_hash, client_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))
         ON CONFLICT (id) DO UPDATE SET path=EXCLUDED.path, title=EXCLUDED.title, body=EXCLUDED.body, tags=EXCLUDED.tags,
           summary=EXCLUDED.summary, source=EXCLUDED.source, status=EXCLUDED.status, content_hash=EXCLUDED.content_hash,
           client_id=COALESCE(EXCLUDED.client_id, notes.client_id)`,
        [n.id, n.path, n.title, n.body, n.tags, n.summary, n.source, n.status, n.contentHash, n.clientId ?? null, n.createdAt ?? null],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async getNoteByClientId(clientId: string) {
    const r = await this.pool.query(`SELECT ${COLS} FROM notes WHERE client_id=$1`, [clientId]);
    return r.rows[0] ? toNote(r.rows[0]) : null;
  }
  async getNote(id: string) {
    const r = await this.pool.query(`SELECT ${COLS} FROM notes WHERE id=$1`, [id]);
    return r.rows[0] ? toNote(r.rows[0]) : null;
  }
  async getNotes(ids: string[]) {
    const r = await this.pool.query(`SELECT ${COLS} FROM notes WHERE id = ANY($1)`, [ids]);
    return r.rows.map(toNote);
  }
  async deleteMissing(paths: string[]) {
    const r = await this.pool.query("DELETE FROM notes WHERE NOT (path = ANY($1))", [paths]);
    return r.rowCount ?? 0;
  }
  async setEmbedding(id: string, v: number[]) {
    await this.pool.query("UPDATE notes SET embedding=$2::vector WHERE id=$1", [id, vec(v)]);
  }

  async searchFts(q: string, limit: number) {
    const r = await this.pool.query(
      `SELECT id FROM notes WHERE fts @@ websearch_to_tsquery('german', $1)
       ORDER BY ts_rank(fts, websearch_to_tsquery('german', $1)) DESC LIMIT $2`,
      [q, limit],
    );
    return r.rows.map((x) => x.id as string);
  }
  async searchTrgm(q: string, limit: number) {
    const r = await this.pool.query(
      `SELECT id FROM notes WHERE $1 <% trgm_text ORDER BY word_similarity($1, trgm_text) DESC LIMIT $2`,
      [q, limit],
    );
    return r.rows.map((x) => x.id as string);
  }
  async searchVector(v: number[], limit: number) {
    const r = await this.pool.query(
      "SELECT id FROM notes WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT $2",
      [vec(v), limit],
    );
    return r.rows.map((x) => x.id as string);
  }

  async createDevice(id: string, name: string, tokenHash: string) {
    await this.pool.query("INSERT INTO devices (id, name, token_hash) VALUES ($1,$2,$3)", [id, name, tokenHash]);
  }
  async findDeviceByTokenHash(hash: string): Promise<Device | null> {
    const r = await this.pool.query("SELECT id, name FROM devices WHERE token_hash=$1", [hash]);
    return r.rows[0] ?? null;
  }
  async listDevices(): Promise<Device[]> {
    return (await this.pool.query("SELECT id, name FROM devices ORDER BY created_at")).rows;
  }

  async addWebhook(w: Webhook) {
    await this.pool.query("INSERT INTO webhooks (id, url, secret) VALUES ($1,$2,$3)", [w.id, w.url, w.secret]);
  }
  async listWebhooks(): Promise<Webhook[]> {
    return (await this.pool.query("SELECT id, url, secret FROM webhooks")).rows;
  }

  async consumeLlmQuota(day: string, limit: number) {
    const r = await this.pool.query(
      // WHERE $2 > 0: with a limit of 0 the first call must not create a row (that would burn quota that was never granted)
      `INSERT INTO llm_usage (day, count) SELECT $1::date, 1 WHERE $2::int > 0
       ON CONFLICT (day) DO UPDATE SET count = llm_usage.count + 1 WHERE llm_usage.count < $2::int
       RETURNING count`,
      [day, limit],
    );
    return r.rowCount === 1;
  }

  async claimInstruction(i: InstructionRow) {
    const r = await this.pool.query(
      `INSERT INTO claude_instructions (id, note_id, instruction_hash, status, stage, result) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (note_id, instruction_hash) DO NOTHING`,
      [i.id, i.noteId, i.hash, i.status, i.stage, i.result],
    );
    return r.rowCount === 1;
  }
  async updateInstruction(id: string, patch: Partial<Pick<InstructionRow, "stage" | "status" | "result">>) {
    await this.pool.query("UPDATE claude_instructions SET stage=COALESCE($2,stage), status=COALESCE($3,status), result=COALESCE($4,result) WHERE id=$1", [
      id, patch.stage ?? null, patch.status ?? null, patch.result ?? null,
    ]);
  }
  async getInstructions(noteId: string): Promise<InstructionRow[]> {
    const r = await this.pool.query("SELECT id, note_id, instruction_hash, status, stage, result FROM claude_instructions WHERE note_id=$1", [noteId]);
    return r.rows.map((x) => ({ id: x.id, noteId: x.note_id, hash: x.instruction_hash, status: x.status, stage: x.stage, result: x.result }));
  }

  async recordConflict(p: string, kind: string, detail?: string) {
    await this.pool.query("INSERT INTO conflicts (path, kind, detail) VALUES ($1,$2,$3) ON CONFLICT (path, kind) DO NOTHING", [p, kind, detail ?? null]);
  }
  async listConflicts() {
    return (await this.pool.query("SELECT path, kind, detail FROM conflicts ORDER BY at")).rows;
  }
}

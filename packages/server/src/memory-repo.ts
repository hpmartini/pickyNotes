import type { Device, InstructionRow, NoteRow, NoteUpsert, Repo, Webhook } from "./repo.js";

const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0); // vectors are normalized
const trigrams = (s: string) => {
  const t = ` ${s.toLowerCase()} `;
  return new Set(Array.from({ length: Math.max(0, t.length - 2) }, (_, i) => t.slice(i, i + 3)));
};

/** Test double with the same observable behaviour as PgRepo (incl. the unique instruction key). */
export class MemoryRepo implements Repo {
  notes = new Map<string, NoteRow>();
  private vecs = new Map<string, number[]>();
  private devices = new Map<string, Device & { hash: string }>();
  private hooks: Webhook[] = [];
  private usage = new Map<string, number>();
  private instr = new Map<string, InstructionRow>();
  private conflicts: { path: string; kind: string; detail: string | null }[] = [];

  async upsertNote(n: NoteUpsert) {
    const prev = [...this.notes.values()].find((x) => x.path === n.path || x.id === n.id);
    if (prev && prev.id !== n.id) this.notes.delete(prev.id);
    this.notes.set(n.id, { ...n, createdAt: n.createdAt ?? prev?.createdAt ?? new Date().toISOString() });
  }
  async getNote(id: string) {
    return this.notes.get(id) ?? null;
  }
  async getNotes(ids: string[]) {
    return ids.flatMap((id) => this.notes.get(id) ?? []);
  }
  async deleteMissing(paths: string[]) {
    const keep = new Set(paths);
    let n = 0;
    for (const [id, note] of this.notes) if (!keep.has(note.path)) (this.notes.delete(id), n++);
    return n;
  }
  async setEmbedding(id: string, vec: number[]) {
    this.vecs.set(id, vec);
  }

  private rank(score: (n: NoteRow) => number, limit: number) {
    return [...this.notes.values()]
      .map((n) => ({ id: n.id, s: score(n) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.id);
  }
  async searchFts(q: string, limit: number) {
    const qt = tokens(q);
    return this.rank((n) => {
      const t = new Set(tokens(`${n.title} ${n.body}`));
      return qt.filter((w) => t.has(w)).length;
    }, limit);
  }
  async searchTrgm(q: string, limit: number) {
    const qg = trigrams(q);
    return this.rank((n) => {
      const g = trigrams(`${n.title} ${n.body}`);
      const hit = [...qg].filter((x) => g.has(x)).length / Math.max(1, qg.size);
      return hit > 0.3 ? hit : 0;
    }, limit);
  }
  async searchVector(vec: number[], limit: number) {
    return this.rank((n) => {
      const v = this.vecs.get(n.id);
      return v ? cosine(vec, v) : 0;
    }, limit);
  }

  async createDevice(id: string, name: string, hash: string) {
    this.devices.set(id, { id, name, hash });
  }
  async findDeviceByTokenHash(hash: string) {
    const d = [...this.devices.values()].find((x) => x.hash === hash);
    return d ? { id: d.id, name: d.name } : null;
  }
  async listDevices() {
    return [...this.devices.values()].map(({ id, name }) => ({ id, name }));
  }

  async addWebhook(w: Webhook) {
    this.hooks.push(w);
  }
  async listWebhooks() {
    return this.hooks;
  }

  async consumeLlmQuota(day: string, limit: number) {
    const n = this.usage.get(day) ?? 0;
    if (n >= limit) return false;
    this.usage.set(day, n + 1);
    return true;
  }

  async claimInstruction(i: InstructionRow) {
    if ([...this.instr.values()].some((x) => x.noteId === i.noteId && x.hash === i.hash)) return false;
    this.instr.set(i.id, { ...i });
    return true;
  }
  async setInstructionStatus(id: string, status: InstructionRow["status"]) {
    const i = this.instr.get(id);
    if (i) i.status = status;
  }
  async getInstructions(noteId: string) {
    return [...this.instr.values()].filter((i) => i.noteId === noteId);
  }

  async recordConflict(path: string, kind: string, detail?: string) {
    if (!this.conflicts.some((c) => c.path === path && c.kind === kind)) this.conflicts.push({ path, kind, detail: detail ?? null });
  }
  async listConflicts() {
    return this.conflicts;
  }
}

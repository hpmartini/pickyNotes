import type { Note } from "@pickynotes/shared";

export interface NoteRow extends Note {
  contentHash: string | null;
}
export type NoteUpsert = Omit<NoteRow, "createdAt"> & { createdAt?: string };

export interface Device {
  id: string;
  name: string;
}
export interface Webhook {
  id: string;
  url: string;
  secret: string;
}
export interface InstructionRow {
  id: string;
  noteId: string;
  hash: string;
  status: "pending" | "done" | "failed";
}

/** Everything the app needs from storage. Implemented by PgRepo (prod) and MemoryRepo (tests). */
export interface Repo {
  upsertNote(n: NoteUpsert): Promise<void>;
  getNote(id: string): Promise<NoteRow | null>;
  getNotes(ids: string[]): Promise<NoteRow[]>;
  /** Drops index rows whose files vanished. Never touches the vault. */
  deleteMissing(paths: string[]): Promise<number>;
  setEmbedding(id: string, vec: number[]): Promise<void>;

  /** Ranked id lists for hybrid search. */
  searchFts(q: string, limit: number): Promise<string[]>;
  searchTrgm(q: string, limit: number): Promise<string[]>;
  searchVector(vec: number[], limit: number): Promise<string[]>;

  createDevice(id: string, name: string, tokenHash: string): Promise<void>;
  findDeviceByTokenHash(hash: string): Promise<Device | null>;
  listDevices(): Promise<Device[]>;

  addWebhook(w: Webhook): Promise<void>;
  listWebhooks(): Promise<Webhook[]>;

  /** True if the day's counter was incremented, false if `limit` is already reached. */
  consumeLlmQuota(day: string, limit: number): Promise<boolean>;

  /** Exactly-once guard: false if (noteId, hash) was already claimed. */
  claimInstruction(i: InstructionRow): Promise<boolean>;
  setInstructionStatus(id: string, status: InstructionRow["status"]): Promise<void>;
  getInstructions(noteId: string): Promise<InstructionRow[]>;

  recordConflict(path: string, kind: string, detail?: string): Promise<void>;
  listConflicts(): Promise<{ path: string; kind: string; detail: string | null }[]>;
}

import type { Note, Suggestion, SuggestionStatus } from "@pickynotes/shared";

export interface NoteRow extends Note {
  contentHash: string | null;
  /** Client-generated capture id; unique, lets retried captures resolve to the existing note. */
  clientId?: string | null;
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
/** Progress of one @claude instruction; a retry resumes after the last completed stage. */
export type InstructionStage = "claimed" | "callout_written" | "executing" | "executed" | "published";
export interface InstructionRow {
  id: string;
  noteId: string;
  hash: string;
  /** Status shown in the note's callout. */
  status: "pending" | "done" | "failed";
  stage: InstructionStage;
  /** Model answer (or error text), stored at `executed`; a retry never calls the model again (not even after `executing`). */
  result: string | null;
}

/** Everything the app needs from storage. Implemented by PgRepo (prod) and MemoryRepo (tests). */
export interface Repo {
  upsertNote(n: NoteUpsert): Promise<void>;
  getNote(id: string): Promise<NoteRow | null>;
  getNoteByClientId(clientId: string): Promise<NoteRow | null>;
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

  /** True if the day's counter was incremented, false if `limit` is already reached (a limit of 0 never consumes). */
  consumeLlmQuota(day: string, limit: number): Promise<boolean>;

  /** Exactly-once guard: false if (noteId, hash) was already claimed. */
  claimInstruction(i: InstructionRow): Promise<boolean>;
  updateInstruction(id: string, patch: Partial<Pick<InstructionRow, "stage" | "status" | "result">>): Promise<void>;
  getInstructions(noteId: string): Promise<InstructionRow[]>;

  /** Idempotent per (noteId, title): true only if the suggestion is new. */
  addSuggestion(s: Omit<Suggestion, "status" | "createdAt">): Promise<boolean>;
  listSuggestions(status: SuggestionStatus): Promise<Suggestion[]>;
  /** Records a decision only; returns null for an unknown id. */
  setSuggestionStatus(id: string, status: SuggestionStatus): Promise<Suggestion | null>;

  recordConflict(path: string, kind: string, detail?: string): Promise<void>;
  listConflicts(): Promise<{ path: string; kind: string; detail: string | null }[]>;
}

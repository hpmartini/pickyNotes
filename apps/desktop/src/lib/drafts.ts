import type { Note, NotesState } from "./notes";

/** Plain-file second copy of every open note (Rust `drafts_*` commands), so a lost localStorage cannot lose a note. */
export interface DraftStore {
  write(id: string, text: string): Promise<void>;
  list(): Promise<Note[]>;
  remove(id: string): Promise<void>;
}

/** Notes the localStorage state does not know are added; an existing note is never replaced, and an empty draft is not worth a tab. */
export function restoreDrafts(state: NotesState, drafts: Note[]): NotesState {
  const known = new Set(state.notes.map((n) => n.id));
  const extra = drafts.filter((d) => !known.has(d.id) && d.text.trim());
  return extra.length ? { ...state, notes: [...state.notes, ...extra] } : state;
}

/**
 * What to do on disk after `prev` became `next`: write notes that are new or changed, delete files of notes that are gone.
 * An empty note is never written, so an emptied note keeps its last non-empty draft on disk.
 */
export function draftChanges(prev: Note[], next: Note[]): { writes: Note[]; deletes: string[] } {
  const before = new Map(prev.map((n) => [n.id, n.text]));
  const ids = new Set(next.map((n) => n.id));
  return {
    writes: next.filter((n) => n.text.trim() && before.get(n.id) !== n.text),
    deletes: prev.filter((n) => !ids.has(n.id)).map((n) => n.id),
  };
}

/**
 * Debounced writer: `update` after every notes change, `flush` when the window hides or unloads.
 * Disk operations run one after another, so a delete can never be overtaken by an older write of the same note.
 */
export function createDraftSaver(store: Pick<DraftStore, "write" | "remove">, delayMs = 500) {
  let prev: Note[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();
  const pending = new Map<string, string>();
  const run = (op: () => Promise<void>) => (tail = tail.then(op).catch((e) => console.warn("Entwurf nicht gesichert:", e)));

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    for (const [id, text] of pending) void run(() => store.write(id, text));
    pending.clear();
    return tail;
  };

  return {
    update(notes: Note[]) {
      const { writes, deletes } = draftChanges(prev, notes);
      prev = notes;
      for (const n of writes) pending.set(n.id, n.text);
      for (const id of deletes) {
        pending.delete(id);
        void run(() => store.remove(id));
      }
      if (writes.length) {
        clearTimeout(timer);
        timer = setTimeout(flush, delayMs);
      }
    },
    flush,
  };
}

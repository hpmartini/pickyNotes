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

type Op = { kind: "write"; id: string; text: string } | { kind: "delete"; id: string };

/**
 * Debounced writer: `update` after every notes change, `flush` when the window hides or unloads.
 * Operations sit in an ordered queue and run one after another; one leaves the queue only after it succeeded.
 * A failed one is reported, stops the run (so a delete is never overtaken by an older write of the same note)
 * and is retried by the next `flush` or `update`.
 */
export function createDraftSaver(store: Pick<DraftStore, "write" | "remove">, delayMs = 500) {
  let prev: Note[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Op[] = [];
  let inflight: Op | undefined;
  let running: Promise<void> | undefined;

  const drain = () =>
    (running ??= (async () => {
      try {
        for (let op = queue[0]; op; op = queue[0]) {
          inflight = op;
          try {
            await (op.kind === "write" ? store.write(op.id, op.text) : store.remove(op.id));
          } catch (e) {
            return console.warn("Entwurf nicht gesichert:", e);
          }
          queue.shift();
        }
      } finally {
        inflight = running = undefined;
      }
    })());

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    return drain();
  };

  return {
    update(notes: Note[]) {
      const { writes, deletes } = draftChanges(prev, notes);
      prev = notes;
      for (const { id, text } of writes) {
        const last = queue.filter((o) => o.id === id).pop();
        if (last?.kind === "write" && last !== inflight) last.text = text; // newest text replaces the write that has not run yet
        else queue.push({ kind: "write", id, text });
      }
      for (const id of deletes) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i]?.id === id && queue[i] !== inflight) queue.splice(i, 1);
        queue.push({ kind: "delete", id });
      }
      if (deletes.length) void drain();
      if (queue.length) {
        clearTimeout(timer);
        timer = setTimeout(flush, delayMs);
      }
    },
    flush,
  };
}

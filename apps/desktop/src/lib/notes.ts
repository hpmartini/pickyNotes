/** Open notes (one tab each). Persisted so drafts survive restarts. */
export interface Note {
  id: string;
  text: string;
}
export interface NotesState {
  active: string;
  notes: Note[];
}

const KEY = "picky.notes";
const LEGACY_DRAFT_KEY = "picky.draft"; // single draft before note tabs; migrated into the first note

export const newNote = (text = ""): Note => ({ id: crypto.randomUUID(), text });

/** First non-empty line, or "Neue Notiz". */
export const noteTitle = (text: string): string => text.split("\n").find((l) => l.trim())?.trim().slice(0, 40) || "Neue Notiz";

export const activeNote = (s: NotesState): Note => s.notes.find((n) => n.id === s.active) ?? s.notes[0]!;

export function addNote(s: NotesState): NotesState {
  const n = newNote();
  return { active: n.id, notes: [...s.notes, n] };
}

export function setNoteText(s: NotesState, id: string, text: string): NotesState {
  if (s.notes.find((n) => n.id === id)?.text === text) return s;
  return { ...s, notes: s.notes.map((n) => (n.id === id ? { ...n, text } : n)) };
}

/** Closes a tab; the last remaining note is replaced by an empty one (new id, so the editor remounts empty). */
export function closeNote(s: NotesState, id: string): NotesState {
  if (s.notes.length <= 1) return addNote({ active: "", notes: [] });
  const i = s.notes.findIndex((n) => n.id === id);
  const notes = s.notes.filter((n) => n.id !== id);
  return { active: s.active === id ? notes[Math.min(i, notes.length - 1)]!.id : s.active, notes };
}

export function saveNotes(s: NotesState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: notes stay in memory only */
  }
}

export function loadNotes(): NotesState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as NotesState | null;
    if (parsed?.notes?.length && parsed.notes.every((n) => typeof n.id === "string" && typeof n.text === "string")) return { ...parsed, active: activeNote(parsed).id };
    const note = newNote(localStorage.getItem(LEGACY_DRAFT_KEY) ?? "");
    const state = { active: note.id, notes: [note] };
    saveNotes(state);
    localStorage.removeItem(LEGACY_DRAFT_KEY);
    return state;
  } catch {
    const note = newNote();
    return { active: note.id, notes: [note] };
  }
}

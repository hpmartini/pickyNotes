import { afterEach, describe, expect, it } from "vitest";
import { activeNote, addNote, closeNote, loadNotes, noteTitle, saveNotes, setNoteText } from "./notes";

afterEach(() => localStorage.clear());

describe("notes", () => {
  it("migrates the legacy draft into the first note and removes the old key", () => {
    localStorage.setItem("picky.draft", "- Entwurf");
    const s = loadNotes();
    expect(s.notes.map((n) => n.text)).toEqual(["- Entwurf"]);
    expect(localStorage.getItem("picky.draft")).toBeNull();
    expect(loadNotes()).toEqual(s); // second load reads picky.notes
  });

  it("starts with one empty note and ignores a legacy draft once notes exist", () => {
    expect(loadNotes().notes.map((n) => n.text)).toEqual([""]);
    const s = addNote(loadNotes());
    saveNotes(s);
    localStorage.setItem("picky.draft", "alt");
    expect(loadNotes()).toEqual(s);
  });

  it("falls back to a fresh note on corrupt storage", () => {
    localStorage.setItem("picky.notes", "{kaputt");
    expect(loadNotes().notes).toHaveLength(1);
    localStorage.setItem("picky.notes", JSON.stringify({ active: "x", notes: [{ id: 1 }] }));
    expect(loadNotes().notes[0]!.text).toBe("");
  });

  it("addNote activates the new tab, setNoteText edits one note", () => {
    const a = addNote(setNoteText(loadNotes(), loadNotes().active, "eins"));
    expect(a.notes).toHaveLength(2);
    expect(a.active).toBe(a.notes[1]!.id);
    expect(setNoteText(a, a.active, "zwei").notes.map((n) => n.text)).toEqual(["eins", "zwei"]);
    expect(setNoteText(a, a.active, "").notes).toBe(a.notes); // unchanged: same reference, no re-render
  });

  it("closeNote removes a tab, moves the selection to the neighbour and clears the last note", () => {
    let s = loadNotes();
    s = setNoteText(s, s.active, "a");
    s = addNote(s);
    s = setNoteText(s, s.active, "b");
    const [a, b] = s.notes;
    expect(closeNote(s, b!.id)).toEqual({ active: a!.id, notes: [a] });
    expect(closeNote({ ...s, active: a!.id }, b!.id).active).toBe(a!.id); // closing another tab keeps the active one
    const last = closeNote(closeNote(s, b!.id), a!.id);
    expect(last.notes).toHaveLength(1);
    expect(activeNote(last).text).toBe("");
    expect(last.active).not.toBe(a!.id); // new id: the editor remounts empty
  });

  it("noteTitle is the first non-empty line or Neue Notiz", () => {
    expect(noteTitle("")).toBe("Neue Notiz");
    expect(noteTitle("\n  \n# Titel\nrest")).toBe("# Titel");
    expect(noteTitle("x".repeat(100))).toHaveLength(40);
  });
});

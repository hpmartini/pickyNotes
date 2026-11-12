import { describe, expect, it } from "vitest";
import { buildIcs, hasLocalAttachments, terminDefaults, terminValid, vaultFile } from "./export";

const now = new Date(2026, 10, 12, 9, 5, 7); // local 2026-11-12 09:05

describe("vaultFile", () => {
  it("names the file by date, time and a slug of the first line, and puts the origin in the frontmatter", () => {
    const f = vaultFile("# Übergröße: Idee/../für MAGOS!\n\nText  \n\n", now);
    expect(f.name).toBe("2026-11-12-0905-uebergroesse-idee-fuer-magos");
    expect(f.name).toMatch(/^[a-z0-9-]{1,80}$/);
    expect(f.markdown).toBe(`---\nquelle: pickyNotes\nerstellt: ${now.toISOString()}\n---\n\n# Übergröße: Idee/../für MAGOS!\n\nText\n`);
  });

  it("falls back to 'notiz', caps the slug, and keeps a note's own frontmatter", () => {
    expect(vaultFile("🙂", now).name).toBe("2026-11-12-0905-notiz");
    expect(vaultFile("x".repeat(200), now).name.length).toBeLessThanOrEqual(80);
    expect(vaultFile("---\ntype: idee\n---\nText", now).markdown).toBe("---\ntype: idee\n---\nText\n");
  });

  it("sees attachments that only live in the app", () => {
    expect(hasLocalAttachments("a ![bild](pending:abc) b")).toBe(true);
    expect(hasLocalAttachments("[x](https://example.org) pending: nichts")).toBe(false);
  });
});

describe("Termin", () => {
  it("defaults to the note title and the next full hour, also across midnight", () => {
    expect(terminDefaults("## Zahnarzt anrufen\nmehr", now)).toEqual({ title: "Zahnarzt anrufen", date: "2026-11-12", start: "10:00", minutes: 60 });
    expect(terminDefaults("x", new Date(2026, 11, 31, 23, 30))).toMatchObject({ date: "2027-01-01", start: "00:00" });
  });

  it("validates the form", () => {
    const ok = { title: "a", date: "2026-11-12", start: "10:00", minutes: 30 };
    expect(terminValid(ok)).toBe(true);
    for (const bad of [{ title: " " }, { date: "" }, { start: "" }, { minutes: 0 }, { minutes: NaN }, { minutes: 1.5 }]) expect(terminValid({ ...ok, ...bad })).toBe(false);
  });

  it("builds an RFC 5545 event: CRLF, floating local time, escaped text, end on the next day", () => {
    const ics = buildIcs({ title: "Essen; Trinken, Reden\\", date: "2026-11-12", start: "23:30", minutes: 90 }, "Zeile 1\nZeile 2", now, "u1");
    expect(ics.split("\r\n")).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Martini Labs//pickyNotes//DE",
      "BEGIN:VEVENT",
      "UID:u1@pickynotes",
      `DTSTAMP:${now.toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
      "DTSTART:20261112T233000",
      "DTEND:20261113T010000",
      "SUMMARY:Essen\\; Trinken\\, Reden\\\\",
      "DESCRIPTION:Zeile 1\\nZeile 2",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it("folds long lines at 75 octets without splitting a character, and unfolding gives the text back", () => {
    const text = "äöü€🙂 ".repeat(40).trim();
    const ics = buildIcs({ title: "t", date: "2026-11-12", start: "10:00", minutes: 60 }, text, now, "u1");
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    for (const line of ics.split("\r\n")) expect(bytes(line)).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${text}\r\n`);
  });
});

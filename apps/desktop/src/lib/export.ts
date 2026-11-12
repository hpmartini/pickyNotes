import { noteTitle } from "./notes";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Attachments that only exist in this app (`pending:<id>`): such a note would carry dead links outside the app. */
export const hasLocalAttachments = (text: string): boolean => /\]\(pending:/.test(text);

/** File name (no extension, only [a-z0-9-], what Rust `vault_write` accepts) and Markdown body for the MAGOS vault inbox. */
export function vaultFile(text: string, now: Date): { name: string; markdown: string } {
  const slug = noteTitle(text)
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c]!)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  const body = `${text.trimEnd()}\n`;
  return {
    name: `${ymd(now)}-${pad(now.getHours())}${pad(now.getMinutes())}-${slug || "notiz"}`,
    // A note that brings its own frontmatter keeps it; two blocks would break it.
    markdown: text.startsWith("---\n") ? body : `---\nquelle: pickyNotes\nerstellt: ${now.toISOString()}\n---\n\n${body}`,
  };
}

export interface Termin {
  title: string;
  /** YYYY-MM-DD, local */
  date: string;
  /** HH:MM, local */
  start: string;
  minutes: number;
}

/** Form defaults: the note title, the next full hour, one hour long. */
export function terminDefaults(text: string, now: Date): Termin {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return { title: noteTitle(text).replace(/^#+\s*/, ""), date: ymd(d), start: hm(d), minutes: 60 };
}

export const terminValid = (t: Termin): boolean =>
  !!t.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && /^\d{2}:\d{2}$/.test(t.start) && Number.isInteger(t.minutes) && t.minutes >= 1 && t.minutes <= 24 * 60;

const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 3.1: lines of at most 75 octets, continued with CRLF + space; never splits a character. */
function fold(line: string): string {
  const enc = new TextEncoder();
  let out = "";
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 75) {
      out += "\r\n ";
      len = 1;
    }
    out += ch;
    len += n;
  }
  return out;
}

/** One VEVENT in floating local time (no TZID): the calendar app reads it in the time zone of this Mac. */
export function buildIcs(t: Termin, description: string, now: Date, uid: string = crypto.randomUUID()): string {
  const [y, mo, d] = t.date.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.start.split(":").map(Number) as [number, number];
  const local = (x: Date) => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Martini Labs//pickyNotes//DE",
    "BEGIN:VEVENT",
    `UID:${uid}@pickynotes`,
    `DTSTAMP:${now.toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    `DTSTART:${local(new Date(y, mo - 1, d, h, mi))}`,
    `DTEND:${local(new Date(y, mo - 1, d, h, mi + t.minutes))}`, // Date carries the overflow into the next day
    `SUMMARY:${escapeText(t.title.trim())}`,
    `DESCRIPTION:${escapeText(description.trim())}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .map(fold)
    .join("\r\n");
}

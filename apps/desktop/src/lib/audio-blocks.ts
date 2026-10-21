import { AUDIO_MAX_SECONDS } from "@pickynotes/shared";
import type { EditorView } from "@codemirror/view";
import { getAttachment } from "./attachments";
import { transcribeAudio } from "./tauri";

/**
 * Audio block in the note text (plain Markdown, readable without the app):
 *   [🎙 Aufnahme 2026-10-21 14:03 (3:12)](pending:<id>)      <- the server rewrites the target to raw/attachments/...
 *   > Transkript: <one line of text>
 * The link label starting with "🎙 " and the `> Transkript:` line directly below it are the marker the app finds and replaces.
 */
export const AUDIO_LABEL_PREFIX = "🎙 ";
export const TRANSCRIPT_PREFIX = "> Transkript:";

export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const pad = (n: number) => String(n).padStart(2, "0");

export const audioLabel = (now: Date, seconds: number): string =>
  `${AUDIO_LABEL_PREFIX}Aufnahme ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} (${formatDuration(Math.min(seconds, AUDIO_MAX_SECONDS))})`;

/** WKWebView records audio/mp4 (AAC), Chromium audio/webm (Opus); first supported type wins, undefined = let the browser choose. */
export const pickRecorderMime = (isSupported: (type: string) => boolean): string | undefined =>
  ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(isSupported);

const EXT: Record<string, string> = { "audio/mp4": "m4a", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };
export const audioExt = (mime: string): string => EXT[mime.split(";")[0]!.trim().toLowerCase()] ?? "m4a";

/** The `> Transkript:` line right below the link that ends at `linkTo`, if there is one. */
export function transcriptLineAfter(text: string, linkTo: number): { from: number; to: number; text: string } | null {
  if (!text.startsWith(`\n${TRANSCRIPT_PREFIX}`, linkTo)) return null;
  const from = linkTo + 1;
  const nl = text.indexOf("\n", from);
  const to = nl === -1 ? text.length : nl;
  return { from, to, text: text.slice(from + TRANSCRIPT_PREFIX.length, to).trim() };
}

/** Change that puts `transcript` into the block of attachment `id` (replaces an existing quote line); null if the block is gone. */
export function transcriptChange(doc: string, id: string, transcript: string): { from: number; to: number; insert: string } | null {
  const m = new RegExp(`\\[${AUDIO_LABEL_PREFIX}[^\\]\\n]*\\]\\(pending:${id}\\)`).exec(doc);
  if (!m) return null;
  const end = m.index + m[0].length;
  const line = `${TRANSCRIPT_PREFIX} ${transcript.replace(/\s+/g, " ").trim()}`;
  const old = transcriptLineAfter(doc, end);
  if (old) return { from: old.from, to: old.to, insert: line };
  // A line directly below a quote would be read as its lazy continuation: keep a blank line after it.
  const nextLineFilled = doc[end] === "\n" && doc[end + 1] !== undefined && doc[end + 1] !== "\n";
  return { from: end, to: end, insert: `\n${line}${nextLineFilled ? "\n" : ""}` };
}

// --- per-recording UI state (not part of the note text) ---------------------------------------------------------------------------------
export interface AudioInfo {
  transcribing?: boolean;
  error?: string;
  playing?: boolean;
  collapsed?: boolean;
}
const infos = new Map<string, AudioInfo>();
const listeners = new Set<() => void>();
export const audioInfo = (id: string): AudioInfo => infos.get(id) ?? {};
export function patchAudio(id: string, patch: AudioInfo): void {
  infos.set(id, { ...audioInfo(id), ...patch });
  listeners.forEach((l) => l());
}
export const subscribeAudio = (l: () => void): (() => void) => (listeners.add(l), () => void listeners.delete(l));

const players = new Map<string, HTMLAudioElement>();
/** Play/pause the stashed recording; only one plays at a time. */
export async function togglePlay(id: string): Promise<void> {
  let el = players.get(id);
  if (!el) {
    const a = await getAttachment(id);
    if (!a) return patchAudio(id, { error: "Aufnahme nicht gefunden" });
    el = new Audio(URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime })));
    el.onplay = () => patchAudio(id, { playing: true });
    el.onpause = el.onended = () => patchAudio(id, { playing: false });
    players.set(id, el);
  }
  if (!el.paused) return el.pause();
  for (const other of players.values()) if (other !== el) other.pause();
  await el.play().catch(() => patchAudio(id, { playing: false }));
}

/** Sends the stashed recording to WhisperStorm and writes the text into the block. The recording stays whatever happens. */
export async function transcribeBlock(view: EditorView, id: string): Promise<void> {
  patchAudio(id, { transcribing: true, error: undefined });
  try {
    const a = await getAttachment(id);
    if (!a) throw new Error("Aufnahme nicht gefunden");
    const r = await transcribeAudio(a.bytes, audioExt(a.mime));
    const text = r.text?.trim();
    if (!r.ok || !text) throw new Error(r.ok ? "Kein Text erkannt" : (r.error ?? "Transkription fehlgeschlagen"));
    const change = transcriptChange(view.state.doc.toString(), id, text); // against the doc as it is now: the user may have kept typing
    if (change) view.dispatch({ changes: change });
    patchAudio(id, { transcribing: false });
  } catch (e) {
    patchAudio(id, { transcribing: false, error: e instanceof Error ? e.message : String(e) });
  }
}

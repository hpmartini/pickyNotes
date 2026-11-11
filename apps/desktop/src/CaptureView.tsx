import { AtomicCodeMirrorEditor, type AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import type { CaptureInput } from "@pickynotes/shared";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptureQueue, Enqueued, QueuedCapture, Send } from "./lib/queue";
import { inTauri, whisperstorm } from "./lib/tauri";
import { readAttachmentsForSend, dropAttachments, restoreAttachments } from "./lib/attachments";
import type { Note } from "./lib/notes";
import { PendingModal } from "./PendingModal";
import { dispatchInsertTable, editorExtensions, insertAttachmentAt, insertTextAtCursor } from "./lib/editor";
import { AUDIO_MAX_SECONDS } from "@pickynotes/shared";
import { audioExt, audioInfo, audioLabel, formatDuration, pendingTranscriptions, transcribeBlock } from "./lib/audio-blocks";
import { startRecorder, type Recorder } from "./lib/recorder";

const MAX_BYTES = 100 * 1024 * 1024; // sanity cap against freezing the webview; the server decides (413 above MAX_ATTACHMENT_MB without an object store)

interface Props {
  queue: CaptureQueue;
  send: Send;
  screenshot?: () => Promise<string | null>;
  /** Global hotkey request: focus the editor, and start/stop dictation when `toggle`. */
  hotkey?: { toggle: boolean } | null;
  onHotkeyHandled?: () => void;
  /** All open notes; the active one is edited. Links in the others keep their attachment bytes. */
  notes: Note[];
  activeId: string;
  onChange: (text: string) => void;
  /** The note was delivered and is unchanged: close its tab (or clear it if it is the last). */
  onSent: (id: string) => void;
  /** A modal is open: the editor takes no focus or input. */
  inert?: boolean;
  /** False while the server URL or token is missing: saving then only queues. Default: configured. */
  configured?: () => Promise<boolean>;
  /** "Als Notiz öffnen": the text of a pending capture goes into a new note tab. */
  /** Returns true only once the new tab is persisted; the queued copies are dropped only then. */
  onOpenAsNote?: (text: string) => boolean;
  /** Shows the outbox folder in the file manager (Tauri only). */
  onRevealOutbox?: () => void;
  /** The Ausstehend modal (pending and rejected captures) is shown; App owns the flag and the topbar badge that sets it. */
  pendingOpen?: boolean;
  onClosePending?: () => void;
}

const MISSING_CONFIG = "Server-URL/Token fehlen – Notiz liegt im Postausgang";

export function CaptureView({ queue, send, screenshot, hotkey, onHotkeyHandled, notes, activeId, onChange, onSent, inert, configured, onOpenAsNote, onRevealOutbox, pendingOpen, onClosePending }: Props) {
  const text = notes.find((n) => n.id === activeId)?.text ?? "";
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sending = useRef(false); // Save is waiting for a transcription: a second click must not send twice
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false); // start can wait on the microphone prompt for up to 30 s
  const [audioElapsed, setAudioElapsed] = useState<number | null>(null); // seconds while a voice note is being recorded
  const audioRec = useRef<{ recorder: Recorder; startedAt: number; tick: number; limit: number } | null>(null);
  const [items, setItems] = useState<QueuedCapture[]>([]);
  const rejected = items.filter((i) => i.rejected);
  const pending = items.filter((i) => !i.rejected);
  const editorRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);

  useEffect(() => {
    const refresh = () => void queue.list().then(setItems, () => {});
    refresh();
    return queue.subscribe(refresh);
  }, [queue]);

  /** A failing credential read (keychain) counts as not ready and keeps its message; it must not stop the capture from being stored. */
  async function readiness(): Promise<{ ready: boolean; error?: string }> {
    try {
      return { ready: !configured || (await configured()) };
    } catch (e) {
      return { ready: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Flushes unless the server is not configured (`ready` false); then says why the capture is still waiting. */
  async function deliver(ready: boolean, error?: string) {
    if (ready) await queue.flush(send);
    else setStatus(error ? `Zugangsdaten nicht lesbar (${error}) – Notiz liegt im Postausgang` : MISSING_CONFIG);
  }

  /**
   * Reports the queue state; true if the draft may be closed: the capture was delivered, or it sits in every store
   * (`stored`) and shows up in the pending list. False if the server rejected it or a store failed.
   */
  async function settle(r: Pick<Enqueued, "key" | "stored">, attempted = true): Promise<boolean> {
    const mine = (await queue.list()).find((i) => i.key === r.key && r.key !== undefined);
    if (mine?.rejected) return setStatus(`Abgelehnt: ${mine.rejected}`), false;
    if (!mine && r.key !== undefined) return setStatus("Gesendet"), true;
    if (!r.stored) return setStatus("Postausgang nicht beschreibbar – Notiz bleibt im Editor offen"), false;
    if (attempted) setStatus(`Offline gepuffert (${(await queue.pending())} in Warteschlange)`);
    return true;
  }

  /** Store first (never lose a thought), then try to deliver. */
  async function submit(input: CaptureInput): Promise<boolean> {
    const { ready, error } = await readiness(); // checked before anything is stored or sent
    let r: Enqueued;
    try {
      r = await queue.enqueue(input);
    } catch (e) {
      setStatus(`Notiz nicht gespeichert – bleibt im Editor offen (${e instanceof Error ? e.message : e})`);
      return false;
    }
    // Only the outbox file has it: flush()/list() would hit the dead database, so say it here and keep the draft.
    if (r.key === undefined) return setStatus("Nur im Postausgang gesichert, Warteschlange nicht erreichbar – Notiz bleibt im Editor offen"), false;
    await deliver(ready, error);
    return settle(r, ready);
  }

  async function retry(key: number) {
    const { ready, error } = await readiness();
    await queue.retry(key);
    await deliver(ready, error);
    await settle({ key, stored: true }, ready);
  }

  async function discard(key: number) {
    await queue.discard(key);
  }

  /** The text goes into a new tab first; only then does the capture leave the queue and the outbox. */
  async function openAsNote(item: QueuedCapture) {
    await restoreAttachments(item.input.attachments);
    if (!onOpenAsNote?.(item.input.text ?? "")) return setStatus("Notiz nicht gespeichert – bleibt im Postausgang");
    await queue.discard(item.key!);
  }

  /** Resolve the live CM6 view from the editor's content DOM. */
  function getView(): EditorView | null {
    const dom = editorRef.current?.getContentDOM();
    if (!dom) return null;
    // CM6 puts the view on the parent .cm-editor element.
    const editorEl = dom.closest(".cm-editor") as HTMLElement | null;
    return editorEl ? EditorView.findFromDOM(editorEl) : null;
  }

  async function sendText() {
    if (!text.trim() || sending.current) return;
    const id = activeId;
    let sent = text;
    // #3: a sent note is never rewritten, so Save waits for a transcription that is still running.
    const waiting = pendingTranscriptions(text);
    if (waiting.length) {
      sending.current = true;
      setStatus("Transkription läuft – Notiz wird danach gespeichert…");
      await Promise.all(waiting.map((w) => w.done)).finally(() => (sending.current = false));
      // A failed transcription must not slip the note out without its transcript: the user decides (retry in the block, or Save again).
      if (waiting.some((w) => audioInfo(w.id).error)) return setStatus("Transkription fehlgeschlagen – nicht gespeichert. Im Block erneut transkribieren oder noch einmal Speichern (dann ohne Transkript).");
      setStatus("");
      // The transcript went into the editor, not into this render's `text`.
      sent = (activeIdRef.current === id ? getView()?.state.doc.toString() : undefined) ?? notesRef.current.find((n) => n.id === id)?.text ?? text;
      if (!sent.trim()) return;
    }
    // The user may keep typing, or switch tabs, while the send is pending; close only if that note still holds what was sent. A rejected draft stays.
    const attachments = await readAttachmentsForSend(sent);
    if (await submit({ kind: "text", source: "typed", text: sent, ...(attachments.length ? { attachments } : {}) })) {
      // Links still in another open note, or in this one after the user kept typing, keep their bytes.
      const live = notesRef.current;
      await dropAttachments(sent, live.filter((n) => n.id !== id || n.text !== sent).map((n) => n.text).join("\n"));
      if (notesRef.current.find((n) => n.id === id)?.text === sent) {
        onSent(id);
      }
    }
  }

  async function toggleRecording() {
    if (starting) return; // shared by button and hotkey
    if (recording) {
      try {
        const r = await whisperstorm("stop");
        const text = r.ok ? (r.text ?? "").trim() : "";
        if (text) {
          const view = getView();
          if (view) insertTextAtCursor(view, text);
        }
        setStatus(!r.ok ? (r.error ?? "WhisperStorm Fehler") : text ? "Transkript eingefügt." : "Kein Text erkannt – nichts eingefügt.");
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
      setRecording(false);
      return;
    }
    setStarting(true);
    setStatus("Starte Aufnahme…");
    try {
      const r = await whisperstorm("start");
      if (r.ok) {
        setRecording(true);
        setStatus("");
      } else setStatus(r.error ?? "WhisperStorm läuft nicht");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  /** Voice note: records in the webview (MediaRecorder), auto-stops at AUDIO_MAX_SECONDS, then the recording becomes an attachment and is transcribed by WhisperStorm. */
  async function toggleAudio() {
    const cur = audioRec.current;
    if (cur) {
      audioRec.current = null;
      window.clearInterval(cur.tick);
      window.clearTimeout(cur.limit);
      setAudioElapsed(null);
      try {
        const { bytes, mime } = await cur.recorder.stop();
        const seconds = Math.round((Date.now() - cur.startedAt) / 1000);
        const view = getView();
        if (!view) return setStatus("Editor nicht bereit – Aufnahme verworfen");
        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
        const id = await insertAttachmentAt(view, view.state.selection.main.head, { name: `aufnahme-${stamp}.${audioExt(mime)}`, mime, bytes, label: audioLabel(now, seconds) });
        setStatus("");
        void transcribeBlock(view, id);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    setStatus("");
    try {
      const recorder = await startRecorder();
      const startedAt = Date.now();
      setAudioElapsed(0);
      audioRec.current = {
        recorder,
        startedAt,
        tick: window.setInterval(() => setAudioElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000),
        limit: window.setTimeout(() => void toggleAudioRef.current(), AUDIO_MAX_SECONDS * 1000),
      };
    } catch (e) {
      setStatus(`Mikrofon nicht verfügbar (${e instanceof Error ? e.message : e})`);
    }
  }
  const toggleAudioRef = useRef(toggleAudio);
  toggleAudioRef.current = toggleAudio;
  // Unmounted mid-recording (#4): no timer may fire into the dead view, and the microphone must close.
  useEffect(
    () => () => {
      const cur = audioRec.current;
      if (!cur) return;
      audioRec.current = null;
      window.clearInterval(cur.tick);
      window.clearTimeout(cur.limit);
      cur.recorder.cancel();
    },
    [],
  );

  // A new or switched note takes the cursor, so typing can start right away.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) editorRef.current?.getContentDOM()?.focus();
    mounted.current = true;
  }, [activeId]);

  const toggleRef = useRef(toggleRecording);
  toggleRef.current = toggleRecording;
  useEffect(() => {
    if (!hotkey) return;
    editorRef.current?.getContentDOM()?.focus();
    if (hotkey.toggle) void toggleRef.current();
    onHotkeyHandled?.();
  }, [hotkey]); // eslint-disable-line react-hooks/exhaustive-deps -- onHotkeyHandled only clears the request

  async function insertAttachment(file: { name: string; mime: string; bytes: Uint8Array }) {
    const view = getView();
    if (view) await insertAttachmentAt(view, view.state.selection.main.head, file);
  }

  async function takeScreenshot() {
    const data = await screenshot?.();
    if (!data) return;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await insertAttachment({ name: "screenshot.png", mime: "image/png", bytes });
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) return setStatus("Datei größer als 100 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await insertAttachment({ name: file.name, mime: file.type || "application/octet-stream", bytes });
  }

  function insertTable() {
    const view = getView();
    if (view) dispatchInsertTable(view);
  }

  const extensions = useMemo(() => editorExtensions, []);

  return (
    <>
    <section aria-label="Erfassen" inert={inert}>
      <div className="editor">
        <AtomicCodeMirrorEditor
          documentId={activeId} // the editor reads markdownSource only at mount; a stable id per note keeps focus while typing, a new note id remounts it
          markdownSource={text}
          onMarkdownChange={onChange}
          extensions={extensions}
          editorHandleRef={editorRef}
        />
      </div>
      <div className="actions">
        <button className="primary" onClick={sendText} disabled={!text.trim()}>Speichern</button>
        <button onClick={toggleRecording} title="Speech-to-Text (Ctrl+Alt+V)" aria-pressed={recording} disabled={starting || audioElapsed !== null}>{recording ? "Stopp" : "STT"}</button>
        <button onClick={toggleAudio} title="Sprachnotiz aufnehmen (max. 10 min)" aria-pressed={audioElapsed !== null} disabled={recording || starting}>{audioElapsed === null ? "Aufnahme" : `Stopp ${formatDuration(audioElapsed)}`}</button>
        {screenshot && <button onClick={takeScreenshot}>Screenshot</button>}
        <label className="button">
          Datei
          <input type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
        <button onClick={insertTable}>Tabelle</button>
        <p className="status" role="status" aria-live="polite">{status}</p>
      </div>
    </section>
      {pendingOpen && (
        <PendingModal
          pending={pending}
          rejected={rejected}
          onClose={() => onClosePending?.()}
          onOpenAsNote={onOpenAsNote && ((item) => void openAsNote(item))}
          onRetry={(key) => void retry(key)}
          onDiscard={(key) => void discard(key)}
          onRevealOutbox={onRevealOutbox}
        />
      )}
    </>
  );
}
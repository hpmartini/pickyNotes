import { AtomicCodeMirrorEditor, type AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import type { CaptureInput } from "@pickynotes/shared";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptureQueue, Enqueued, QueuedCapture, Send } from "./lib/queue";
import { inTauri, whisperstorm } from "./lib/tauri";
import { readAttachmentsForSend, dropAttachments, restoreAttachments } from "./lib/attachments";
import type { Note } from "./lib/notes";
import { dispatchInsertTable, editorExtensions, insertAttachmentAt, insertTextAtCursor } from "./lib/editor";

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
}

const MISSING_CONFIG = "Server-URL/Token fehlen – Notiz liegt im Postausgang";

export function CaptureView({ queue, send, screenshot, hotkey, onHotkeyHandled, notes, activeId, onChange, onSent, inert, configured, onOpenAsNote, onRevealOutbox }: Props) {
  const text = notes.find((n) => n.id === activeId)?.text ?? "";
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false); // start can wait on the microphone prompt for up to 30 s
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
    if (!text.trim()) return;
    const sent = text;
    const id = activeId;
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
        <button onClick={toggleRecording} title="Speech-to-Text (Ctrl+Alt+V)" aria-pressed={recording} disabled={starting}>{recording ? "Stopp" : "STT"}</button>
        {screenshot && <button onClick={takeScreenshot}>Screenshot</button>}
        <label className="button">
          Datei
          <input type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
        <button onClick={insertTable}>Tabelle</button>
        <p className="status" role="status" aria-live="polite">{status}</p>
      </div>
      {pending.length > 0 && (
        <section className="rejected" aria-label="Ausstehend">
          <h2>Ausstehend ({pending.length})</h2>
          <ul>
            {pending.map((i) => (
              <li key={i.key}>
                {(i.input.text ?? i.input.filename ?? i.input.kind).slice(0, 60)}{" "}
                {onOpenAsNote && i.input.text !== undefined && <button onClick={() => void openAsNote(i)}>Als Notiz öffnen</button>}{" "}
                <button onClick={() => void retry(i.key!)}>Erneut senden</button>
              </li>
            ))}
          </ul>
          {onRevealOutbox && <button onClick={onRevealOutbox}>Ordner zeigen</button>}
        </section>
      )}
      {rejected.length > 0 && (
        <section className="rejected" aria-label="Abgelehnte Captures">
          <h2>Abgelehnt</h2>
          <ul>
            {rejected.map((i) => (
              <li key={i.key}>
                {(i.input.text ?? i.input.filename ?? i.input.kind).slice(0, 60)} – {i.rejected}{" "}
                <button onClick={() => retry(i.key!)}>Erneut senden</button> <button onClick={() => discard(i.key!)}>Verwerfen</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
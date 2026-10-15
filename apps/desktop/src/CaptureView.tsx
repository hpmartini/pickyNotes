import { AtomicCodeMirrorEditor, type AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import type { CaptureInput } from "@pickynotes/shared";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptureQueue, QueuedCapture, Send } from "./lib/queue";
import { inTauri, whisperstorm } from "./lib/tauri";
import { readAttachmentsForSend, dropAttachments } from "./lib/attachments";
import { dispatchInsertTable, editorExtensions, insertAttachmentAt, insertTextAtCursor } from "./lib/editor";

const MAX_BYTES = 100 * 1024 * 1024; // sanity cap against freezing the webview; the server decides (413 above MAX_ATTACHMENT_MB without an object store)

// The draft survives tab switches (CaptureView unmounts) and restarts.
const DRAFT_KEY = "picky.draft";
const loadDraft = () => {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveDraft = (text: string) => {
  try {
    text ? localStorage.setItem(DRAFT_KEY, text) : localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: draft stays in memory only */
  }
};

interface Props {
  queue: CaptureQueue;
  send: Send;
  screenshot?: () => Promise<string | null>;
}

export function CaptureView({ queue, send, screenshot }: Props) {
  const [text, setText] = useState(loadDraft);
  useEffect(() => saveDraft(text), [text]);
  const textRef = useRef(text);
  textRef.current = text;
  // Without a stable documentId the editor's identity is its initial markdownSource, so every keystroke would remount it and drop focus.
  const [docId, setDocId] = useState(0);
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false); // start can wait on the microphone prompt for up to 30 s
  const [rejected, setRejected] = useState<QueuedCapture[]>([]);
  const editorRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);

  /** Reports the queue state; false if the item with `key` was rejected by the server. */
  async function settle(key: number): Promise<boolean> {
    const items = await queue.list();
    setRejected(items.filter((i) => i.rejected));
    const mine = items.find((i) => i.key === key);
    if (mine?.rejected) {
      setStatus(`Abgelehnt: ${mine.rejected}`);
      return false;
    }
    const left = items.filter((i) => !i.rejected).length;
    setStatus(left ? `Offline gepuffert (${left} in Warteschlange)` : "Gesendet");
    return true;
  }

  useEffect(() => {
    void queue.list().then((items) => setRejected(items.filter((i) => i.rejected)));
  }, [queue]);

  /** Store first (never lose a thought), then try to deliver. */
  async function submit(input: CaptureInput): Promise<boolean> {
    const key = await queue.enqueue(input);
    await queue.flush(send);
    return settle(key);
  }

  async function retry(key: number) {
    await queue.retry(key);
    await queue.flush(send);
    await settle(key);
  }

  async function discard(key: number) {
    await queue.discard(key);
    setRejected((r) => r.filter((i) => i.key !== key));
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
    // The user may keep typing while the send is pending; clear only if the editor still holds what was sent. A rejected draft stays.
    const attachments = await readAttachmentsForSend(sent);
    if (await submit({ kind: "text", source: "typed", text: sent, ...(attachments.length ? { attachments } : {}) })) {
      await dropAttachments(sent, textRef.current === sent ? "" : textRef.current); // the user kept typing: links still in the live draft keep their bytes
      if (textRef.current === sent) {
        setText("");
        setDocId((n) => n + 1); // remount the editor empty; markdownSource is only read at mount
      }
    }
  }

  async function toggleRecording() {
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
    <section aria-label="Erfassen">
      <div className="editor">
        <AtomicCodeMirrorEditor
          documentId={`capture-${docId}`}
          markdownSource={text}
          onMarkdownChange={setText}
          extensions={extensions}
          editorHandleRef={editorRef}
        />
      </div>
      <div className="actions">
        <button className="primary" onClick={sendText} disabled={!text.trim()}>Speichern</button>
        <button onClick={toggleRecording} aria-pressed={recording} disabled={starting}>{recording ? "Stopp" : "Sprache"}</button>
        {screenshot && <button onClick={takeScreenshot}>Screenshot</button>}
        <label className="button">
          Datei
          <input type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
        <button onClick={insertTable}>Tabelle</button>
        <p className="status" role="status" aria-live="polite">{status}</p>
      </div>
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
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import type { CaptureInput } from "@pickynotes/shared";
import { useEffect, useRef, useState } from "react";
import { blobToBase64 } from "./lib/base64";
import { editorExtensions } from "./lib/editor";
import type { CaptureQueue, QueuedCapture, Send } from "./lib/queue";

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
  const [rejected, setRejected] = useState<QueuedCapture[]>([]);
  const recorder = useRef<MediaRecorder | null>(null);

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

  async function sendText() {
    if (!text.trim()) return;
    const sent = text;
    // The user may keep typing while the send is pending; clear only if the editor still holds what was sent. A rejected draft stays.
    if (await submit({ kind: "text", source: "typed", text: sent })) {
      if (textRef.current === sent) {
        setText("");
        setDocId((n) => n + 1); // remount the editor empty; markdownSource is only read at mount
      }
    }
  }

  async function toggleRecording() {
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        await submit({ kind: "voice", source: "dictated", data: await blobToBase64(blob), filename: "voice.webm", mime: blob.type });
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setStatus("Mikrofon nicht verfügbar");
    }
  }

  async function takeScreenshot() {
    const data = await screenshot?.();
    if (data) await submit({ kind: "screenshot", source: "imported", data, filename: "screenshot.png", mime: "image/png" });
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) return setStatus("Datei größer als 100 MB");
    await submit({ kind: "file", source: "imported", data: await blobToBase64(file), filename: file.name, mime: file.type || undefined });
  }

  return (
    <section aria-label="Erfassen">
      <div className="editor">
        <AtomicCodeMirrorEditor documentId={`capture-${docId}`} markdownSource={text} onMarkdownChange={setText} extensions={editorExtensions} />
      </div>
      <div className="actions">
        <button className="primary" onClick={sendText} disabled={!text.trim()}>Speichern</button>
        <button onClick={toggleRecording} aria-pressed={recording}>{recording ? "Stopp" : "Sprache"}</button>
        {screenshot && <button onClick={takeScreenshot}>Screenshot</button>}
        <label className="button">
          Datei
          <input type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
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

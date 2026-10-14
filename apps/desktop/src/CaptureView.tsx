import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import type { CaptureInput } from "@pickynotes/shared";
import { useRef, useState } from "react";
import { blobToBase64 } from "./lib/base64";
import type { CaptureQueue, Send } from "./lib/queue";

const MAX_BYTES = 10 * 1024 * 1024; // server default; larger files are rejected there too

interface Props {
  queue: CaptureQueue;
  send: Send;
  screenshot?: () => Promise<string | null>;
}

export function CaptureView({ queue, send, screenshot }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);

  /** Store first (never lose a thought), then try to deliver. */
  async function submit(input: CaptureInput) {
    await queue.enqueue(input);
    await queue.flush(send);
    const left = await queue.pending();
    setStatus(left ? `Offline gepuffert (${left} in Warteschlange)` : "Gesendet");
  }

  async function sendText() {
    if (!text.trim()) return;
    await submit({ kind: "text", source: "typed", text });
    setText("");
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
    if (file.size > MAX_BYTES) return setStatus("Datei größer als 10 MB");
    await submit({ kind: "file", source: "imported", data: await blobToBase64(file), filename: file.name, mime: file.type || undefined });
  }

  return (
    <section aria-label="Erfassen">
      <div className="editor">
        <AtomicCodeMirrorEditor markdownSource={text} onMarkdownChange={setText} />
      </div>
      <div className="actions">
        <button onClick={sendText} disabled={!text.trim()}>Speichern</button>
        <button onClick={toggleRecording} aria-pressed={recording}>{recording ? "Stopp" : "Sprache"}</button>
        {screenshot && <button onClick={takeScreenshot}>Screenshot</button>}
        <label className="button">
          Datei
          <input type="file" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
      </div>
      <p role="status" aria-live="polite">{status}</p>
    </section>
  );
}

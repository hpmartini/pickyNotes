import { pickRecorderMime } from "./audio-blocks";

export interface Recorder {
  stop: () => Promise<{ bytes: Uint8Array; mime: string }>;
  /** Drop the recording and release the microphone (the view went away mid-recording). */
  cancel: () => void;
}

/** Records the microphone with MediaRecorder (the webview's own; WhisperStorm is not involved). */
export async function startRecorder(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const mimeType = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => void (e.data.size && chunks.push(e.data));
    rec.start();
    return {
      stop: () =>
        new Promise((resolve, reject) => {
          rec.onerror = () => reject(new Error("Aufnahme fehlgeschlagen"));
          rec.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const mime = (rec.mimeType || mimeType || "audio/mp4").split(";")[0]!;
            resolve({ bytes: new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer()), mime });
          };
          rec.stop();
        }),
      cancel: () => {
        rec.ondataavailable = rec.onstop = rec.onerror = null;
        if (rec.state !== "inactive") rec.stop();
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
}

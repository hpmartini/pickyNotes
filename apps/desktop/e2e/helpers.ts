import type { Page } from "@playwright/test";

/** Text of the active note tab, as persisted in localStorage. */
export const activeText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("picky.notes") ?? "null") as { active: string; notes: { id: string; text: string }[] } | null;
    return s?.notes.find((n) => n.id === s.active)?.text ?? "";
  });

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Pretends to be the Tauri webview: `invoke` answers WhisperStorm and screenshot calls, records every call in `window.__calls`.
 * `window.__failRegister = "<accelerator>"` makes the global-shortcut register call for that key throw, like a key another app owns.
 */
export async function mockTauri(page: Page, ws: { start: unknown; stop?: unknown }) {
  await page.addInitScript(([wsReplies, png]) => {
    const calls: [string, unknown][] = [];
    Object.assign(window, { __calls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 0,
      invoke: async (cmd: string, args: { cmd?: "start" | "stop"; shortcuts?: string[] }) => {
        calls.push([cmd, args]);
        if (cmd === "whisperstorm") return (wsReplies as Record<string, unknown>)[args.cmd!];
        if (cmd === "screenshot") return png;
        if (cmd === "transcribe_audio") return (window as unknown as { __transcribeReply?: unknown }).__transcribeReply ?? { ok: true, phase: "success", text: "Hallo Aufnahme" };
        if (cmd === "outbox_list" || cmd === "drafts_list") return [];
        if (cmd === "keychain_get") return "t";
        const fail = (window as unknown as { __failRegister?: string }).__failRegister;
        if (cmd === "plugin:global-shortcut|register" && fail && args.shortcuts?.includes(fail)) throw new Error("already taken");
        return null;
      },
    } });
  }, [ws, PNG_B64] as const);
}

/**
 * Fake microphone: getUserMedia answers a stream with one track, MediaRecorder (audio/mp4 like WKWebView) yields a one-second silent WAV on stop.
 */
export async function mockRecorder(page: Page) {
  await page.addInitScript(() => {
    const wav = () => {
      const n = 8000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
      return new Blob([buf], { type: "audio/wav" });
    };
    const track = { stop: () => ((window as unknown as { __micStopped: number }).__micStopped++) };
    Object.assign(window, { __micStopped: 0 });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    class FakeRecorder {
      static isTypeSupported = (t: string) => t === "audio/mp4";
      mimeType: string;
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_s: unknown, o?: { mimeType?: string }) { this.mimeType = o?.mimeType ?? ""; (window as unknown as { __recMime: string }).__recMime = this.mimeType; }
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.ondataavailable?.({ data: wav() }); this.onstop?.(); }
    }
    Object.assign(window, { MediaRecorder: FakeRecorder });
  });
}

/** The recorded `invoke` calls (command + args) so far. */
export const tauriCalls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: [string, Record<string, unknown>][] }).__calls);

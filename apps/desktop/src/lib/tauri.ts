import { invoke } from "@tauri-apps/api/core";
import type { Hotkeys } from "./settings";

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Device token: OS keychain in the app (Rust command). Plain localStorage only in the browser dev server. */
export const token = {
  get: async (): Promise<string | null> => (inTauri() ? invoke<string | null>("keychain_get") : localStorage.getItem("picky.dev-token")),
  set: async (value: string): Promise<void> => (inTauri() ? invoke("keychain_set", { value }) : localStorage.setItem("picky.dev-token", value)),
};

/** Interactive `screencapture` (Rust command). Returns base64 PNG, or null if the user cancelled. */
export const screenshot = (): Promise<string | null> => invoke<string | null>("screenshot");

/** Reply from the WhisperStorm Unix-socket control server. */
export interface WhisperReply {
  ok: boolean;
  /** Human-readable phase from WhisperStorm: idle / recording / transcribing / error. */
  phase?: string;
  /** Transcript text (returned by `stop` after transcription finishes). */
  text?: string;
  /** German error message — surfaced as the UI status. */
  error?: string;
}

/**
 * Sends `start`/`stop`/`status` to the WhisperStorm Unix socket via a Rust command.
 * The browser fallback answers with `{ ok: false, error: "WhisperStorm läuft nicht" }` so the UI shows a clear message.
 */
export async function whisperstorm(cmd: "start" | "stop" | "status"): Promise<WhisperReply> {
  if (!inTauri()) return { ok: false, error: "WhisperStorm läuft nicht" };
  try {
    return await invoke<WhisperReply>("whisperstorm", { cmd });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One message per hotkey that could not be registered (taken by another app, or an invalid combination). */
export type HotkeyErrors = Partial<Record<keyof Hotkeys, string>>;

/** The window comes to the front and the capture view hears about it (detail.toggle = dictation toggle). */
async function showAndFocus(toggle: boolean) {
  const w = (await import("@tauri-apps/api/window")).getCurrentWindow();
  await w.show();
  await w.unminimize();
  await w.setFocus();
  window.dispatchEvent(new CustomEvent("picky:focus-capture", { detail: { toggle } }));
}

const handlers = {
  dictation: () => showAndFocus(true),
  async toggle() {
    const w = (await import("@tauri-apps/api/window")).getCurrentWindow();
    if ((await w.isVisible()) && (await w.isFocused())) await w.hide();
    else await showAndFocus(false);
  },
};

/**
 * Registers the global hotkeys live. `prev` is what is registered now (null at startup), `next` what should be.
 * A changed key is unregistered and its replacement registered; if the replacement is rejected the old key is restored.
 * Never throws: returns the keys that apply afterwards plus a message per rejected hotkey.
 */
export async function applyHotkeys(prev: Hotkeys | null, next: Hotkeys): Promise<{ applied: Hotkeys; errors: HotkeyErrors }> {
  const applied = { ...next };
  const errors: HotkeyErrors = {};
  if (!inTauri()) return { applied, errors };
  try {
    const { register, unregister } = await import("@tauri-apps/plugin-global-shortcut");
    const reg = (key: string, name: keyof Hotkeys) => register(key, (e) => (e.state === "Pressed" ? handlers[name]() : undefined));
    for (const name of ["toggle", "dictation"] as const) {
      const old = prev?.[name];
      if (old === next[name]) continue;
      try {
        // At startup this drops a leftover registration from before a webview reload, whose handler is dead.
        await unregister(old ?? next[name]).catch(() => {});
        await reg(next[name], name);
      } catch (e) {
        errors[name] = e instanceof Error ? e.message : String(e);
        if (old) {
          applied[name] = old;
          await reg(old, name).catch(() => {});
        }
      }
    }
  } catch (e) {
    // plugin missing: every hotkey that was asked to change failed
    for (const name of ["toggle", "dictation"] as const) if (prev?.[name] !== next[name]) errors[name] = e instanceof Error ? e.message : String(e);
  }
  return { applied, errors };
}

/** macOS Dock icon (activation policy) and menu-bar icon; Rust applies and persists them. No-ops in the browser. */
export const setDockVisible = (visible: boolean): Promise<void> => (inTauri() ? invoke("set_dock_visible", { visible }) : Promise.resolve());
export const setTrayVisible = (visible: boolean): Promise<void> => (inTauri() ? invoke("set_tray_visible", { visible }) : Promise.resolve());

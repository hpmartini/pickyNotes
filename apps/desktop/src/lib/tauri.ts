import { invoke } from "@tauri-apps/api/core";
import type { DraftStore } from "./drafts";
import type { Outbox } from "./queue";
import type { HotkeyConfig, Hotkeys } from "./settings";

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Device token: OS keychain in the app (Rust command). Plain localStorage only in the browser dev server. */
export const token = {
  get: async (): Promise<string | null> => (inTauri() ? invoke<string | null>("keychain_get") : localStorage.getItem("picky.dev-token")),
  set: async (value: string): Promise<void> => (inTauri() ? invoke("keychain_set", { value }) : localStorage.setItem("picky.dev-token", value)),
};

/** Interactive `screencapture` (Rust command). Returns base64 PNG, or null if the user cancelled. */
export const screenshot = (): Promise<string | null> => invoke<string | null>("screenshot");

/**
 * File outbox in the app data dir (Rust commands): a second, plain-file copy of every queued capture. Undefined in the browser dev server.
 * Files that do not parse are skipped, not deleted.
 */
export const tauriOutbox = (): Outbox | undefined =>
  inTauri()
    ? {
        write: (item) => invoke("outbox_write", { clientId: item.input.clientId, json: JSON.stringify(item) }),
        remove: (clientId) => invoke("outbox_delete", { clientId }),
        list: async () =>
          (await invoke<string[]>("outbox_list")).flatMap((raw) => {
            try {
              const item = JSON.parse(raw);
              return typeof item?.input?.clientId === "string" ? [item] : [];
            } catch {
              return [];
            }
          }),
      }
    : undefined;

/** File copy of every open note in the app data dir (Rust `drafts_*`). Undefined in the browser dev server; files that do not parse are skipped, not deleted. */
export const tauriDrafts = (): DraftStore | undefined =>
  inTauri()
    ? {
        write: (id, text) => invoke("drafts_write", { id, json: JSON.stringify({ id, text }) }),
        remove: (id) => invoke("drafts_delete", { id }),
        list: async () =>
          (await invoke<string[]>("drafts_list")).flatMap((raw) => {
            try {
              const d = JSON.parse(raw);
              return typeof d?.id === "string" && typeof d?.text === "string" ? [{ id: d.id, text: d.text }] : [];
            } catch {
              return [];
            }
          }),
      }
    : undefined;

/** Hands the window corner radius (CSS `--window-radius`, px) to Rust, which clips the native window with it. */
export const setCornerRadius = (px: number): Promise<void> => (inTauri() && Number.isFinite(px) ? invoke("set_corner_radius", { px }) : Promise.resolve());

/** Shows the outbox folder in Finder. */
export const revealOutbox = (): Promise<void> => invoke("outbox_reveal");

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

/** Rust shows, unminimizes and focuses the window and re-applies the fullscreen-overlay settings (the JS window API cannot). */
const showWindow = () => invoke("show_main_window");

/** The window comes to the front and the capture view hears about it (detail.toggle = dictation toggle). */
async function showAndFocus(toggle: boolean) {
  await showWindow();
  window.dispatchEvent(new CustomEvent("picky:focus-capture", { detail: { toggle } }));
}

const handlers = {
  dictation: () => showAndFocus(true),
  async toggle() {
    const w = (await import("@tauri-apps/api/window")).getCurrentWindow();
    if ((await w.isVisible()) && (await w.isFocused())) await w.hide();
    else await showAndFocus(false);
  },
  /** A separate event: picky:focus-capture would close the search panel again. */
  async search() {
    await showWindow();
    window.dispatchEvent(new CustomEvent("picky:open-search"));
  },
};

/**
 * Registers the global hotkeys live. `prev` is what is registered now (null at startup), `next` what should be.
 * A hotkey is registered only while it is enabled; disabling one just unregisters it.
 * All changed old keys are unregistered first (so a swap of two keys works), then the new ones registered.
 * If a new key is rejected, the new keys already registered are dropped and the old ones restored.
 * Never throws: returns the keys that apply afterwards plus a message per rejected hotkey.
 * Calls run one after another, and a call with `prev` starts from what the last call really left registered: the settings dialog may be closed and reopened while a change is in flight, so its `prev` can be stale.
 */
export function applyHotkeys(prev: Hotkeys | null, next: Hotkeys): Promise<{ applied: Hotkeys; errors: HotkeyErrors }> {
  const run = hotkeyQueue.then(async () => {
    const r = await applyNow(prev && registeredHotkeys ? registeredHotkeys : prev, next);
    registeredHotkeys = r.applied;
    return r;
  });
  hotkeyQueue = run.then(() => {});
  return run;
}

let hotkeyQueue: Promise<void> = Promise.resolve();
let registeredHotkeys: Hotkeys | null = null;

async function applyNow(prev: Hotkeys | null, next: Hotkeys): Promise<{ applied: Hotkeys; errors: HotkeyErrors }> {
  const names = (["toggle", "dictation", "search"] as const).filter((n) => prev?.[n].key !== next[n].key || prev?.[n].enabled !== next[n].enabled);
  const errors: HotkeyErrors = {};
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  if (!inTauri()) return { applied: { ...next }, errors };
  try {
    const { register, unregister } = await import("@tauri-apps/plugin-global-shortcut");
    const reg = async ({ key, enabled }: HotkeyConfig, name: keyof Hotkeys) => {
      if (enabled) await register(key, (e) => (e.state === "Pressed" ? handlers[name]() : undefined));
    };
    // At startup this drops a leftover registration from before a webview reload, whose handler is dead.
    for (const n of names) {
      const old = prev?.[n] ?? next[n];
      if (old.enabled) await unregister(old.key).catch(() => {});
    }
    const registered: (keyof Hotkeys)[] = [];
    for (const n of names) {
      try {
        await reg(next[n], n);
        if (next[n].enabled) registered.push(n);
      } catch (e) {
        errors[n] = message(e);
      }
    }
    if (!prev || !Object.keys(errors).length) return { applied: { ...next }, errors };
    for (const n of registered) await unregister(next[n].key).catch(() => {});
    for (const n of names) await reg(prev[n], n).catch(() => {});
    return { applied: { ...prev }, errors };
  } catch (e) {
    // plugin missing: every hotkey that was asked to change failed
    for (const n of names) errors[n] = message(e);
    return { applied: { ...(prev ?? next) }, errors };
  }
}

/** macOS Dock icon (activation policy) and menu-bar icon; Rust applies and persists them. No-ops in the browser. */
export const setDockVisible = (visible: boolean): Promise<void> => (inTauri() ? invoke("set_dock_visible", { visible }) : Promise.resolve());
export const setTrayVisible = (visible: boolean): Promise<void> => (inTauri() ? invoke("set_tray_visible", { visible }) : Promise.resolve());

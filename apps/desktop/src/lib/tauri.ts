import { invoke } from "@tauri-apps/api/core";

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Device token: OS keychain in the app (Rust command). Plain localStorage only in the browser dev server. */
export const token = {
  get: async (): Promise<string | null> => (inTauri() ? invoke<string | null>("keychain_get") : localStorage.getItem("picky.dev-token")),
  set: async (value: string): Promise<void> => (inTauri() ? invoke("keychain_set", { value }) : localStorage.setItem("picky.dev-token", value)),
};

/** Interactive `screencapture` (Rust command). Returns base64 PNG, or null if the user cancelled. */
export const screenshot = (): Promise<string | null> => invoke<string | null>("screenshot");

/** Global hotkey that brings the capture window to the front. */
export async function registerHotkey(shortcut = "CommandOrControl+Shift+Space"): Promise<void> {
  if (!inTauri()) return;
  const [{ register, isRegistered }, { getCurrentWindow }] = await Promise.all([import("@tauri-apps/plugin-global-shortcut"), import("@tauri-apps/api/window")]);
  if (await isRegistered(shortcut)) return;
  await register(shortcut, async (e) => {
    if (e.state !== "Pressed") return;
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
    window.dispatchEvent(new Event("picky:focus-capture"));
  });
}

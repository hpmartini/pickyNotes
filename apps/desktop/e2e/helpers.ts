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
        if (cmd === "outbox_list") return [];
        if (cmd === "keychain_get") return "t";
        const fail = (window as unknown as { __failRegister?: string }).__failRegister;
        if (cmd === "plugin:global-shortcut|register" && fail && args.shortcuts?.includes(fail)) throw new Error("already taken");
        return null;
      },
    } });
  }, [ws, PNG_B64] as const);
}

/** The recorded `invoke` calls (command + args) so far. */
export const tauriCalls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: [string, Record<string, unknown>][] }).__calls);

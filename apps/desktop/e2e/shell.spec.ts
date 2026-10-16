import { expect, test, type Page } from "@playwright/test";
import { activeText, mockTauri, tauriCalls } from "./helpers";

const NO_WS = { start: { ok: false } };
const dialog = (page: Page) => page.getByRole("dialog", { name: "Einstellungen" });
const openSettings = async (page: Page) => {
  await expect(page.getByRole("tab")).toBeVisible(); // the app has mounted and attached its shortcut listener
  await page.keyboard.press("Control+,");
  await expect(dialog(page)).toBeVisible();
};
const registered = async (page: Page) => (await tauriCalls(page)).filter(([c]) => c === "plugin:global-shortcut|register").map(([, a]) => (a.shortcuts as string[])[0]);
const unregistered = async (page: Page) => (await tauriCalls(page)).filter(([c]) => c === "plugin:global-shortcut|unregister").map(([, a]) => (a.shortcuts as string[])[0]);

test.describe("settings modal", () => {
  test("Ctrl+, opens a dialog with the server form; Esc and the close button close it", async ({ page }) => {
    await page.goto("/");
    await page.locator(".cm-content").click(); // the shortcut must work while the editor has focus
    await page.keyboard.press("Control+,");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByLabel("Server-URL")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await dialog(page).getByRole("button", { name: "Einstellungen schließen" }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test("URL and token save as before", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    await dialog(page).getByLabel("Server-URL").fill(" https://notes.example.net ");
    await dialog(page).getByLabel("Geräte-Token").fill("tok123");
    await dialog(page).getByRole("button", { name: "Speichern" }).click();
    await expect(dialog(page).getByRole("status")).toHaveText("Gespeichert (Token im Schlüsselbund).");
    expect(await page.evaluate(() => [localStorage.getItem("picky.url"), localStorage.getItem("picky.dev-token")])).toEqual(["https://notes.example.net", "tok123"]);
  });

  test("hotkeys: capture a combination, live unregister/register, persisted; reset restores the defaults", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.goto("/");
    await expect.poll(() => registered(page)).toEqual(["CommandOrControl+Shift+Space", "Control+Alt+V"]);
    await openSettings(page);
    const field = dialog(page).getByLabel("Diktat starten/stoppen");
    await expect(field).toHaveValue("Control+Alt+V");
    await field.focus();
    await page.keyboard.press("Control+Alt+K");
    await expect(field).toHaveValue("Control+Alt+K");
    expect(await unregistered(page)).toContain("Control+Alt+V");
    expect((await registered(page)).at(-1)).toBe("Control+Alt+K");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("picky.hotkeys")!))).toEqual({ dictation: "Control+Alt+K", toggle: "CommandOrControl+Shift+Space" });
    await dialog(page).getByRole("button", { name: "Zurücksetzen" }).click();
    await expect(field).toHaveValue("Control+Alt+V");
    expect((await registered(page)).at(-1)).toBe("Control+Alt+V");
  });

  test("a rejected hotkey shows an error and keeps the previous one; a bare key is ignored", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.addInitScript(() => Object.assign(window, { __failRegister: "Control+Alt+K" }));
    await page.goto("/");
    await openSettings(page);
    const field = dialog(page).getByLabel("App ein-/ausblenden");
    await field.focus();
    await page.keyboard.press("Control+Alt+K");
    await expect(dialog(page).getByRole("alert")).toHaveText("already taken");
    await expect(field).toHaveValue("CommandOrControl+Shift+Space");
    expect((await registered(page)).at(-1)).toBe("CommandOrControl+Shift+Space"); // old key registered again
    expect(await page.evaluate(() => localStorage.getItem("picky.hotkeys"))).toContain("CommandOrControl+Shift+Space");
    await page.keyboard.press("K"); // no Command/Control/Alt: not a global shortcut
    await expect(field).toHaveValue("CommandOrControl+Shift+Space");
    await field.focus();
    await page.keyboard.press("Control+Alt+V"); // already the dictation key
    await expect(dialog(page).getByRole("alert")).toContainText("Schon belegt");
  });

  test("Dock / menu-bar toggles call the Rust commands; turning both off warns but is allowed", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.goto("/");
    await openSettings(page);
    const dock = dialog(page).getByLabel("Im Dock anzeigen");
    const tray = dialog(page).getByLabel("Menüleisten-Icon anzeigen");
    await expect(dock).toBeChecked();
    await expect(tray).not.toBeChecked();
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
    await dock.uncheck();
    await expect(dialog(page).getByRole("alert")).toContainText("nur per Tastenkürzel");
    await tray.check();
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
    await tray.uncheck();
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    const shell = (await tauriCalls(page)).filter(([c]) => c.endsWith("_visible"));
    expect(shell).toEqual([["set_dock_visible", { visible: false }], ["set_tray_visible", { visible: true }], ["set_tray_visible", { visible: false }]]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("picky.shell")!))).toEqual({ dock: false, tray: false });
    await page.reload(); // choice is restored in the UI
    await openSettings(page);
    await expect(dialog(page).getByLabel("Im Dock anzeigen")).not.toBeChecked();
  });
});

test.describe("shell layout", () => {
  test("Suche is an icon button that opens and closes a panel; Suche and Einstellungen are no tabs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveText(["Neue Notiz"]);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await page.getByRole("button", { name: "Suche", exact: true }).click();
    await expect(page.getByRole("search")).toBeVisible();
    await page.getByRole("button", { name: "Suche schließen" }).click();
    await expect(page.getByRole("search")).toHaveCount(0);
  });

  test("the editor uses the full window width (no 780px column) and the top bar is a drag region", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto("/");
    expect((await page.locator(".editor").boundingBox())!.width).toBeGreaterThan(1300);
    await expect(page.locator(".topbar[data-tauri-drag-region]")).toHaveCount(1);
  });
});

test.describe("note tabs", () => {
  test("Ctrl+N opens a tab, switching swaps the editor text, closing removes it, the last one is cleared; all survive a reload", async ({ page }) => {
    await page.goto("/");
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.type("Erste Notiz");
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tab")).toHaveText(["Erste Notiz", "Neue Notiz"]);
    await expect(editor).toBeFocused(); // a new tab takes the cursor
    await page.keyboard.type("Zweite Notiz");
    await expect(page.getByRole("tab")).toHaveText(["Erste Notiz", "Zweite Notiz"]);
    await page.getByRole("tab", { name: "Erste Notiz" }).click();
    await expect(editor).toHaveText("Erste Notiz");
    await page.reload();
    await expect(page.getByRole("tab")).toHaveText(["Erste Notiz", "Zweite Notiz"]);
    await expect(editor).toHaveText("Erste Notiz");
    await page.locator(".tab", { hasText: "Erste Notiz" }).getByRole("button", { name: "Notiz schließen" }).click();
    await expect(page.getByRole("tab")).toHaveText(["Zweite Notiz"]);
    await expect(editor).toHaveText("Zweite Notiz");
    await page.getByRole("button", { name: "Notiz schließen" }).click(); // last tab: cleared, not removed
    await expect(page.getByRole("tab")).toHaveText(["Neue Notiz"]);
    await expect(editor).toHaveText("");
  });

  test("a legacy picky.draft migrates into the first tab", async ({ page }) => {
    await page.addInitScript(() => localStorage.getItem("picky.notes") ?? localStorage.setItem("picky.draft", "# Altlast"));
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveText(["# Altlast"]);
    expect(await page.evaluate(() => localStorage.getItem("picky.draft"))).toBeNull();
  });

  test("Speichern sends only the active note and closes its tab", async ({ page }) => {
    const sent: unknown[] = [];
    await page.route("**/captures", async (route) => (sent.push(route.request().postDataJSON()), route.fulfill({ status: 200, json: { id: "1" } })));
    await page.addInitScript(() => (localStorage.setItem("picky.url", location.origin), localStorage.setItem("picky.dev-token", "t")));
    await page.goto("/");
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.type("eins");
    await page.keyboard.press("Control+n");
    await page.keyboard.type("zwei");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gesendet" })).toBeVisible();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ kind: "text", text: "zwei" });
    await expect(page.getByRole("tab")).toHaveText(["eins"]);
    expect(await activeText(page)).toBe("eins");
  });

  test("dictation started in tab 1 and stopped by the hotkey in tab 2 inserts the transcript into tab 2", async ({ page }) => {
    await mockTauri(page, { start: { ok: true, phase: "recording" }, stop: { ok: true, phase: "idle", text: "Diktat" } });
    await page.goto("/");
    await page.locator(".cm-content").click();
    await page.keyboard.type("eins");
    const press = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("picky:focus-capture", { detail: { toggle: true } })));
    await press();
    await expect(page.getByRole("button", { name: "Stopp" })).toBeVisible();
    await page.getByRole("button", { name: "Neue Notiz" }).click();
    await page.keyboard.type("zwei ");
    await press();
    await expect(page.getByRole("status").filter({ hasText: "Transkript eingefügt." })).toBeVisible();
    await expect.poll(() => activeText(page)).toContain("Diktat");
    expect(await activeText(page)).toContain("zwei");
    await page.getByRole("tab", { name: "eins" }).click();
    expect(await activeText(page)).toBe("eins");
  });
});

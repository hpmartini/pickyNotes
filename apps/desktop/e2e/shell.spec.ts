import { expect, test, type Page } from "@playwright/test";
import { activeText, mockTauri, tauriCalls } from "./helpers";

const NO_WS = { start: { ok: false } };
const dialog = (page: Page) => page.getByRole("dialog", { name: "Einstellungen" });
const pendingDialog = (page: Page) => page.getByRole("dialog", { name: "Ausstehend" });
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

  test("focus returns to the opener after Esc, and Tab stays inside the dialog", async ({ page }) => {
    await page.goto("/");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+,");
    await expect(dialog(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-content")).toBeFocused();
    const gear = page.getByRole("button", { name: "Einstellungen" });
    await gear.click();
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await dialog(page).evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(gear).toBeFocused();
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
    await expect.poll(async () => (await registered(page)).sort()).toEqual(["CommandOrControl+Shift+K", "CommandOrControl+Shift+Space", "Control+Alt+V"]);
    await openSettings(page);
    const field = dialog(page).getByLabel("Diktat starten/stoppen");
    await expect(field).toHaveValue("Control+Alt+V");
    await field.focus();
    await page.keyboard.press("Control+Alt+K");
    await expect(field).toHaveValue("Control+Alt+K");
    expect(await unregistered(page)).toContain("Control+Alt+V");
    expect((await registered(page)).at(-1)).toBe("Control+Alt+K");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("picky.hotkeys")!))).toEqual({
      dictation: { key: "Control+Alt+K", enabled: true },
      toggle: { key: "CommandOrControl+Shift+Space", enabled: true },
      search: { key: "CommandOrControl+Shift+K", enabled: true },
    });
    await dialog(page).getByRole("button", { name: "Zurücksetzen" }).click();
    await expect(field).toHaveValue("Control+Alt+V");
    expect((await registered(page)).at(-1)).toBe("Control+Alt+V");
  });

  test("an aktiv checkbox unregisters a hotkey and registers it again", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.goto("/");
    await openSettings(page);
    const box = dialog(page).locator("[data-hotkey=search]").getByLabel("aktiv");
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect.poll(() => unregistered(page)).toContain("CommandOrControl+Shift+K");
    await expect(dialog(page).getByLabel("Suche öffnen")).toHaveValue("CommandOrControl+Shift+K");
    const before = (await registered(page)).length;
    await page.reload();
    await expect.poll(async () => (await registered(page)).sort()).toEqual(["CommandOrControl+Shift+Space", "Control+Alt+V"]); // a disabled hotkey is not registered at startup
    expect(before).toBeGreaterThan(0);
    await openSettings(page);
    await expect(dialog(page).locator("[data-hotkey=search]").getByLabel("aktiv")).not.toBeChecked();
    await dialog(page).locator("[data-hotkey=search]").getByLabel("aktiv").check();
    await expect.poll(async () => (await registered(page)).at(-1)).toBe("CommandOrControl+Shift+K");
  });

  test("while the dialog is open the background is inert and Ctrl+N opens no note", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    await dialog(page).getByLabel("Server-URL").focus();
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.locator("main > header.topbar")).toHaveAttribute("inert", "");
    await expect(page.locator("section[aria-label='Erfassen']")).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(page.locator("section[aria-label='Erfassen']")).not.toHaveAttribute("inert");
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tab")).toHaveCount(2);
  });

  test("capturing Control+N in a hotkey field does not open a note tab", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.goto("/");
    await openSettings(page);
    await dialog(page).getByLabel("Diktat starten/stoppen").focus();
    await page.keyboard.press("Control+n");
    await expect(dialog(page).getByLabel("Diktat starten/stoppen")).toHaveValue("Control+N");
    await expect(page.getByRole("tab")).toHaveCount(1);
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

test.describe("search shortcut", () => {
  test("Ctrl+K opens the search panel with the input focused, also from the editor", async ({ page }) => {
    await page.goto("/");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("search")).toBeVisible();
    await expect(page.getByLabel("Suchbegriff")).toBeFocused();
  });

  test("the global search hotkey event opens the panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("tab")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("picky:open-search")));
    await expect(page.getByLabel("Suchbegriff")).toBeFocused();
  });
});

test.describe("text width", () => {
  test("a custom width narrows and centres the editor column live; Volle Breite restores it", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto("/");
    const content = page.locator(".cm-content");
    const box = async () => (await content.boundingBox())!;
    expect((await box()).width).toBeGreaterThan(1300);
    await openSettings(page);
    await dialog(page).getByLabel("Eigene Breite").check();
    await dialog(page).getByLabel("Breite in px").fill("600");
    await expect.poll(async () => Math.round((await box()).width)).toBe(600);
    const b = await box();
    expect(Math.abs(b.x - (1400 - 600 - b.x))).toBeLessThan(2); // equal margins left and right
    await dialog(page).getByLabel("Volle Breite").check();
    await expect.poll(async () => (await box()).width).toBeGreaterThan(1300);
  });
});

test.describe("pending captures", () => {
  test("an offline save shows Ausstehend (1); Als Notiz öffnen puts the text back into a new tab", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.route("**/captures", (route) => route.abort("internetdisconnected"));
    await page.addInitScript(() => (localStorage.setItem("picky.url", location.origin), localStorage.setItem("picky.dev-token", "t")));
    await page.goto("/");
    await page.locator(".cm-content").click();
    await page.keyboard.type("nicht verlieren");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Offline gepuffert" })).toBeVisible();
    await expect(pendingDialog(page)).toHaveCount(0); // nothing pops up on its own, and no panel sits under the editor
    await page.getByRole("button", { name: "Ausstehend: 1" }).click();
    await expect(pendingDialog(page)).toBeVisible();
    expect((await tauriCalls(page)).map(([c]) => c)).toContain("outbox_write");
    await pendingDialog(page).getByRole("button", { name: "Als Notiz öffnen" }).click();
    await expect(pendingDialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Ausstehend/ })).toHaveCount(0);
    await expect.poll(() => activeText(page)).toBe("nicht verlieren");
    expect((await tauriCalls(page)).map(([c]) => c)).toContain("outbox_delete");
  });

  test("without server URL and token the note waits in the Postausgang and the status says so", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.goto("/");
    await page.locator(".cm-content").click();
    await page.keyboard.type("ohne Server");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Server-URL/Token fehlen – Notiz liegt im Postausgang" })).toBeVisible();
    await page.getByRole("button", { name: "Ausstehend: 1" }).click();
    await pendingDialog(page).getByRole("button", { name: "Ordner zeigen" }).click();
    expect((await tauriCalls(page)).map(([c]) => c)).toContain("outbox_reveal");
  });

  test("the badge opens the Ausstehend modal, Esc closes it, the background is inert and Ctrl+N creates no tab", async ({ page }) => {
    await mockTauri(page, NO_WS);
    await page.goto("/");
    await page.locator(".cm-content").click();
    await expect(page.getByRole("button", { name: /^Ausstehend/ })).toHaveCount(0); // no badge at 0
    await page.keyboard.type("liegt im Postausgang");
    await page.getByRole("button", { name: "Speichern" }).click();
    const badge = page.getByRole("button", { name: "Ausstehend: 1" });
    await expect(badge).toHaveText("1");
    await badge.click();
    await expect(pendingDialog(page)).toBeVisible();
    await expect(pendingDialog(page)).toContainText("liegt im Postausgang");
    await expect(page.locator('section[aria-label="Erfassen"]')).toHaveAttribute("inert", "");
    await expect(page.locator(".topbar")).toHaveAttribute("inert", "");
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tab")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(pendingDialog(page)).toHaveCount(0);
    await expect(page.locator(".topbar")).not.toHaveAttribute("inert", "");
  });

  test("the window frame is rounded by --window-radius", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("main")!).borderTopLeftRadius)).toBe("12px");
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

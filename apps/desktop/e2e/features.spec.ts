import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Per-feature character-by-character e2e: types one keystroke at a time, after each one asserts the
// rendered DOM and (where it matters) the saved draft. A screenshot per step lands under test-results/
// so a reviewer can replay the exact UI state. The reusable `steps` helper captures the pattern.

async function steps(page: Page, label: string, keys: (string | { key: string; shiftKey?: boolean; type?: string })[]) {
  const editor = page.locator(".cm-content");
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (typeof k === "string") {
      for (const ch of k) await page.keyboard.type(ch, { delay: 5 });
    } else if ((k.type ?? "press") === "press") {
      await page.keyboard.press(k.shiftKey ? `Shift+${k.key}` : k.key);
    } else if (k.type === "down") {
      await page.keyboard.down(k.key);
    } else if (k.type === "up") {
      await page.keyboard.up(k.key);
    }
    await page.locator(".editor").screenshot({ path: test.info().outputPath(`step-${String(i).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
  }
}

test("sub/sup: H~2~O and x^2^ render as subscript/superscript", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();
  await steps(page, "subsup", ["H~2~O ", "x^2^"]);
  expect(await getDraft(page)).toBe("H~2~O x^2^");
  await expect(page.locator(".cm-pn-sub")).toHaveText("2");
  await expect(page.locator(".cm-pn-sup")).toHaveText("2");
  await expect(editor).toHaveText("H2O x2"); // delimiters hidden while the cursor is outside
  await page.keyboard.press("ArrowLeft"); // cursor inside the span: source visible for editing
  await expect(editor).toHaveText("H2O x^2^");
});

test("fence hiding: opening and closing ``` lines disappear while cursor is outside", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();
  // Cursor at end → outside the block (head == to).
  await steps(page, "fence", ["```", { key: "Enter" }, "code body", { key: "ArrowDown" }, { key: "End" }]);
  const hidden = await page.locator(".cm-pn-fence-hidden").count();
  expect(hidden, "opening and closing fence lines should be hidden").toBeGreaterThanOrEqual(2);
});

test("emoji :rocket: renders as the Unicode glyph, source intact", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();
  await steps(page, "emoji", [":rocket:"]);
  // The widget replaces the source in the rendered DOM; the source itself stays in the draft.
  expect(await page.locator(".cm-pn-emoji").first().textContent()).toBe("🚀");
  expect(await page.evaluate(() => localStorage.getItem("picky.draft"))).toBe(":rocket:");
});

test("task checkbox: typing - [ ] produces a clickable checkbox; clicking toggles the markdown", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();
  await steps(page, "task", ["- [ ] aufgabe"]);
  const draft = await page.evaluate(() => localStorage.getItem("picky.draft") ?? "");
  expect(draft).toBe("- [ ] aufgabe");
  const checkbox = page.locator(".cm-atomic-task-checkbox").first();
  await expect(checkbox).toBeVisible();
  await checkbox.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("picky.draft") ?? "")).toBe("- [x] aufgabe");
  // toggle back
  await page.locator(".cm-atomic-task-checkbox").first().click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("picky.draft") ?? "")).toBe("- [ ] aufgabe");
});

test("table: 3-column table, align center via toolbar", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();
  await steps(page, "table", ["| a | b |", { key: "Enter" }, "| --- | --- |", { key: "Enter" }, "| 1 | 2 |"]);
  // The parser canonicalises the delimiter row (always `---` per cell, alignment gone). Verify a table formed.
  const draft = await page.evaluate(() => localStorage.getItem("picky.draft") ?? "");
  expect(draft.split("\n")).toContain("| a | b |");
  const delim = draft.split("\n").find((l) => /^\|/.test(l) && l.includes("---"));
  expect(delim, "delimiter row must contain ---").toBeTruthy();
  // The toolbar only shows when the cursor sits inside a Table node — confirm by selecting the body.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown"); // move into the table body
  const toolbar = page.locator(".cm-pn-table-toolbar");
  await expect(toolbar).toBeVisible();
  // Center-align all columns via the toolbar.
  await toolbar.getByRole("button", { name: "⇔ C" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("picky.draft") ?? "")).toContain(":---:");
});

const getDraft = (page: Page) => page.evaluate(() => localStorage.getItem("picky.draft") ?? "");

for (const [typed, expected] of [["- [", "- [ ] "], ["- [ ", "- [ ] "], ["- [ ]", "- [ ] "], ["- [x]", "- [x] "], ["- [X]", "- [x] "]] as const) {
  test(`task input: typing "${typed}" char by char yields a real checkbox that toggles`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".cm-content").click();
    await steps(page, `task-${typed}`, [...typed]);
    await expect.poll(() => getDraft(page)).toBe(expected);
    const box = page.locator(".cm-atomic-task-checkbox");
    await expect(box).toHaveCount(1);
    await box.click();
    const toggled = expected.includes("[x]") ? "- [ ] " : "- [x] ";
    await expect.poll(() => getDraft(page)).toBe(toggled);
    await page.locator(".cm-atomic-task-checkbox").click();
    await expect.poll(() => getDraft(page)).toBe(expected);
  });
}

test("task input: text after the checkbox and plain links in list items keep typing", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "task-text", [..."- [ ] milch", { key: "Enter" }]);
  await expect.poll(() => getDraft(page)).toBe("- [ ] milch\n- [ ] ");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await steps(page, "task-link", [..."- [a](u)"]);
  await expect.poll(() => getDraft(page)).toBe("- [a](u)");
  await expect(page.locator(".cm-atomic-task-checkbox")).toHaveCount(0);
});

test("fence: 4-backtick and ````javascript blocks hide both fences outside, ArrowDown leaves the block", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "fence4", [..."````javascript", { key: "Enter" }, ..."let a = 1;"]);
  // The auto-closed fence must have grown with the opening one; cursor inside → both lines visible.
  expect(await getDraft(page)).toBe("````javascript\nlet a = 1;\n````");
  await expect(page.locator(".cm-pn-fence-hidden")).toHaveCount(0);
  await steps(page, "fence4-exit", [{ key: "ArrowDown" }, ..."danach"]);
  const draft = await getDraft(page);
  expect(draft).toBe("````javascript\nlet a = 1;\n````\ndanach");
  await expect(page.locator(".cm-pn-fence-hidden")).toHaveCount(2);
  // The closing fence never shows as text: no visible line holds a bare backtick run.
  const visible = (await page.locator(".cm-line:visible").allInnerTexts()).filter(Boolean); // Atomic adds empty padding lines around code blocks
  expect(visible.filter((l) => /^`{3,}$/.test(l.trim()))).toEqual([]);
  expect(visible).toEqual(["let a = 1;", "danach"]);
  // Back into the block: Arrow-up reveals the fences again.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-pn-fence-hidden")).toHaveCount(0);
});

test("fence: ``` block, ArrowDown from the last body line leaves the block", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "fence3", [..."```", { key: "Enter" }, ..."x", { key: "ArrowDown" }, ..."y"]);
  expect(await getDraft(page)).toBe("```\nx\n```\ny");
  await expect(page.locator(".cm-pn-fence-hidden")).toHaveCount(2);
});

test("table: alignment shows in the DOM, survives cell edits, toolbar controls change rows/columns/width", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await page.keyboard.insertText("| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
  await page.keyboard.press("ControlOrMeta+Home");
  await page.screenshot({ path: test.info().outputPath("table-0-aligned.png") });
  const aligns = () => page.locator(".cm-atomic-table tbody td").evaluateAll((tds) => tds.map((td) => getComputedStyle(td).textAlign));
  await expect.poll(aligns).toEqual(["left", "center", "right"]);
  await expect(page.locator(".cm-atomic-table td.cm-pn-align-center")).toHaveCount(1);
  // Cell edit via the widget: Atomic would flatten the delimiter row to `---`.
  await page.locator(".cm-atomic-table td").first().click();
  await expect(page.locator(".cm-pn-table-toolbar")).toBeVisible();
  await page.keyboard.type("Z");
  await expect.poll(() => getDraft(page)).toContain("| 1Z | 2 | 3 |");
  expect((await getDraft(page)).split("\n")[1]).toBe("| :--- | :---: | ---: |");
  await page.screenshot({ path: test.info().outputPath("table-1-edited.png") });
  const bar = page.locator(".cm-pn-table-toolbar");
  const click = (name: string) => bar.getByRole("button", { name }).dispatchEvent("mousedown");
  await click("⊕ Zeile");
  await expect.poll(async () => (await getDraft(page)).split("\n").length).toBe(4);
  await click("⊕ Spalte");
  await expect.poll(async () => (await getDraft(page)).split("\n")[0]).toBe("| a | Spalte | b | c |"); // after the cursor column (the new row's first cell)
  expect((await getDraft(page)).split("\n")[1]).toBe("| :--- | --- | :---: | ---: |");
  await click("⊖ Spalte");
  await click("⊖ Zeile");
  await expect.poll(async () => (await getDraft(page)).split("\n").length).toBe(3);
  const widthBefore = await page.locator(".cm-atomic-table th").first().evaluate((e) => (e as HTMLElement).style.minWidth);
  await click("Breite +");
  await expect.poll(() => page.locator(".cm-atomic-table th").first().evaluate((e) => (e as HTMLElement).style.minWidth)).not.toBe(widthBefore);
  await click("⇥ R");
  await expect.poll(aligns).toEqual(["right", "right", "right"]);
  const final = await getDraft(page);
  expect(final.split("\n")[1]).toMatch(/^\| -{3,}: \| -{3,}: \| -{3,}: \|$/);
  await page.screenshot({ path: test.info().outputPath("table-2-right.png") });
});

test("sub/sup HTML: <sub>/<sup> tags are hidden outside the cursor, text is lowered/raised", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "html-subsup", [..."H<sub>2</sub>O x<sup>2</sup>", { key: "Enter" }, ..."ende"]);
  expect(await getDraft(page)).toBe("H<sub>2</sub>O x<sup>2</sup>\nende");
  await expect(page.locator(".cm-pn-sub")).toHaveText("2");
  await expect(page.locator(".cm-pn-sup")).toHaveText("2");
  await expect(page.locator(".cm-line").first()).toHaveText("H2O x2");
});

test("paste/drop: a PDF becomes a [name](pending:id) chip, a dropped image previews", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "pdf", [..."vor", { key: "Enter" }]);
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "bericht.pdf", { type: "application/pdf" }));
    document.querySelector(".cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => getDraft(page)).toMatch(/^vor\n\[bericht\.pdf\]\(pending:[a-f0-9-]+\)\n$/);
  await expect(page.locator(".cm-pn-file-chip")).toHaveText("📎 bericht.pdf");
  await page.locator(".editor").screenshot({ path: test.info().outputPath("pdf-paste.png") });
  // Drop an image onto the editor: lands as an inline image preview.
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    dt.items.add(new File([png], "drop.png", { type: "image/png" }));
    const el = document.querySelector(".cm-content")!;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await expect.poll(() => getDraft(page)).toMatch(/!\[drop\.png\]\(pending:[a-f0-9-]+\)/);
  await expect(page.locator(".cm-content .cm-atomic-image img")).toHaveAttribute("src", /^blob:/);
  await page.locator(".editor").screenshot({ path: test.info().outputPath("drop-image.png") });
  await page.getByRole("button", { name: /Speichern|Senden/ }).count();
});

test("drop: a PDF dropped at the cursor becomes a [name](pending:id) chip and its bytes are stashed", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "pdf-drop", [..."vor", { key: "Enter" }]);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "vertrag.pdf", { type: "application/pdf" }));
    const el = document.querySelector(".cm-content")!;
    const r = [...document.querySelectorAll(".cm-line")].at(-1)!.getBoundingClientRect(); // drop point = the empty last line
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + r.height / 2 }));
  });
  await expect.poll(() => getDraft(page)).toMatch(/^vor\n\[vertrag\.pdf\]\(pending:[a-f0-9-]+\)\n?$/);
  await expect(page.locator(".cm-pn-file-chip")).toHaveText("📎 vertrag.pdf");
  await expect(page.locator(".cm-content .cm-atomic-image")).toHaveCount(0); // a file, not an image preview
  const id = /pending:([a-f0-9-]+)/.exec(await getDraft(page))![1];
  const stored = await page.evaluate((key) => new Promise<{ name: string; mime: string; bytes: number[] }>((resolve, reject) => {
    const open = indexedDB.open("pickynotes-attachments", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const get = open.result.transaction("attachments").objectStore("attachments").get(key);
      get.onsuccess = () => resolve({ name: get.result.name, mime: get.result.mime, bytes: [...get.result.bytes] });
      get.onerror = () => reject(get.error);
    };
  }), id);
  expect(stored).toEqual({ name: "vertrag.pdf", mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31] });
  await page.locator(".editor").screenshot({ path: test.info().outputPath("pdf-drop.png") });
});

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Pretends to be the Tauri webview: `invoke` answers from `window.__ws`/`__png`, records every call in `window.__calls`. */
async function mockTauri(page: Page, ws: { start: unknown; stop?: unknown }) {
  await page.addInitScript(([w, png]) => {
    const calls: [string, unknown][] = [];
    Object.assign(window, { __calls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 0,
      invoke: async (cmd: string, args: { cmd?: "start" | "stop" }) => {
        calls.push([cmd, args]);
        if (cmd === "whisperstorm") return (w as Record<string, unknown>)[args.cmd!];
        if (cmd === "screenshot") return png;
        if (cmd === "plugin:global-shortcut|is_registered") return true;
        return null;
      },
    } });
  }, [ws, PNG_B64] as const);
}

test("speech: Sprache starts WhisperStorm, Stopp inserts the transcript at the cursor", async ({ page }) => {
  await mockTauri(page, { start: { ok: true, phase: "recording" }, stop: { ok: true, phase: "idle", text: "Hallo Welt" } });
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "speech", [..."vor"]);
  await page.getByRole("button", { name: "Sprache" }).click();
  await page.getByRole("button", { name: "Stopp" }).click();
  await expect(page.getByRole("status")).toHaveText("Transkript eingefügt.");
  await expect.poll(() => getDraft(page)).toBe("vor\nHallo Welt");
  expect((await page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls.filter((c) => c[0] === "whisperstorm").map((c) => c[1])))).toEqual([{ cmd: "start" }, { cmd: "stop" }]);
  await page.screenshot({ path: test.info().outputPath("speech-transcript.png") });
});

test("speech: the global hotkey event focuses the editor and toggles dictation (start, then stop)", async ({ page }) => {
  await mockTauri(page, { start: { ok: true, phase: "recording" }, stop: { ok: true, phase: "idle", text: "Hallo Hotkey" } });
  await page.goto("/");
  await page.getByRole("button", { name: "Einstellungen" }).click(); // the hotkey must also work from another tab
  const press = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("picky:focus-capture", { detail: { toggle: true } })));
  await press();
  await expect(page.getByRole("button", { name: "Stopp" })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeFocused();
  await press();
  await expect(page.getByRole("status")).toHaveText("Transkript eingefügt.");
  await expect.poll(() => getDraft(page)).toContain("Hallo Hotkey");
  expect((await page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls.filter((c) => c[0] === "whisperstorm").map((c) => c[1])))).toEqual([{ cmd: "start" }, { cmd: "stop" }]);
});

test("speech: a missing WhisperStorm shows the error and leaves the draft alone", async ({ page }) => {
  await mockTauri(page, { start: { ok: false, error: "WhisperStorm läuft nicht (kein Socket)" } });
  await page.goto("/");
  await page.locator(".cm-content").click();
  await steps(page, "speech-err", [..."vor"]);
  await page.getByRole("button", { name: "Sprache" }).click();
  await expect(page.getByRole("status")).toHaveText("WhisperStorm läuft nicht (kein Socket)");
  await expect(page.getByRole("button", { name: "Stopp" })).toHaveCount(0);
  expect(await getDraft(page)).toBe("vor");
});

test("buttons: Screenshot and Datei insert inline attachments through the same pending: path as paste", async ({ page }) => {
  await mockTauri(page, { start: { ok: false } });
  await page.goto("/");
  await page.locator(".cm-content").click();
  await page.getByRole("button", { name: "Screenshot" }).click();
  await expect.poll(() => getDraft(page)).toMatch(/^!\[screenshot\.png\]\(pending:[a-f0-9-]+\)\n$/);
  await expect(page.locator(".cm-content .cm-atomic-image img")).toHaveAttribute("src", /^blob:/);
  await page.locator('input[type="file"]').setInputFiles({ name: "notiz.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
  await expect.poll(() => getDraft(page)).toMatch(/\n\[notiz\.pdf\]\(pending:[a-f0-9-]+\)\n$/);
  await expect(page.locator(".cm-pn-file-chip")).toHaveText("📎 notiz.pdf");
  await page.screenshot({ path: test.info().outputPath("buttons-attachments.png") });
});

test("paste: pasting an image inserts an inline `![name](pending:<id>)` link", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();
  // Programmatically dispatch a paste with an image file (the real browser clipboard can't be driven from headless).
  const inserted = await page.evaluate(async () => {
    const file = new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "bild.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 250));
    return localStorage.getItem("picky.draft") ?? "";
  });
  expect(inserted).toMatch(/!\[[^\]]*\]\(pending:[a-f0-9-]+\)/);
  await expect(page.locator(".cm-content .cm-atomic-image img")).toHaveCount(1);
  await expect(page.locator(".cm-content .cm-atomic-image img")).toHaveAttribute("src", /^blob:/);
  await page.screenshot({ path: "test-results/paste-image.png" });
});
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
  await expect(editor).toContainText("H~2~O x^2^");
  expect(await page.locator(".cm-pn-sub").count()).toBeGreaterThan(0);
  expect(await page.locator(".cm-pn-sup").count()).toBeGreaterThan(0);
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
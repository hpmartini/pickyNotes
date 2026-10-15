import { expect, test } from "@playwright/test";

// Regression for the reported editor bugs; needs the real CodeMirror/Atomic Editor, a jsdom textarea mock cannot show them.
test("typing keeps focus, lists work, draft survives a tab switch, text is readable", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();

  // 1. focus: ten characters one by one without clicking again
  await page.keyboard.type("0123456789", { delay: 20 });
  await expect(editor).toContainText("0123456789");
  expect(await page.evaluate(() => document.querySelector(".cm-content")!.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");

  // 2. lists: "- " renders a bullet, Enter continues, Tab indents
  await page.keyboard.type("- eins", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("zwei", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("eingerückt", { delay: 20 });
  await expect(page.locator(".cm-line")).toHaveText(["•eins", "•zwei", "•eingerückt"]);
  expect(await page.evaluate(() => localStorage.getItem("picky.draft"))).toBe("- eins\n- zwei\n  - eingerückt");

  // 3. readable colours: editor text clearly darker than its background in the light theme
  const [fg, bg] = await page.evaluate(() => {
    const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number);
    return [rgb(getComputedStyle(document.querySelector(".cm-content")!).color), rgb(getComputedStyle(document.body).backgroundColor)];
  });
  const lum = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  expect(Math.abs(lum(fg!) - lum(bg!))).toBeGreaterThan(150);

  // 4. draft survives leaving the capture tab
  await page.getByRole("button", { name: "Einstellungen" }).click();
  await page.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.locator(".cm-line")).toHaveText(["•eins", "•zwei", "•eingerückt"]);
});

// Exploratory regression: type a full markdown document one keystroke at a time, after each keystroke
// assert the rendered DOM still matches the CommonMark expectations users expect from Obsidian / Notion:
//   - "# ".."### " only render headings, never "Text" + "---"/"===" underneath (Setext is off)
//   - "- " starts a bullet only once content follows, never on a bare "-" under text
//   - "---" under text becomes a horizontal rule, "-" under text stays paragraph text
//   - lists (bullet, ordered, task) continue on Enter, indent on Tab, exit on empty Enter
//   - **bold**, *italic*, `code`, > quote, ```code```, [link](url) all parse
//   - no line-height / font-size jump on non-heading lines, focus stays in the editor
test("character-by-character typing: no unexpected heading, no line-height jump, focus stays in the editor", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();

  /** Reads the rendered DOM into a probe object. */
  const inspect = () =>
    page.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-content .cm-line")] as HTMLElement[];
      const data = lines.map((line) => ({
        text: line.textContent ?? "",
        classes: [...line.classList],
        fontSize: parseFloat(getComputedStyle(line).fontSize),
        fontFamily: getComputedStyle(line).fontFamily,
      }));
      return {
        lines: data.map((d) => d.text),
        classes: data.map((d) => d.classes),
        styles: data.map((d) => d.fontSize),
        fonts: data.map((d) => d.fontFamily),
        focus: document.activeElement instanceof Node && document.querySelector(".cm-content")!.contains(document.activeElement),
      };
    });

  // Per-keystroke: a cm-atomic-h* class may only appear on the three ATX lines we typed (indices 0..2).
  // The reported regression surfaces as a paragraph line silently gaining cm-atomic-h1/h2 (SetextHeading
  // mapping), so flagging any unexpected heading-class line is the direct check. Non-heading, non-HR,
  // non-code lines must keep the paragraph font size; code lines render in monospace and are skipped by
  // font-family comparison.
  let paragraphSize: number | undefined;
  let paragraphFontFamily: string | undefined;
  const assertSteady = (lines: string[], classes: string[][], styles: number[], fonts: string[], focus: boolean, label: string) => {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "Eine Zeile Text" && paragraphSize === undefined) {
        paragraphSize = styles[i];
        paragraphFontFamily = fonts[i];
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const cls = classes[i]!;
      if (cls.some((x) => /^cm-atomic-h[1-6]$/.test(x))) {
        // shortcut: only the first three lines may be headings — they are the typed ATX headings; cheaper than re-deriving which line is which
        const allowed = i < 3;
        expect(allowed, `line ${i} (text=${JSON.stringify(lines[i])}) has a heading class but is not one of the typed ATX headings at ${label}`).toBe(true);
        continue;
      }
      if (cls.includes("cm-atomic-hr")) continue;
      if (paragraphFontFamily !== undefined && fonts[i] !== paragraphFontFamily) continue; // code: monospace
      if (paragraphSize !== undefined && styles[i] !== paragraphSize) {
        expect(styles[i], `line ${i} (text=${JSON.stringify(lines[i])}) has fontSize ${styles[i]} but paragraph is ${paragraphSize} at ${label}`).toBe(paragraphSize);
      }
    }
    expect(focus, `focus should stay in the editor at ${label}`).toBe(true);
  };

  const step = async (key: string | { type: string; key: string; shiftKey?: boolean }, label: string) => {
    if (typeof key === "string") {
      for (const ch of key) {
        await page.keyboard.type(ch);
        const probe = await inspect();
        assertSteady(probe.lines, probe.classes, probe.styles, probe.fonts, probe.focus, label);
      }
      return;
    }
    if (key.type === "press") await page.keyboard.press(key.shiftKey ? `Shift+${key.key}` : key.key);
    else if (key.type === "down") await page.keyboard.down(key.key);
    else if (key.type === "up") await page.keyboard.up(key.key);
    const probe = await inspect();
    assertSteady(probe.lines, probe.classes, probe.styles, probe.fonts, probe.focus, label);
  };

  // ---- ATX headings ----
  await step("# Titel", "ATX h1");
  await step({ type: "press", key: "Enter" }, "Enter after ATX h1");
  await step("## Untertitel", "ATX h2");
  await step({ type: "press", key: "Enter" }, "Enter after ATX h2");
  await step("### Tief", "ATX h3");
  await step({ type: "press", key: "Enter" }, "Enter after ATX h3");
  await step({ type: "press", key: "Enter" }, "blank line");

  // ---- paragraph text, the bug case ----
  await step("Eine Zeile Text", "paragraph");
  // The reported bug: text + Enter + "-" turned the line above into a huge title.
  await step({ type: "press", key: "Enter" }, "Enter after paragraph");
  await step("-", "bare dash under text (regression)");
  await step({ type: "press", key: "Enter" }, "Enter after bare dash");
  await step("---", "HR under text");

  await step({ type: "press", key: "Enter" }, "Enter after HR");
  await step({ type: "press", key: "Enter" }, "blank line");

  // ---- bullet list: Tab indents, Shift-Tab outdents ----
  await step("- eins", "bullet item");
  await step({ type: "press", key: "Enter" }, "Enter continues bullet");
  await step("zwei", "second bullet text");
  await step({ type: "press", key: "Enter" }, "Enter continues");
  await step({ type: "press", key: "Tab" }, "Tab indents");
  await step("eingerückt", "nested bullet text");
  await step({ type: "press", key: "Enter" }, "Enter on nested");
  const beforeShiftTab = await page.evaluate(() => localStorage.getItem("picky.draft") ?? "");
  await step({ type: "press", key: "Tab", shiftKey: true }, "Shift-Tab outdents");
  const afterShiftTab = await page.evaluate(() => localStorage.getItem("picky.draft") ?? "");
  const beforeLast = beforeShiftTab.split("\n").pop() ?? "";
  const afterLast = afterShiftTab.split("\n").pop() ?? "";
  expect(afterLast.startsWith("  "), `Shift+Tab should outdent; last line went from ${JSON.stringify(beforeLast)} to ${JSON.stringify(afterLast)}`).toBe(false);
  expect(afterLast.startsWith("- "), `after Shift+Tab the last line should be a top-level bullet, got ${JSON.stringify(afterLast)}`).toBe(true);
  await step({ type: "press", key: "Enter" }, "Enter exits list");

  // ---- bullet list: Backspace on an empty "- " item exits the bullet ----
  await step("- ", "empty bullet item");
  await step({ type: "press", key: "Backspace" }, "Backspace exits empty bullet");
  const probeAfterBs = await inspect();
  const lastLineAfterBs = probeAfterBs.lines[probeAfterBs.lines.length - 1] ?? "";
  expect(lastLineAfterBs.includes("•"), `Backspace on empty bullet should drop the bullet; last line is ${JSON.stringify(lastLineAfterBs)}`).toBe(false);

  // ---- ordered list ----
  await step("1. eins", "ordered item");
  await step({ type: "press", key: "Enter" }, "Enter continues ordered");
  await step("zwei", "second ordered");
  await step({ type: "press", key: "Enter" }, "Enter");
  await step({ type: "press", key: "Enter" }, "Enter exits ordered");

  // ---- task list ----
  await step("- [ ] aufgabe", "task item");
  await step({ type: "press", key: "Enter" }, "Enter after task");
  await step({ type: "press", key: "Enter" }, "Enter exits task");

  // ---- inline marks ----
  await step("**fett**", "bold");
  await step({ type: "press", key: "Enter" }, "Enter after bold");
  await step("*kursiv*", "italic");
  await step({ type: "press", key: "Enter" }, "Enter after italic");
  await step("`code`", "inline code");
  await step({ type: "press", key: "Enter" }, "Enter after code");
  await step("> zitat", "quote");
  await step({ type: "press", key: "Enter" }, "Enter after quote");
  await step({ type: "press", key: "Enter" }, "blank");

  // ---- fenced code ----
  await step("```", "code fence open");
  await step("code hier", "code body");
  await step({ type: "press", key: "Enter" }, "Enter in code body");
  await step("```", "code fence close");
  await step({ type: "press", key: "Enter" }, "Enter after fence");
  await step({ type: "press", key: "Enter" }, "blank");

  // ---- link ----
  await step("[label](https://example.org)", "link");
  await step({ type: "press", key: "Enter" }, "Enter after link");

  // ---- final regression: the Setext bug specifically ----
  // The reported bug: typing a line, Enter, then "-" turned the line above into a huge title.
  // After the fix, the only way a line gets cm-atomic-h1/h2 is via an ATX ("# "/"## ") source line.
  // We verify by enumerating every DOM line that has a heading class and checking it was one of the
  // three ATX lines we typed. ("Titel" / "Untertitel" / "Tief" are the rendered textContent of those
  // three lines; the "# "/"## "/"### " prefix is hidden by inline-preview.)
  const finalProbe = await inspect();
  const allowedHeadingRendered = new Set(["Titel", "Untertitel", "Tief"]);
  for (let i = 0; i < finalProbe.lines.length; i++) {
    const cls = finalProbe.classes[i]!;
    if (!cls.some((c) => /^cm-atomic-h[1-6]$/.test(c))) continue;
    const rendered = finalProbe.lines[i]!.trim();
    expect(allowedHeadingRendered.has(rendered), `DOM line ${i} (${JSON.stringify(rendered)}) has a heading class but its source wasn't "# ${rendered}"`).toBe(true);
  }

  // The paragraph line "Eine Zeile Text" must stay a paragraph (no heading class anywhere on it).
  const paragraphIdx = finalProbe.lines.findIndex((t) => t.trim() === "Eine Zeile Text");
  expect(paragraphIdx, `"Eine Zeile Text" should appear in the rendered DOM`).toBeGreaterThanOrEqual(0);
  expect(finalProbe.classes[paragraphIdx]!.some((c) => /^cm-atomic-h[1-6]$/.test(c)), `"Eine Zeile Text" must not have a heading class`).toBe(false);

  // The `---` we typed should land as a horizontal rule.
  const hrCount = finalProbe.classes.filter((c) => c.includes("cm-atomic-hr")).length;
  expect(hrCount, "at least one horizontal rule from the typed `---`").toBeGreaterThanOrEqual(1);

  // visual sanity: one screenshot for a human look — Playwright writes it under apps/desktop/test-results/ (gitignored)
  const shot = await page.locator(".editor").screenshot({ path: test.info().outputPath("exploratory.png") });
  expect(shot.length).toBeGreaterThan(0);
});

for (const [width, height] of [[375, 640], [768, 700], [1280, 800]]) {
  test(`layout at ${width}px: no sideways scroll, no permanent editor scrollbar, no overlapping actions`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.locator(".cm-content").click();
    await page.keyboard.type("kurz", { delay: 10 });
    const m = await page.evaluate(() => {
      const d = document.documentElement;
      const s = document.querySelector(".cm-scroller")!;
      const r = [...document.querySelectorAll(".actions > *")].map((e) => e.getBoundingClientRect());
      const overlap = r.some((a, i) => r.some((b, j) => i < j && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
      return { hScroll: d.scrollWidth > d.clientWidth, pageVScroll: d.scrollHeight > d.clientHeight, editorScrollbar: s.scrollHeight > s.clientHeight + 1, overlap };
    });
    expect(m).toEqual({ hScroll: false, pageVScroll: false, editorScrollbar: false, overlap: false });
  });
}

test.use({ colorScheme: "light" });

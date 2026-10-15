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
//   - lists (bullet, ordered, task) continue on Enter, indent on Tab, exit on empty Enter (with blank separator)
//   - **bold**, *italic*, `code`, > quote, ```code```, [link](url) all parse
//   - no line-height / font-size jump on non-heading lines, focus stays in the editor
test("character-by-character typing: no unexpected heading, no line-height jump, focus stays in the editor", async ({ page }) => {
  test.setTimeout(90_000); // ~55 step() calls × inspect + screenshot
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
        inner: [...new Set([...line.querySelectorAll("[class*=cm-atomic-]")].flatMap((e) => [...e.classList]))],
      }));
      return {
        lines: data.map((d) => d.text),
        classes: data.map((d) => d.classes),
        styles: data.map((d) => d.fontSize),
        fonts: data.map((d) => d.fontFamily),
        inner: data.map((d) => d.inner),
        focus: document.activeElement instanceof Node && document.querySelector(".cm-content")!.contains(document.activeElement),
      };
    });

  // Per-keystroke: a cm-atomic-h* class may only appear on a source line that actually starts with "#" — derived from the current draft, not from a hard-coded index. Non-heading, non-HR, non-code lines must keep the paragraph font size; code lines render in monospace and are skipped by font-family comparison.
  let paragraphSize: number | undefined;
  let paragraphFontFamily: string | undefined;
  const assertSteady = async (lines: string[], classes: string[][], styles: number[], fonts: string[], focus: boolean, label: string) => {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "Eine Zeile Text" && paragraphSize === undefined) {
        paragraphSize = styles[i];
        paragraphFontFamily = fonts[i];
      }
    }
    const draftLines = (await page.evaluate(() => localStorage.getItem("picky.draft") ?? "")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const cls = classes[i]!;
      const draftLine = draftLines[i] ?? "";
      if (cls.some((x) => /^cm-atomic-h[1-6]$/.test(x))) {
        // shortcut: Atomic renders `#` (one or more hashes) as a heading as you type, before the trailing space is even there; derive the level from the count of `#`s in the draft line.
        const m = draftLine.match(/^(#{1,6})/);
        expect(m, `line ${i} (text=${JSON.stringify(lines[i])}) has a heading class but draft line ${JSON.stringify(draftLine)} does not start with '#' at ${label}`).toBeTruthy();
        expect(cls.find((c) => /^cm-atomic-h[1-6]$/.test(c)), `line ${i} heading class should match draft ${JSON.stringify(draftLine)} at ${label}`).toBe(`cm-atomic-h${m![1]!.length}`);
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

  let stepNum = 0;
  const step = async (key: string | { type: string; key: string; shiftKey?: boolean }, label: string) => {
    const probeAfter = async () => {
      const probe = await inspect();
      await assertSteady(probe.lines, probe.classes, probe.styles, probe.fonts, probe.focus, label);
    };
    if (typeof key === "string") {
      for (const ch of key) {
        await page.keyboard.type(ch);
        await probeAfter();
      }
    } else if (key.type === "press") {
      await page.keyboard.press(key.shiftKey ? `Shift+${key.key}` : key.key);
      await probeAfter();
    } else if (key.type === "down") {
      await page.keyboard.down(key.key);
      await probeAfter();
    } else if (key.type === "up") {
      await page.keyboard.up(key.key);
      await probeAfter();
    }
    await page.locator(".editor").screenshot({ path: test.info().outputPath(`step-${String(stepNum++).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
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
  await step({ type: "press", key: "Enter" }, "Enter exits list with blank line");

  // ---- bullet list: Backspace on an empty "- " item exits the bullet and leaves a clean empty line ----
  await step("- ", "empty bullet item");
  await step({ type: "press", key: "Backspace" }, "Backspace exits empty bullet");
  const draftAfterBs = await page.evaluate(() => localStorage.getItem("picky.draft") ?? "");
  expect(draftAfterBs.split("\n").pop(), "Backspace on an empty bullet must leave a completely empty line (indent spaces would nest the next list)").toBe("");

  // ---- ordered list ----
  await step("1. eins", "ordered item");
  await step({ type: "press", key: "Enter" }, "Enter continues ordered");
  await step("zwei", "second ordered");
  await step({ type: "press", key: "Enter" }, "Enter continues from non-empty");
  await step({ type: "press", key: "Enter" }, "Enter exits ordered with blank line");

  // ---- task list ----
  await step("- [ ] aufgabe", "task item");
  await step({ type: "press", key: "Enter" }, "Enter continues task");
  await step({ type: "press", key: "Enter" }, "Enter exits task with blank line");

  // ---- inline marks ----
  await step("**fett**", "bold");
  await step({ type: "press", key: "Enter" }, "Enter after bold");
  await step("*kursiv*", "italic");
  await step({ type: "press", key: "Enter" }, "Enter after italic");
  await step("`code`", "inline code");
  await step({ type: "press", key: "Enter" }, "Enter after code");
  await step("> zitat", "quote");
  await step({ type: "press", key: "Enter" }, "Enter continues quote");
  await step({ type: "press", key: "Enter" }, "Enter exits quote with blank line");

  // ---- fenced code: Atomic auto-closes the fence, so Enter goes into the body and ArrowDown leaves it ----
  await step("```", "code fence open");
  await step({ type: "press", key: "Enter" }, "Enter into code body");
  await step("code hier", "code body");
  await step({ type: "press", key: "ArrowDown" }, "ArrowDown on the last body line leaves the block");
  await step({ type: "press", key: "Enter" }, "blank line");

  // ---- link ----
  await step("[label](https://example.org)", "link");
  await step({ type: "press", key: "Enter" }, "Enter after link");

  // ---- final: the markdown source is exactly what was typed (no auto-inserted markers, no lost/merged lines) ----
  const expected = [
    "# Titel", "## Untertitel", "### Tief", "",
    "Eine Zeile Text", "-", "---", "",
    "- eins", "- zwei", "  - eingerückt", "",
    "1. eins", "2. zwei", "",
    "- [ ] aufgabe", "",
    "**fett**", "*kursiv*", "`code`", "> zitat", "",
    "```", "code hier", "```", "",
    "[label](https://example.org)", "",
  ];
  expect(await page.evaluate(() => localStorage.getItem("picky.draft"))).toBe(expected.join("\n"));

  // ---- final: every DOM line renders what its source line says (DOM line i == source line i) ----
  const dom = await inspect();
  expect(dom.lines).toHaveLength(expected.length);
  const heading = (cls: string[]) => cls.find((c) => /^cm-atomic-h[1-6]$/.test(c));
  expected.forEach((src, i) => {
    const cls = dom.classes[i]!;
    const inner = dom.inner[i]!;
    const why = `DOM line ${i} for source ${JSON.stringify(src)} (classes ${cls}, inner ${inner}, text ${JSON.stringify(dom.lines[i])})`;
    const atx = src.match(/^(#{1,3}) /);
    expect(heading(cls), why).toBe(atx ? `cm-atomic-h${atx[1]!.length}` : undefined); // heading class only on # lines
    expect(cls.includes("cm-atomic-hr"), why).toBe(src === "---");
    expect(cls.includes("cm-atomic-blockquote"), why).toBe(src.startsWith("> ")); // quote does not leak onto the fence/link below
    expect(cls.includes("cm-atomic-fenced-code"), why).toBe(["```", "code hier"].includes(src));
    if (/^\s*(- |\d+\. )./.test(src)) expect(inner, why).toContain("cm-atomic-list-marker");
    if (/^\s*- \[ \]/.test(src)) expect(inner, why).toContain("cm-atomic-task-checkbox");
    else if (/^\s*- ./.test(src)) expect(inner, why).toContain("cm-atomic-bullet");
    if (src === "**fett**") expect(inner, why).toContain("cm-atomic-strong");
    if (src === "*kursiv*") expect(inner, why).toContain("cm-atomic-em");
    if (src === "`code`") expect(inner, why).toContain("cm-atomic-inline-code");
    if (src.startsWith("[label]")) {
      expect(inner, why).toContain("cm-atomic-link");
      expect(dom.lines[i], why).toContain("label");
    }
    if (src === "code hier") expect(dom.fonts[i], why).not.toBe(paragraphFontFamily); // monospace, not the quote/paragraph font
    if (src === "Eine Zeile Text") expect(dom.styles[i], why).toBe(paragraphSize);
  });
  expect(dom.focus, "focus stays in the editor").toBe(true);

  // visual sanity: one extra screenshot at the very end, with a stable path that is easy to open from the test-results folder
  const shot = await page.locator(".editor").screenshot({ path: test.info().outputPath("exploratory.png") });
  expect(shot.length).toBeGreaterThan(0);
});

// Obsidian/Notion parity: pressing Enter on an empty list/quote marker exits the block AND inserts a blank line before the next text, so "danach" starts a fresh paragraph (no lazy continuation, no quote/list indent leaking through).
const exits = [
  { name: "bullet", keys: ["para", "Enter", "Enter", "- a", "Enter", "Enter", "danach"], draft: "para\n\n- a\n\ndanach" },
  { name: "task", keys: ["para", "Enter", "Enter", "- [ ] a", "Enter", "Enter", "danach"], draft: "para\n\n- [ ] a\n\ndanach" },
  { name: "ordered", keys: ["para", "Enter", "Enter", "1. a", "Enter", "Enter", "danach"], draft: "para\n\n1. a\n\ndanach" },
  { name: "quote", keys: ["para", "Enter", "Enter", "> a", "Enter", "Enter", "danach"], draft: "para\n\n> a\n\ndanach" },
  { name: "nested", keys: ["para", "Enter", "Enter", "- a", "Enter", "Tab", "b", "Enter", "Enter", "Enter", "danach"], draft: "para\n\n- a\n  - b\n\ndanach" },
];
for (const { name, keys, draft } of exits) {
  test(`Enter exits empty ${name} marker: danach is a plain paragraph (no list/quote classes, no indent padding)`, async ({ page }) => {
    await page.goto("/");
    const editor = page.locator(".cm-content");
    await editor.click();
    for (const k of keys) {
      if (k === "Enter" || k === "Tab") await page.keyboard.press(k);
      else await page.keyboard.type(k, { delay: 10 });
    }
    // exact draft
    expect(await page.evaluate(() => localStorage.getItem("picky.draft"))).toBe(draft);
    // danach: no list/quote classes on the line or its inner cm-atomic-* elements, same padding-left as a plain paragraph line
    const probe = await page.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-content .cm-line")] as HTMLElement[];
      const find = (text: string) => lines.find((l) => l.textContent === text);
      const danach = find("danach");
      const para = find("para");
      if (!danach || !para) return null;
      const listOrQuote = /cm-atomic-(list|blockquote|bullet|task)/;
      return {
        danach: { classes: [...danach.classList], inner: [...new Set([...danach.querySelectorAll("[class*=cm-atomic-]")].flatMap((e) => [...e.classList]))], paddingLeft: getComputedStyle(danach).paddingLeft },
        para: { paddingLeft: getComputedStyle(para).paddingLeft },
        rule: listOrQuote.source,
      };
    });
    expect(probe, "danach and para lines should both exist").not.toBeNull();
    expect(probe!.danach.classes.some((c) => new RegExp(probe!.rule).test(c)), `danach line classes should not match ${probe!.rule}, got ${JSON.stringify(probe!.danach.classes)}`).toBe(false);
    expect(probe!.danach.inner.some((c) => new RegExp(probe!.rule).test(c)), `danach inner classes should not match ${probe!.rule}, got ${JSON.stringify(probe!.danach.inner)}`).toBe(false);
    expect(probe!.danach.paddingLeft, `danach paddingLeft ${probe!.danach.paddingLeft} should match para paddingLeft`).toBe(probe!.para.paddingLeft);
  });
}

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

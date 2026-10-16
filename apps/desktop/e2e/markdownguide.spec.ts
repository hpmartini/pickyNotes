import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { activeText } from "./helpers";

// One test per feature of markdownguide.org (basic-syntax, extended-syntax, cheat-sheet, hacks), typed character by character
// into the real editor. Each asserts the saved draft text AND the rendered DOM classes; a screenshot per typed line lands in test-results/.
// Keys: ⏎ Enter, ⇥ Tab, ⇩ ArrowDown. Everything else is typed one character at a time.

const KEYS: Record<string, string> = { "⏎": "Enter", "⇥": "Tab", "⇩": "ArrowDown", "⇲": "End" };
const draft = (page: Page) => activeText(page);

async function typeSteps(page: Page, name: string, keys: string) {
  let step = 0;
  for (const ch of keys) {
    if (KEYS[ch]) await page.keyboard.press(KEYS[ch]);
    else await page.keyboard.type(ch);
    if (ch === "⏎" || ch === "⇩") await shot(page, name, ++step);
  }
  await shot(page, name, ++step);
}
const shot = (page: Page, name: string, i: number) =>
  page.locator(".editor").screenshot({ path: test.info().outputPath(`${name}-step${String(i).padStart(2, "0")}.png`) });

interface Feature {
  name: string;
  keys: string;
  draft: string;
  /** selector → expected count (number) or [min count, text of the first match] */
  dom: Record<string, number | [number, string]>;
  /** visible text of the whole editor, when the render must differ from the source (hidden marks) */
  text?: string;
}

const FEATURES: Feature[] = [
  { name: "headings-atx", keys: "# H1⏎## H2⏎###### H6⏎ende", draft: "# H1\n## H2\n###### H6\nende", dom: { ".cm-atomic-h1": 1, ".cm-atomic-h2": 1, ".cm-atomic-h6": 1 } },
  { name: "headings-setext-off", keys: "Titel⏎===⏎ende", draft: "Titel\n===\nende", dom: { ".cm-atomic-h1": 0, ".cm-atomic-h2": 0 } },
  { name: "paragraph-linebreak", keys: "eins  ⏎zwei\\⏎drei⏎⏎vier", draft: "eins  \nzwei\\\ndrei\n\nvier", dom: { ".cm-line": 5 } },
  { name: "bold-italic", keys: "**b** __b__ *i* _i_ ***bi***⏎ende", draft: "**b** __b__ *i* _i_ ***bi***\nende", dom: { ".cm-atomic-strong": [3, "b"], ".cm-atomic-em": [3, "i"] } },
  { name: "strikethrough", keys: "~~weg~~⏎ende", draft: "~~weg~~\nende", dom: { ".cm-atomic-strike": [1, "weg"] }, text: "weg\nende" },
  { name: "highlight", keys: "==hi==⏎ende", draft: "==hi==\nende", dom: { ".cm-atomic-highlight": [1, "hi"] }, text: "hi\nende" },
  { name: "blockquote-nested", keys: "> a⏎> b⏎⏎ende", draft: "> a\n> > b\n\nende", dom: { ".cm-atomic-blockquote": 2 } },
  { name: "list-unordered-nested", keys: "- a⏎b⏎⇥c⏎⏎⏎ende", draft: "- a\n- b\n  - c\n\nende", dom: { ".cm-atomic-bullet": 3 } },
  { name: "list-ordered-nested", keys: "1. a⏎b⏎⇥c⏎⏎⏎ende", draft: "1. a\n2. b\n   1. c\n\nende", dom: { ".cm-atomic-list-marker": 3 } },
  { name: "code-inline", keys: "`code`⏎ende", draft: "`code`\nende", dom: { ".cm-atomic-inline-code": [1, "code"] }, text: "code\nende" },
  {
    name: "code-fenced-language", keys: "```js⏎const a = 1;⇩ende", draft: "```js\nconst a = 1;\n```\nende",
    dom: { ".cm-pn-fence-hidden": 2, ".cm-atomic-fenced-code": 3 },
  },
  { name: "horizontal-rule", keys: "a⏎⏎---⏎ende", draft: "a\n\n---\nende", dom: { ".cm-atomic-hr": 1 } },
  {
    name: "links", keys: "[t](https://x.y) <https://x.y> [r][1] https://auto.url⏎⏎[1]: https://x.y⏎ende",
    draft: "[t](https://x.y) <https://x.y> [r][1] https://auto.url\n\n[1]: https://x.y\nende", dom: { ".cm-atomic-link": [2, "t"] },
  },
  { name: "image", keys: "![alt](/none.png)⏎ende", draft: "![alt](/none.png)\nende", dom: { ".cm-atomic-image": 1 } },
  { name: "backslash-escape", keys: "\\*kein kursiv\\*⏎ende", draft: "\\*kein kursiv\\*\nende", dom: { ".cm-atomic-em": 0 }, text: "*kein kursiv*\nende" },
  {
    name: "html-inline", keys: "<b>fett</b> <sub>2</sub> <mark>m</mark> <kbd>k</kbd>⏎ende",
    draft: "<b>fett</b> <sub>2</sub> <mark>m</mark> <kbd>k</kbd>\nende",
    dom: { ".cm-pn-html-b": [1, "fett"], ".cm-pn-sub": [1, "2"], ".cm-pn-html-mark": [1, "m"], ".cm-pn-html-kbd": [1, "k"] }, text: "fett 2 m k\nende",
  },
  { name: "task-list", keys: "- [x] fertig⏎offen⏎⏎ende", draft: "- [x] fertig\n- [ ] offen\n\nende", dom: { ".cm-atomic-task-checkbox": 2 } },
  { name: "emoji", keys: ":joy: :rocket:⏎ende", draft: ":joy: :rocket:\nende", dom: { ".cm-pn-emoji": [2, "😂"] }, text: "😂 🚀\nende" },
  { name: "sub-sup-markdown", keys: "H~2~O X^2^⏎ende", draft: "H~2~O X^2^\nende", dom: { ".cm-pn-sub": [1, "2"], ".cm-pn-sup": [1, "2"] } },
  {
    name: "footnote", keys: "Satz[^1]⏎⏎[^1]: Notiz⏎ende", draft: "Satz[^1]\n\n[^1]: Notiz\nende",
    dom: { ".cm-pn-footnote-ref": [1, "1"], ".cm-pn-footnote-def": 1, ".cm-pn-sup": 0 },
  },
  { name: "definition-list", keys: "Begriff⏎: Erklärung⏎ende", draft: "Begriff\n: Erklärung\nende", dom: { ".cm-pn-dl-term": 1, ".cm-pn-dl-def": 1 } },
  { name: "heading-id", keys: "### Kopf {#kopf}⏎ende", draft: "### Kopf {#kopf}\nende", dom: { ".cm-atomic-h3": 1, ".cm-pn-heading-id": [1, "{#kopf}"] } },
  {
    name: "hacks-nbsp-comment", keys: "a&nbsp;&nbsp;b⏎⏎<!-- c -->⏎ende", draft: "a&nbsp;&nbsp;b\n\n<!-- c -->\nende",
    dom: { ".cm-pn-entity": [2, " "] },
  },
  // <br>, <center>, <p align>, <img width>: no HTML renderer in the editor; the source stays visible and intact (see JOURNAL).
  // `<center>` at a line start gets its closing tag from the editor's tag auto-close, so End steps over it instead of typing `</center>`.
  { name: "hacks-html-block-source", keys: "<center>mitte⇲⏎a<br>b⏎ende", draft: "<center>mitte</center>\na<br>b\nende", dom: {}, text: "<center>mitte</center>\na<br>b\nende" },
];

for (const f of FEATURES) {
  test(`markdownguide: ${f.name}`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".cm-content").click();
    await typeSteps(page, f.name, f.keys);
    await expect.poll(() => draft(page), { message: "draft" }).toBe(f.draft);
    for (const [sel, want] of Object.entries(f.dom)) {
      const [count, text] = typeof want === "number" ? [want, undefined] : want;
      const loc = page.locator(`.cm-content ${sel}`);
      if (text === undefined) await expect(loc, sel).toHaveCount(count);
      else {
        expect(await loc.count(), sel).toBeGreaterThanOrEqual(count);
        await expect(loc.first(), sel).toHaveText(text);
      }
    }
    if (f.text !== undefined) {
      const lines = (await page.locator(".cm-line:visible").allInnerTexts()).filter(Boolean).join("\n");
      expect(lines).toBe(f.text);
    }
  });
}

// Enter after a pipe row builds the table skeleton and focuses the first body cell (a hand-typed delimiter row breaks Atomic's widget, see JOURNAL); cells are then typed in the widget.
test("markdownguide: table typed header, Enter, cells with Tab; alignment via the toolbar stays valid GFM", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cm-content").click();
  await typeSteps(page, "table", "| a | b |⏎");
  await expect.poll(() => draft(page)).toBe("| a | b |\n| --- | --- |\n|  |  |");
  await page.keyboard.type("1");
  await page.keyboard.press("Tab");
  await page.keyboard.type("2");
  await expect.poll(() => draft(page)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  await shot(page, "table", 20);
  await expect(page.locator(".cm-atomic-table")).toHaveCount(1);
  for (const [name, expectDelim, align] of [["⇔ C", "| :---: | :---: |", "center"], ["⇥ R", "| ---: | ---: |", "right"], ["⇤ L", "| :--- | :--- |", "left"]] as const) {
    await page.locator(".cm-pn-table-toolbar").getByRole("button", { name }).dispatchEvent("mousedown");
    await expect.poll(async () => (await draft(page)).split("\n")[1]).toBe(expectDelim);
    await expect.poll(() => page.locator(".cm-atomic-table td").evaluateAll((t) => t.map((c) => getComputedStyle(c).textAlign))).toEqual([align, align]);
    await shot(page, `table-${align}`, 21);
  }
  expect((await draft(page)).split("\n")).toEqual(["| a | b |", "| :--- | :--- |", "| 1 | 2 |"]);
});

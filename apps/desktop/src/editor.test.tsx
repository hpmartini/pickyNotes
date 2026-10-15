// Real Atomic Editor / CodeMirror (no mocks): proves lists behave in the editor we ship, not in a textarea stand-in.
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { syntaxTree } from "@codemirror/language";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorExtensions } from "./lib/editor";

afterEach(cleanup);

function mount(markdownSource = "") {
  const { container } = render(<AtomicCodeMirrorEditor markdownSource={markdownSource} extensions={editorExtensions} />);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  return view;
}

/** Types like a keyboard: input handlers (e.g. the "* " list start) get the first chance, else the char is inserted. */
function type(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    if (view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, () => view.state.update({})))) continue;
    view.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: "input.type" });
  }
}
const press = (view: EditorView, key: string, shiftKey = false) => {
  // shortcut: our empty-marker Enter handler is a Prec.highest domEventHandler; runScopeHandlers skips it, so dispatch a real keydown only for Enter. Tab/Backspace stay on the proven runScopeHandlers path.
  if (key === "Enter") {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    return true;
  }
  return runScopeHandlers(view, new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }), "editor");
};
const doc = (v: EditorView) => v.state.doc.toString();
const hasNode = (v: EditorView, name: string) => {
  const found = syntaxTree(v.state).cursor();
  do { if (found.name === name) return true; } while (found.next());
  return false;
};

describe("Atomic Editor lists (real CodeMirror)", () => {
  it.each([
    ["- a", "- a\n- "],
    ["* a", "* a\n* "],
    ["1. a", "1. a\n2. "],
  ])("typing %j then Enter continues the list", (typed, expected) => {
    const view = mount();
    type(view, typed);
    press(view, "Enter");
    expect(doc(view)).toBe(expected);
  });

  it("Enter on an empty item ends the list and inserts a blank line before the next paragraph", () => {
    const view = mount();
    type(view, "- a");
    press(view, "Enter");
    press(view, "Enter");
    expect(doc(view)).toBe("- a\n\n");
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("");
  });

  it("Tab indents and Shift-Tab outdents the item", () => {
    const view = mount();
    type(view, "- a");
    press(view, "Enter");
    type(view, "b");
    press(view, "Tab");
    expect(doc(view)).toMatch(/\n\s+- b$/);
    press(view, "Tab", true);
    expect(doc(view)).toBe("- a\n- b");
  });
});

describe("Setext headings are disabled (# only)", () => {
  it.each([
    ["Titel\n-"],
    ["Titel\n- "],
    ["Titel\n="],
    ["Titel\n==="],
  ])("typing %j never parses a heading", (text) => {
    const view = mount();
    type(view, text);
    expect(hasNode(view, "SetextHeading1")).toBe(false);
    expect(hasNode(view, "SetextHeading2")).toBe(false);
    expect(hasNode(view, "ATXHeading1")).toBe(false);
    expect(hasNode(view, "ATXHeading2")).toBe(false);
  });

  it("--- under text becomes a horizontal rule", () => {
    const view = mount();
    type(view, "Titel\n---");
    expect(hasNode(view, "HorizontalRule")).toBe(true);
    expect(hasNode(view, "SetextHeading1")).toBe(false);
    expect(hasNode(view, "SetextHeading2")).toBe(false);
  });

  it("ATX headings #..### still parse", () => {
    for (const text of ["# A", "## A", "### A"]) {
      const view = mount();
      type(view, text);
      expect(hasNode(view, "ATXHeading1") || hasNode(view, "ATXHeading2") || hasNode(view, "ATXHeading3")).toBe(true);
    }
  });

  it("- x on a new line after text becomes a bullet", () => {
    const view = mount();
    type(view, "Titel\n- x");
    expect(hasNode(view, "BulletList")).toBe(true);
    expect(hasNode(view, "ListItem")).toBe(true);
  });
});

describe("Obsidian/Notion parity (src/lib/editor.ts)", () => {
  it.each(["**fett**", "*kursiv*", "__fett__", "_kursiv_", "`code`"])("typing %j leaves exactly what was typed", (text) => {
    const view = mount();
    type(view, text);
    expect(doc(view)).toBe(text);
    expect(view.state.selection.main.head).toBe(text.length);
  });

  it("typing * still starts a list at a line start", () => {
    const view = mount();
    type(view, "* a");
    expect(doc(view)).toBe("* a");
    expect(hasNode(view, "BulletList")).toBe(true);
  });

  // Obsidian/Notion parity: Enter on an empty top-level list/quote marker exits the block AND drops a blank line so the next typed text starts a fresh paragraph (no lazy continuation). Indented empty markers outdent one level first, then a second Enter exits.
  describe("Enter on empty marker exits with a blank separator (Obsidian/Notion parity)", () => {
    const noListOrQuoteAncestor = (view: EditorView, pos: number) => {
      let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(pos, -1);
      while (n) {
        expect(n.name, `unexpected ancestor ${n.name} at pos ${pos}`).not.toBe("ListItem");
        expect(n.name, `unexpected ancestor ${n.name} at pos ${pos}`).not.toBe("Blockquote");
        n = n.parent;
      }
    };
    const typeThenExit = (typed: string, enters: number) => {
      const view = mount();
      type(view, typed);
      for (let i = 0; i < enters; i++) press(view, "Enter");
      type(view, "danach");
      return view;
    };
    it.each([
      ["- a", 2, "- a\n\ndanach"],
      ["- [ ] a", 2, "- [ ] a\n\ndanach"],
      ["1. a", 2, "1. a\n\ndanach"],
      ["> a", 2, "> a\n\ndanach"],
    ])("typed %j + %i Enter(s) + danach -> %j", (typed, enters, expected) => {
      const view = typeThenExit(typed, enters as number);
      expect(doc(view)).toBe(expected);
      noListOrQuoteAncestor(view, view.state.doc.length);
    });
    it("nested: indentLess then exit (three Enters)", () => {
      const view = mount();
      type(view, "- a");
      press(view, "Enter");
      press(view, "Tab");
      type(view, "b");
      press(view, "Enter");
      press(view, "Enter");
      press(view, "Enter");
      type(view, "danach");
      expect(doc(view)).toBe("- a\n  - b\n\ndanach");
      noListOrQuoteAncestor(view, view.state.doc.length);
    });
    it("Enter on '- ' inside a fenced code block leaves the marker alone (default behaviour)", () => {
      // shortcut: the domEventHandler short-circuits inside FencedCode so the editor's own Enter (newline) is what runs.
      const view = mount("- a\n```\n- \n```");
      view.dispatch({ selection: { anchor: 10 } }); // end of "- " line, inside the fence
      press(view, "Enter");
      // default Enter just inserts a newline; the "- " line must still exist (we did not replace it with a blank line) and the closing fence must still close the block
      const lines = doc(view).split("\n");
      expect(lines).toContain("- ");
      expect(lines[lines.length - 1]).toBe("```");
      expect(hasNode(view, "FencedCode")).toBe(true);
    });
  });

  it.each([
    ["- a\n- ", "- a\n"],
    ["1. a\n2. ", "1. a\n"],
    ["- [ ] a\n- [ ] ", "- [ ] a\n"],
    ["- a\n  - ", "- a\n"],
    ["text\n- ", "text\n"],
    ["text\n1. ", "text\n"],
  ])("Backspace on the empty marker of %j drops the whole marker", (typed, expected) => {
    const view = mount(typed);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, "Backspace");
    expect(doc(view)).toBe(expected);
  });

  it("a new task item after an exited list starts a fresh list item", () => {
    const view = mount();
    type(view, "- a");
    press(view, "Enter");
    press(view, "Backspace");
    type(view, "- [ ] b");
    expect(doc(view)).toBe("- a\n- [ ] b");
  });

  it("Backspace leaves non-empty lines and fenced code alone", () => {
    const view = mount("- ab\n```\n- \n```");
    view.dispatch({ selection: { anchor: 4 } });
    press(view, "Backspace");
    expect(doc(view)).toBe("- a\n```\n- \n```");
    view.dispatch({ selection: { anchor: doc(view).indexOf("- \n```") + 2 } });
    press(view, "Backspace");
    expect(doc(view)).toBe("- a\n```\n-\n```");
  });
});

// :shortcode: is not in lezer-markdown's GFM; the editor renders known ones as Unicode via a ViewPlugin.
describe("Emoji shortcode :name: -> Unicode glyph", () => {
  it.each([
    [":joy:", "😂"],
    [":rocket:", "🚀"],
    [":check:", "✅"],
    [":warning:", "⚠"],
  ])("renders %s as %s, keeps source intact", (shortcode, glyph) => {
    const view = mount(`a ${shortcode} b`);
    expect(doc(view)).toBe(`a ${shortcode} b`);
    const widget = view.dom.querySelector(`.cm-pn-emoji`);
    expect(widget, `expected one .cm-pn-emoji widget for ${shortcode}`).not.toBeNull();
    expect(widget!.textContent).toBe(glyph);
  });
  it("unknown shortcodes keep the source and render the literal text (no widget)", () => {
    // Defect fix: unknown names stay as plain text, no decoration.
    const view = mount(":nonsense:");
    expect(doc(view)).toBe(":nonsense:");
    expect(view.dom.querySelector(".cm-pn-emoji")).toBeNull();
    expect(view.dom.querySelector(".cm-content")!.textContent).toContain(":nonsense:");
  });
  it("multiple shortcodes on one line render independently", () => {
    const view = mount(":joy: and :rocket:");
    const widgets = [...view.dom.querySelectorAll(".cm-pn-emoji")];
    expect(widgets.map((w) => w.textContent)).toEqual(["😂", "🚀"]);
  });
  it("does not decorate shortcodes inside inline code", () => {
    const view = mount("a `:joy:` b");
    expect(view.dom.querySelector(".cm-pn-emoji")).toBeNull();
    expect(view.dom.querySelector(".cm-content")!.textContent).toContain(":joy:");
  });
  it("does not decorate shortcodes inside a fenced code block", () => {
    const view = mount("```\n:joy:\n```");
    expect(view.dom.querySelector(".cm-pn-emoji")).toBeNull();
  });
  it("does not decorate escaped shortcodes", () => {
    const view = mount("\\:joy:");
    expect(view.dom.querySelector(".cm-pn-emoji")).toBeNull();
    expect(view.dom.querySelector(".cm-content")!.textContent).toContain(":joy:");
  });
  it("reveals the source text when the selection sits inside the shortcode", () => {
    const view = mount(":rocket:");
    view.dispatch({ selection: { anchor: 3 } }); // cursor inside the shortcode
    expect(view.dom.querySelector(".cm-pn-emoji")).toBeNull();
    expect(view.dom.querySelector(".cm-content")!.textContent).toBe(":rocket:");
  });
  it("maps :grin: to 😁", () => {
    const view = mount(":grin:");
    const widget = view.dom.querySelector(".cm-pn-emoji");
    expect(widget!.textContent).toBe("😁");
  });
});

// Subscript `~x~` (single tilde) and superscript `^x^` are not in lezer-markdown; the editor wraps them in mark decorations.
describe("Subscript (~x~) and superscript (^x^)", () => {
  it("wraps a single-tilde subscript in cm-pn-sub", () => {
    const view = mount("H~2~O");
    expect(doc(view)).toBe("H~2~O");
    const marks = [...view.dom.querySelectorAll(".cm-pn-sub")];
    expect(marks.map((m) => m.textContent)).toEqual(["2"]);
  });
  it("does NOT shade strikethrough (~~) as subscript", () => {
    const view = mount("~~deleted~~");
    expect(view.dom.querySelector(".cm-pn-sub")).toBeNull();
  });
  it("wraps a single-caret superscript in cm-pn-sup", () => {
    const view = mount("x^2^");
    expect(doc(view)).toBe("x^2^");
    const marks = [...view.dom.querySelectorAll(".cm-pn-sup")];
    expect(marks.map((m) => m.textContent)).toEqual(["2"]);
  });
  it("does not shade sub/sup inside inline code", () => {
    const view = mount("`H~2~O` and `x^2^`");
    expect(view.dom.querySelector(".cm-pn-sub")).toBeNull();
    expect(view.dom.querySelector(".cm-pn-sup")).toBeNull();
  });
});

// Fence hiding: opening and closing ``` lines get the cm-pn-fence-hidden class when the cursor is outside the block.
describe("Code-fence hiding", () => {
  const fenceLineHas = (view: EditorView, predicate: (line: Element) => boolean) =>
    [...view.dom.querySelectorAll(".cm-line")].some(predicate);

  it("hides the opening and closing fence lines when the cursor is after the block", () => {
    const view = mount("```\nx\n```"); // doc length 9; the cursor goes to 9 by default (end of doc)
    expect(fenceLineHas(view, (l) => l.classList.contains("cm-pn-fence-hidden"))).toBe(true);
  });
  it("does not hide fences when the cursor is inside the block", () => {
    const view = mount("```\nx\n```");
    view.dispatch({ selection: { anchor: 5 } }); // inside the block (the body line)
    expect(view.dom.querySelector(".cm-pn-fence-hidden")).toBeNull();
  });
  it("hides both fences of a 4-backtick block too", () => {
    const view = mount("````\nx\n````");
    const hidden = [...view.dom.querySelectorAll(".cm-line")].filter((l) => l.classList.contains("cm-pn-fence-hidden"));
    expect(hidden.length).toBe(2);
    // Atomic strips the fence text from the DOM, so we just check the classes (line 1 has both cm-pn-fence-hidden + cm-atomic-fenced-code).
    expect(hidden.every((l) => l.classList.contains("cm-atomic-fenced-code"))).toBe(true);
  });
});

// Tables: Atomic parses the table node; our toolbar extension writes valid GFM back, and the alignment (`:--`/`:-:`/`--:`) survives a re-parse.
describe("Table source preserves alignment on re-parse", () => {
  it("keeps the centering marker (:---:) after a no-op keystroke", () => {
    const view = mount("| a | b |\n| :--- | :---: |\n| 1 | 2 |");
    expect(doc(view)).toContain("| :--- | :---: |");
    type(view, "");
    expect(doc(view)).toContain(":---:"); // centering preserved
  });
  it("the right-aligned delimiter (---:) survives a no-op keystroke", () => {
    const view = mount("| a | b |\n| --- | ---: |\n| 1 | 2 |");
    expect(doc(view)).toContain("| --- | ---: |");
    type(view, "");
    expect(doc(view)).toContain("---:");
  });
  it("puts the alignment back when Atomic rewrites the table with a flat `---` delimiter row (cell edit)", () => {
    const src = "| a | b |\n| :--- | ---: |\n| 1 | 2 |";
    const view = mount(src);
    view.dispatch({ changes: { from: 0, to: src.length, insert: "| a | b |\n| --- | --- |\n| 1Z | 2 |" } });
    expect(doc(view)).toBe("| a | b |\n| :--- | ---: |\n| 1Z | 2 |");
  });
  it("toolbar width/alignment changes are not reverted by the alignment keeper (Breite − back to `---`)", () => {
    const view = mount("| a | b |\n| ----- | ----- |\n| 1 | 2 |");
    view.dispatch({ selection: { anchor: 2 } });
    const bar = view.dom.parentElement!.querySelector<HTMLElement>(".cm-pn-table-toolbar")!;
    bar.querySelector<HTMLElement>('button[title="Spaltenbreite verkleinern"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(doc(view)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
  it("does not invent alignment when the column count changed", () => {
    const src = "| a | b |\n| :--- | ---: |\n| 1 | 2 |";
    const view = mount(src);
    view.dispatch({ changes: { from: 0, to: src.length, insert: "| a |\n| --- |\n| 1 |" } });
    expect(doc(view)).toBe("| a |\n| --- |\n| 1 |");
  });
  it("mirrors the delimiter alignment onto the rendered cells", async () => {
    const view = mount("| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
    await new Promise((r) => setTimeout(r, 50)); // the MutationObserver applies it after the widget DOM lands
    const cells = [...view.dom.querySelectorAll<HTMLElement>(".cm-atomic-table tbody td")];
    expect(cells.map((c) => c.style.textAlign)).toEqual(["left", "center", "right"]);
    expect(cells[1]!.classList.contains("cm-pn-align-center")).toBe(true);
  });
});

describe("Ordered list nesting", () => {
  it("Tab nests an ordered item by the marker width and restarts at 1; Enter twice leaves level by level", () => {
    const view = mount();
    type(view, "1. a");
    press(view, "Enter");
    type(view, "b");
    press(view, "Enter");
    press(view, "Tab");
    expect(doc(view)).toBe("1. a\n2. b\n   1. ");
    type(view, "c");
    let lists = 0;
    syntaxTree(view.state).iterate({ enter: (n) => void (n.name === "OrderedList" && lists++) });
    expect(lists).toBe(2); // really nested, not a sibling with a 2-space indent
    press(view, "Enter");
    expect(doc(view)).toBe("1. a\n2. b\n   1. c\n   2. ");
    press(view, "Enter"); // empty nested marker: one level out, no leftover indent
    expect(doc(view)).toBe("1. a\n2. b\n   1. c\n2. ");
    press(view, "Enter"); // empty top-level marker: cleared with a blank separator
    expect(doc(view)).toBe("1. a\n2. b\n   1. c\n\n");
  });
  it("Shift-Tab outdents an ordered item by the marker width", () => {
    const view = mount("1. a\n   1. b");
    press(view, "Tab", true);
    expect(doc(view)).toBe("1. a\n1. b");
  });
});

describe("Task list typing", () => {
  it.each([
    ["- [", "- [ ] "],
    ["- [ ", "- [ ] "],
    ["- [ ]", "- [ ] "],
    ["- [x]", "- [x] "],
    ["- [X]", "- [x] "],
    ["- [ ] a", "- [ ] a"],
    ["1. [x] a", "1. [x] a"],
  ])("typing %j gives %j and a TaskList node", (typed, expected) => {
    const view = mount();
    type(view, typed);
    expect(doc(view)).toBe(expected);
    expect(hasNode(view, "TaskMarker")).toBe(true);
  });
  it("a link at the start of a list item still types", () => {
    const view = mount();
    type(view, "- [a](u)");
    expect(doc(view)).toBe("- [a](u)");
    expect(hasNode(view, "TaskMarker")).toBe(false);
  });
  it("`[` mid-line or inside a code fence stays untouched", () => {
    const view = mount();
    type(view, "a - [");
    expect(doc(view)).not.toContain("[ ]");
    const fenced = mount("```\n- ");
    type(fenced, "[");
    expect(doc(fenced)).not.toContain("[ ]");
  });
});

describe("HTML <sub>/<sup>", () => {
  it("hides the tags and marks the content while the cursor is elsewhere", () => {
    const view = mount("H<sub>2</sub>O x<sup>2</sup>\nende");
    expect(view.dom.querySelector(".cm-pn-sub")?.textContent).toBe("2");
    expect(view.dom.querySelector(".cm-pn-sup")?.textContent).toBe("2");
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("H2O x2");
    expect(doc(view)).toBe("H<sub>2</sub>O x<sup>2</sup>\nende");
  });
});

describe("Fence typing", () => {
  it("growing the opening fence to 4 backticks grows Atomic's auto-closed fence too", () => {
    const view = mount();
    type(view, "````");
    expect(doc(view)).toBe("````\n````");
    expect(hasNode(view, "FencedCode")).toBe(true);
  });
});

describe("Pending-link file chip", () => {
  const link = "[a.pdf](pending:abc-1)";
  const chips = (src: string) => mount(src).dom.querySelectorAll(".cm-pn-file-chip").length;
  it("replaces a plain pending link with a chip", () => {
    expect(chips(`vor ${link}`)).toBe(1);
  });
  it("leaves the link as text inside fenced, indented and inline code", () => {
    expect(chips("```\n" + link + "\n```")).toBe(0);
    expect(chips("text\n\n    " + link)).toBe(0);
    expect(chips("a `" + link + "` b")).toBe(0);
  });
});

// Cycle-3 review fixes: ArrowDown out of a fence only moves the cursor; paste intercepts only pure file clipboards; table buttons act on the cursor's row/column.
describe("Fence ArrowDown exit moves the cursor only", () => {
  const arrowDown = (view: EditorView) => view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  it.each([
    ["closing fence", "```\nx\n```\nende", 8],
    ["body line", "```\nx\n```\nende", 4],
    ["closing fence of a 4-backtick block", "````\nx\n````\nende", 10],
  ])("%s -> cursor lands on the line after the block, text unchanged", (_name, src, at) => {
    const view = mount(src);
    view.dispatch({ selection: { anchor: at } });
    arrowDown(view);
    expect(doc(view)).toBe(src);
    expect(view.state.selection.main.head).toBe(src.indexOf("ende"));
  });
  it("a fence that ends the document still gets one line to step into", () => {
    const view = mount("```\nx\n```");
    view.dispatch({ selection: { anchor: 5 } });
    arrowDown(view);
    expect(doc(view)).toBe("```\nx\n```\n");
    expect(view.state.selection.main.head).toBe(10);
  });
});

describe("Paste intercepts pure file clipboards only", () => {
  /** Pastes `data` + a PNG; true when our handler took the file (CM's own text paste also calls preventDefault, so that is no signal). */
  const takesFile = (view: EditorView, data: Record<string, string>) => {
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    const read = vi.fn(() => new Promise<ArrayBuffer>(() => {})); // jsdom's File has no arrayBuffer; never resolving keeps the stash out of this test
    Object.assign(png, { arrayBuffer: read });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: [png], getData: (t: string) => data[t] ?? "" } });
    view.contentDOM.dispatchEvent(ev);
    return read.mock.calls.length > 0;
  };
  it("image only -> attachment paste", () => {
    expect(takesFile(mount("x"), {})).toBe(true);
  });
  it("text/plain + image (Excel) -> the text is pasted, no attachment", () => {
    const view = mount("");
    expect(takesFile(view, { "text/plain": "A1\tB1" })).toBe(false);
    expect(doc(view)).toBe("A1\tB1");
  });
  it("text/html with text + image -> no attachment", () => {
    expect(takesFile(mount(""), { "text/html": "<b>Hallo</b>" })).toBe(false);
  });
  it("Finder copy (text/plain is the file name or path) and browser image copy (html is only <img>) stay attachments", () => {
    expect(takesFile(mount(""), { "text/plain": "shot.png" })).toBe(true);
    expect(takesFile(mount(""), { "text/plain": "/Users/x/Desktop/shot.png" })).toBe(true);
    expect(takesFile(mount(""), { "text/html": '<img src="https://x/y.png">' })).toBe(true);
  });
});

describe("Table toolbar acts on the cursor's row and column", () => {
  const SRC = "| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |";
  /** Cursor inside the cell at (source line, column) and a click on the button with that title. */
  const click = (title: string, line: number, col: number) => {
    const view = mount(SRC);
    const l = view.state.doc.line(line + 1);
    const pipes = [...l.text.matchAll(/\|/g)].map((m) => m.index!);
    view.dispatch({ selection: { anchor: l.from + pipes[col]! + 2 } });
    view.dom.parentElement!.querySelector<HTMLElement>(`.cm-pn-table-toolbar button[title="${title}"]`)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return doc(view);
  };
  it("⊕ Zeile inserts below the cursor row, not at the table end", () => {
    expect(click("Zeile unter der aktuellen einfügen", 3, 1)).toBe(
      "| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n|   |   |   |\n| 7 | 8 | 9 |");
  });
  it("⊕ Zeile on the header inserts below the delimiter", () => {
    expect(click("Zeile unter der aktuellen einfügen", 0, 1).split("\n")[2]).toBe("|   |   |   |");
  });
  it("⊖ Zeile removes the cursor row (middle row)", () => {
    expect(click("Aktuelle Zeile entfernen", 3, 1)).toBe("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n| 7 | 8 | 9 |");
  });
  it("⊖ Zeile on header or delimiter does nothing", () => {
    expect(click("Aktuelle Zeile entfernen", 0, 1)).toBe(SRC);
    expect(click("Aktuelle Zeile entfernen", 1, 1)).toBe(SRC);
  });
  it("⊕ Spalte inserts after the cursor column in every row; other alignments stay", () => {
    expect(click("Spalte rechts der aktuellen einfügen", 3, 1)).toBe(
      "| a | b | Spalte | c |\n| :--- | :---: | --- | ---: |\n| 1 | 2 |   | 3 |\n| 4 | 5 |   | 6 |\n| 7 | 8 |   | 9 |");
  });
  it("the caret stays in the edited row, in the new column (so a second click acts on it)", () => {
    const view = mount(SRC);
    const l = view.state.doc.line(4); // "| 4 | 5 | 6 |", cursor in the middle cell
    view.dispatch({ selection: { anchor: l.from + l.text.indexOf("5") } });
    view.dom.parentElement!.querySelector<HTMLElement>('button[title="Spalte rechts der aktuellen einfügen"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    expect(line.text).toBe("| 4 | 5 |   | 6 |");
    expect(head - line.from).toBe("| 4 | 5 | ".length);
  });
  it("⊖ Spalte removes the cursor column (middle) from every row", () => {
    expect(click("Aktuelle Spalte entfernen", 3, 1)).toBe("| a | c |\n| :--- | ---: |\n| 1 | 3 |\n| 4 | 6 |\n| 7 | 9 |");
  });
});

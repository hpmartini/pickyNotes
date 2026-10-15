// Real Atomic Editor / CodeMirror (no mocks): proves lists behave in the editor we ship, not in a textarea stand-in.
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { syntaxTree } from "@codemirror/language";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

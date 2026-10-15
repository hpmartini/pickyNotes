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
  it("unknown shortcodes keep the source and render the literal text", () => {
    const view = mount(":nonsense:");
    expect(doc(view)).toBe(":nonsense:");
    const widget = view.dom.querySelector(".cm-pn-emoji");
    expect(widget).not.toBeNull();
    expect(widget!.textContent).toBe(":nonsense:");
  });
  it("multiple shortcodes on one line render independently", () => {
    const view = mount(":joy: and :rocket:");
    const widgets = [...view.dom.querySelectorAll(".cm-pn-emoji")];
    expect(widgets.map((w) => w.textContent)).toEqual(["😂", "🚀"]);
  });
});

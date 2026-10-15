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
const press = (view: EditorView, key: string, shiftKey = false) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }), "editor");
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

  it("Enter on an empty item ends the list", () => {
    const view = mount();
    type(view, "- a");
    press(view, "Enter");
    press(view, "Enter");
    expect(doc(view)).not.toMatch(/^- $/m);
    expect(doc(view).startsWith("- a")).toBe(true);
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

  it("Enter on an empty quote line leaves the quote", () => {
    const view = mount();
    type(view, "> zitat");
    press(view, "Enter");
    expect(doc(view)).toBe("> zitat\n> ");
    press(view, "Enter");
    expect(doc(view)).toBe("> zitat\n");
    type(view, "danach");
    expect(hasNode(view, "Blockquote")).toBe(true);
    expect(syntaxTree(view.state).resolveInner(view.state.doc.length, -1).name).not.toBe("QuoteMark");
    expect(view.state.doc.line(2).text).toBe("danach");
  });

  it.each([
    ["- a\n- ", "- a\n"],
    ["1. a\n2. ", "1. a\n"],
    ["- [ ] a\n- [ ] ", "- [ ] a\n"],
    ["- a\n  - ", "- a\n"],
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

// Real Atomic Editor / CodeMirror (no mocks): proves lists behave in the editor we ship, not in a textarea stand-in.
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function mount(markdownSource = "") {
  const { container } = render(<AtomicCodeMirrorEditor markdownSource={markdownSource} />);
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

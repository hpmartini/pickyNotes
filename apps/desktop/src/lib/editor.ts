import { highlightMarkdown } from "@atomic-editor/editor";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

// shortcut: duplicates Atomic Editor's internal markdown({base: markdownLanguage, extensions: [highlightMarkdown]}) to add {remove: ["SetextHeading"]}; Prec.high wins over the built-in language facet; drop once Atomic Editor accepts lezer extensions.
const parser = markdown({ base: markdownLanguage, extensions: [highlightMarkdown, { remove: ["SetextHeading"] }] }).language;

/** True when `pos` sits inside a `name` node that is not itself inside code (a "- " in a fence is literal text). */
function inside(state: EditorState, pos: number, name: string): boolean {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return false;
    if (n.name === name) return true;
  }
  return false;
}

/** Replaces the cursor's whole line with "" when it matches `marker` (cursor at its end) and sits inside `node`. */
const clearEmptyMarker = (marker: RegExp, node: string) => (view: EditorView): boolean => {
  const { state } = view;
  const { head, empty } = state.selection.main;
  const line = state.doc.lineAt(head);
  if (!empty || head !== line.to || !marker.test(line.text) || !inside(state, head, node)) return false;
  view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, userEvent: "delete" });
  return true;
};

// Obsidian/Notion parity, kept out of node_modules: typed "*" / "_" stay as typed. Atomic's auto-close + extendEmphasisPair
// turn "**fett**" into "**fett******" because the closing "**" is re-extended instead of stepped over.
// A selection still gets wrapped by closeBrackets (return false).
const plainEmphasisChars = EditorView.inputHandler.of((view, from, to, text) => {
  if ((text !== "*" && text !== "_") || from !== to) return false;
  view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  return true;
});

const leaveEmptyItemOrQuote = keymap.of([
  // Enter on an empty "> " line leaves the quote (markdown's default adds another ">" line).
  { key: "Enter", run: clearEmptyMarker(/^\s*(>\s*)+$/, "Blockquote") },
  // Backspace on an empty bullet/number/task marker drops the whole marker (markdown's default leaves indent spaces that nest the next list).
  { key: "Backspace", run: clearEmptyMarker(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?$/, "ListItem") },
]);

export const editorExtensions = [Prec.high(parser), Prec.highest(plainEmphasisChars), Prec.highest(leaveEmptyItemOrQuote)];

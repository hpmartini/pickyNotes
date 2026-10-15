import { highlightMarkdown } from "@atomic-editor/editor";
import { indentLess } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Prec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, MatchDecorator, ViewPlugin, WidgetType } from "@codemirror/view";

// shortcut: duplicates Atomic Editor's internal markdown({base: markdownLanguage, extensions: [highlightMarkdown]}) to add {remove: ["SetextHeading"]}; Prec.high wins over the built-in language facet; drop once Atomic Editor accepts lezer extensions.
const parser = markdown({ base: markdownLanguage, extensions: [highlightMarkdown, { remove: ["SetextHeading"] }] }).language;

/** True when `pos` sits inside a `name` node (any node when omitted) that is not itself inside code (a "- " in a fence is literal text). */
function inside(state: EditorState, pos: number, name?: string): boolean {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return false;
    if (n.name === name) return true;
  }
  return !name;
}

/** Replaces the cursor's whole line with "" when it matches `marker` (cursor at its end) and sits inside `node`. */
const clearEmptyMarker = (marker: RegExp, node?: string) => (view: EditorView): boolean => {
  const { state } = view;
  const { head, empty } = state.selection.main;
  const line = state.doc.lineAt(head);
  if (!empty || head !== line.to || !marker.test(line.text) || !inside(state, head, node)) return false;
  view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, userEvent: "delete" });
  return true;
};

// Matches an empty list marker at end of cursor line; group 1 is the leading indent so the caller can outdent nested cases.
const emptyListMarker = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?$/;
const emptyQuoteMarker = /^(\s*)(>\s*)+$/;

// shortcut: must beat Atomic's Prec.highest `insertTightListItem` (inline-preview.js:1009) which clears empty top-level bullets without inserting a blank line, causing the next typed text to lazy-continue the previous item; also beats markdown's `insertNewlineContinueMarkup` for empty numbered markers (no exit path at all) and for empty `> ` (adds another `>` line). Runs as a keydown handler so it fires before the keymap dispatcher's Prec.default path; remove once Atomic accepts an Enter escape hatch.
const leaveEmptyMarker = (view: EditorView): boolean => {
  const { state } = view;
  const { head, empty } = state.selection.main;
  if (!empty) return false;
  const line = state.doc.lineAt(head);
  if (head !== line.to) return false;
  const listMatch = line.text.match(emptyListMarker);
  const quoteMatch = line.text.match(emptyQuoteMarker);
  const inList = !!listMatch && inside(state, head, "ListItem");
  const inQuote = !!quoteMatch && inside(state, head, "Blockquote");
  if (!inList && !inQuote) return false;
  // Indented list marker: outdent one level (Shift+Tab equivalent) and keep going; the next Enter on the resulting top-level empty marker clears it with a blank separator below.
  if (inList && listMatch![1]) return indentLess(view);
  // Top level (or any quote): replace the marker line so the cursor lands on a fresh empty line after a blank separator, which stops the next typed text from lazy-continuing the previous item/quote.
  const prev = line.from > 0 ? state.doc.lineAt(line.from - 1) : null;
  const needsBlank = prev ? /\S/.test(prev.text) : false;
  const insert = needsBlank ? state.lineBreak : "";
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length },
    userEvent: "delete",
  });
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
  // Backspace on an empty bullet/number/task marker drops the whole marker, also directly under a paragraph where Lezer sees no ListItem (markdown's default leaves indent spaces that nest the next list).
  { key: "Backspace", run: clearEmptyMarker(emptyListMarker) },
]);

// Enter on an empty list/quote marker is handled by a Prec.highest keydown listener above; plain Enter (continuation) is left to Atomic + markdown.
const enterLeavesEmptyMarker = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
    if (!leaveEmptyMarker(view)) return false;
    event.preventDefault();
    return true;
  },
});

// shortcut: GFM (the parser base) does not tokenise `:shortcode:`; render the few common ones Obsidian/Notion show so the source stays editable. Drop when lezer-markdown gains an emoji node.
const EMOJI: Record<string, string> = {
  ":joy:": "😂",
  ":smile:": "😄",
  ":grin:": "😀",
  ":laughing:": "😆",
  ":wink:": "😉",
  ":heart:": "❤",
  ":rocket:": "🚀",
  ":fire:": "🔥",
  ":tada:": "🎉",
  ":thumbsup:": "👍",
  ":thumbsdown:": "👎",
  ":star:": "⭐",
  ":check:": "✅",
  ":x:": "❌",
  ":warning:": "⚠",
  ":bulb:": "💡",
  ":memo:": "📝",
  ":calendar:": "📅",
  ":link:": "🔗",
  ":lock:": "🔒",
  ":key:": "🔑",
};
const EMOJI_RE = /:[a-zA-Z]+:/g;

class EmojiWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pn-emoji";
    span.textContent = EMOJI[this.text] ?? this.text;
    return span;
  }
  ignoreEvent() { return true; }
  eq(other: EmojiWidget) { return other.text === this.text; }
}

const emojiDecorator = new MatchDecorator({
  regexp: EMOJI_RE,
  decoration: (m) => Decoration.replace({ widget: new EmojiWidget(m[0]) }),
});

const emojiPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = emojiDecorator.createDeco(view);
    }
    update(update: { docChanged: boolean; viewportChanged: boolean; changes: unknown; state: EditorState }) {
      this.decorations = emojiDecorator.updateDeco(update as never, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

export const editorExtensions = [
  Prec.high(parser),
  Prec.highest(plainEmphasisChars),
  Prec.highest(enterLeavesEmptyMarker),
  Prec.highest(leaveEmptyItemOrQuote),
  emojiPlugin,
];

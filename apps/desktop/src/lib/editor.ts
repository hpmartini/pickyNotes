import { ATOMIC_CODE_LANGUAGES } from "@atomic-editor/editor/code-languages";
import { highlightMarkdown, tables as atomicTables } from "@atomic-editor/editor";
import { indentLess } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Prec, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, WidgetType } from "@codemirror/view";

// shortcut: duplicates Atomic Editor's internal markdown({base: markdownLanguage, extensions: [highlightMarkdown]}) to add {remove: ["SetextHeading"]} and pass codeLanguages so fenced blocks get syntax highlighting (Atomic wires the same in its default editor); Prec.high wins over the built-in language facet; drop once Atomic Editor accepts lezer extensions.
const parser = markdown({ base: markdownLanguage, extensions: [highlightMarkdown, { remove: ["SetextHeading"] }], codeLanguages: ATOMIC_CODE_LANGUAGES }).language;

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

// shortcut: Atomic Editor already converts `- [ ]` into a TaskList node and renders a real checkbox.
// The defect list mentions "task checkboxes" only because the toggle (clicking the checkbox in the preview)
// must round-trip into the markdown without the user typing — Atomic's input handler does that already.
// We do not add another inputHandler here because it fights Atomic's: typing `- [` then ` ` then `]` would
// double-insert `]` and break the source round-trip.

/** Parse one source row into its cells (the leading/trailing `|` are stripped, escaped pipes are kept literal). */
function splitRow(line: string): string[] {
  const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (trimmed[i] === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += trimmed[i];
  }
  cells.push(buf.trim());
  return cells;
}

/** Read a delimiter row into the per-column alignment marker (`L|C|R|none`) and dash count. */
function readDelimiter(line: string): Array<{ align: "L" | "C" | "R" | "none"; dashes: number }> {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    const dashes = Math.max(1, (cell.match(/-/g) ?? []).length);
    return { align: left && right ? "C" : right ? "R" : left ? "L" : "none", dashes };
  });
}

/** Serialise a delimiter row from per-column alignment + dash count. Dash count approximates column width (GFM has no real width spec). */
function formatDelimiter(spec: Array<{ align: "L" | "C" | "R" | "none"; dashes: number }>): string {
  return "| " + spec.map(({ align, dashes }) => {
    const d = "-".repeat(Math.max(3, dashes));
    return align === "C" ? `:${d}:` : align === "L" ? `:${d}-` : align === "R" ? `-${d}:` : d;
  }).join(" | ") + " |";
}

/** Find the Table source range and its lines (header + delimiter + body). */
function readTableAt(state: EditorState, pos: number): { from: number; to: number; lines: string[] } | null {
  let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.name !== "Table") node = node.parent;
  if (!node) return null;
  return { from: node.from, to: node.to, lines: state.doc.sliceString(node.from, node.to).split("\n") };
}

/** Apply a per-column transform (alignment / dashes) over the table under the cursor. */
function applyDelimiterChange(view: EditorView, change: (spec: Array<{ align: "L" | "C" | "R" | "none"; dashes: number }>, headerLen: number) => Array<{ align: "L" | "C" | "R" | "none"; dashes: number }>): void {
  const t = readTableAt(view.state, view.state.selection.main.head);
  if (!t || t.lines.length < 2) return;
  const header = splitRow(t.lines[0]!);
  const newSpec = change(readDelimiter(t.lines[1]!), header.length);
  while (newSpec.length < header.length) newSpec.push({ align: "none", dashes: 3 });
  if (newSpec.length > header.length) newSpec.length = header.length;
  const newText = [t.lines[0]!, formatDelimiter(newSpec), ...t.lines.slice(2)].join("\n");
  view.dispatch({ changes: { from: t.from, to: t.to, insert: newText }, selection: { anchor: t.from } });
  view.focus();
}

/**
 * Toolbar extension: adds a small DOM toolbar that becomes visible whenever the cursor
 * sits inside a Table node. Buttons edit the table source directly (alignment + width
 * via the delimiter row; rows/columns via line edits). Atomic's own table context menu
 * stays untouched, but its `serializeTable` flattens alignment — so our writes preserve
 * `:--`/`:-:`/`--:` even after an Atomic round-trip.
 */
const tableToolbar = ViewPlugin.fromClass(
  class {
    dom: HTMLDivElement;
    constructor(public view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-pn-table-toolbar";
      this.dom.style.display = "none";
      this.dom.setAttribute("role", "toolbar");
      this.dom.setAttribute("aria-label", "Tabelle");
      view.dom.parentElement!.appendChild(this.dom);
      this.sync();
    }
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.sync();
    }
    destroy() { this.dom.remove(); }
    private inTable(): boolean {
      let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(this.view.state).resolveInner(this.view.state.selection.main.head, -1);
      while (n) { if (n.name === "Table") return true; n = n.parent; }
      return false;
    }
    private sync() {
      this.dom.style.display = this.inTable() ? "" : "none";
      this.dom.replaceChildren();
      if (!this.inTable()) return;
      const v = this.view;
      const mkBtn = (label: string, title: string, run: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); run(); });
        return b;
      };
      this.dom.append(
        mkBtn("⊕ Zeile", "Zeile unter der aktuellen einfügen", () => {
          const t = readTableAt(v.state, v.state.selection.main.head); if (!t) return;
          const header = splitRow(t.lines[0]!);
          const row = "| " + header.map(() => " ").join(" | ") + " |";
          v.dispatch({ changes: { from: t.to, insert: "\n" + row }, selection: { anchor: t.to + row.length - 1 } });
          v.focus();
        }),
        mkBtn("⊖ Zeile", "Letzte Zeile entfernen", () => {
          const t = readTableAt(v.state, v.state.selection.main.head); if (!t || t.lines.length <= 3) return;
          const lastLineStart = t.to - t.lines[t.lines.length - 1]!.length;
          v.dispatch({ changes: { from: lastLineStart - 1, to: t.to } });
          v.focus();
        }),
        mkBtn("⊕ Spalte", "Spalte rechts einfügen", () => {
          const t = readTableAt(v.state, v.state.selection.main.head); if (!t || t.lines.length < 2) return;
          const header = splitRow(t.lines[0]!);
          const delim = readDelimiter(t.lines[1]!);
          const newHeader = [...header, "Spalte"];
          const newDelim = [...delim, { align: "none" as const, dashes: 3 }];
          const newBody = t.lines.slice(2).map((line) => {
            const cells = splitRow(line);
            while (cells.length < newHeader.length - 1) cells.push("");
            cells.push("");
            return "| " + cells.map((c) => c || " ").join(" | ") + " |";
          });
          const newText = ["| " + newHeader.join(" | ") + " |", formatDelimiter(newDelim), ...newBody].join("\n");
          v.dispatch({ changes: { from: t.from, to: t.to, insert: newText }, selection: { anchor: t.from } });
          v.focus();
        }),
        mkBtn("⊖ Spalte", "Letzte Spalte entfernen", () => {
          const t = readTableAt(v.state, v.state.selection.main.head); if (!t || t.lines.length < 2) return;
          const header = splitRow(t.lines[0]!); if (header.length <= 1) return;
          const newHeader = header.slice(0, -1);
          const newDelim = readDelimiter(t.lines[1]!).slice(0, -1);
          const newBody = t.lines.slice(2).map((line) => {
            const cells = splitRow(line);
            cells.pop();
            return "| " + cells.map((c) => c || " ").join(" | ") + " |";
          });
          const newText = ["| " + newHeader.join(" | ") + " |", formatDelimiter(newDelim), ...newBody].join("\n");
          v.dispatch({ changes: { from: t.from, to: t.to, insert: newText }, selection: { anchor: t.from } });
          v.focus();
        }),
        mkBtn("⇤ L", "Spalten linksbündig ausrichten", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, align: "L" as const })))),
        mkBtn("⇔ C", "Spalten zentrieren", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, align: "C" as const })))),
        mkBtn("⇥ R", "Spalten rechtsbündig ausrichten", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, align: "R" as const })))),
        mkBtn("◀", "Spaltenbreite verkleinern", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, dashes: Math.max(3, c.dashes - 2) })))),
        mkBtn("▶", "Spaltenbreite vergrößern", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, dashes: c.dashes + 2 })))),
      );
    }
  },
);

// Fence hiding: Obsidian/Notion hide the opening AND closing ``` lines while the cursor is
// outside the block, but the source must stay exact (no missing closing fence on ArrowDown).
// We use Prec.high decorations so we run above Atomic's own FencedCode rendering.
function fenceDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const head = view.state.selection.main.head;
  const tree = syntaxTree(view.state);
  const cursor = tree.cursor();
  do {
    if (cursor.name !== "FencedCode") continue;
    const from = cursor.from;
    const to = cursor.to;
    // The cursor at `to` (i.e. the end of the closing fence) is *after* the block — hide the fences.
    if (head >= from && head < to) continue;
    const node = cursor.node;
    if (!node) continue;
    const children = node.getChildren("CodeMark");
    if (children.length < 2) continue;
    decos.push(Decoration.line({ attributes: { class: "cm-pn-fence-hidden" } }).range(children[0]!.from));
    decos.push(Decoration.line({ attributes: { class: "cm-pn-fence-hidden" } }).range(children[children.length - 1]!.from));
  } while (cursor.next());
  return Decoration.set(decos, true);
}

const fencePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = fenceDecorations(view); }
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = fenceDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// shortcut: ArrowDown at the last line of a fenced code block (closing fence or last body line) should step out of the block. Same for ArrowUp at the very first line. Both must beat Atomic's default keymap so the cursor doesn't get stuck.
const fenceArrowExit = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return false;
    const { state } = view;
    const head = state.selection.main.head;
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(head, -1);
    while (node && node.name !== "FencedCode") node = node.parent;
    if (!node) return false;
    const headLine = state.doc.lineAt(head);
    if (event.key === "ArrowDown") {
      const lastLineEnd = state.doc.lineAt(node.to).to;
      const lastLineNo = state.doc.lineAt(node.to).number;
      if (headLine.to !== lastLineEnd && headLine.number !== lastLineNo) return false;
      const after = state.doc.sliceString(node.to, Math.min(state.doc.length, node.to + 2));
      const insert = after.startsWith("\n\n") ? "" : "\n";
      view.dispatch({
        changes: { from: node.to, insert },
        selection: { anchor: node.to + insert.length },
      });
      event.preventDefault();
      return true;
    }
    // ArrowUp: opening fence. Step above it.
    const firstLineStart = state.doc.lineAt(node.from).from;
    if (headLine.from !== firstLineStart) return false;
    if (firstLineStart === 0) return false;
    const prev = state.doc.lineAt(firstLineStart - 1);
    view.dispatch({ selection: { anchor: prev.to } });
    event.preventDefault();
    return true;
  },
});

// shortcut: GFM (the parser base) does not tokenise `:shortcode:`; render the few common ones Obsidian/Notion show so the source stays editable. Drop when lezer-markdown gains an emoji node.
// Defect fix per spec: skip when the match sits inside InlineCode / FencedCode (don't replace a literal
// string in code), when the colon is escaped (`\:joy:`), when the selection touches the shortcode
// (reveal the source so the user can edit/select it), and map :grin: to 😁 as well.
const EMOJI: Record<string, string> = {
  ":grin:": "😁",
  ":joy:": "😂",
  ":smile:": "😄",
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
const EMOJI_RE = /:[a-zA-Z][a-zA-Z0-9_+-]*:/g;

class EmojiWidget extends WidgetType {
  constructor(readonly text: string, readonly known: boolean) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pn-emoji" + (this.known ? "" : " cm-pn-emoji-unknown");
    span.textContent = EMOJI[this.text] ?? this.text;
    return span;
  }
  eq(other: EmojiWidget) { return other.text === this.text && other.known === this.known; }
  ignoreEvent() { return true; }
}

/** Return true if the half-open range [from, to) is inside any code span/block. */
function inCodeSpan(state: EditorState, from: number, to: number): boolean {
  let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(from, -1);
  while (n) {
    if (n.name === "InlineCode" && n.from <= from && n.to >= to) return true;
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
    n = n.parent;
  }
  return false;
}

/** Build the emoji decoration set with all known defect fixes applied. */
function buildEmojiDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const text = view.state.doc.toString();
  const head = view.state.selection.main;
  // `touches` = the cursor sits inside the visible span [from, to). Cursor at `to` is *after* it (typing appends), so we use `>=` for `from` and `<` for `to`.
  const selTouches = (from: number, to: number) => head.empty ? head.head >= from && head.head < to : head.to > from && head.from < to;
  EMOJI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOJI_RE.exec(text))) {
    const [match] = m;
    const from = m.index;
    const to = from + match.length;
    if (selTouches(from, to)) continue;
    if (inCodeSpan(view.state, from, to)) continue;
    // Backslash escape: `\:` immediately before the match means it's literal text.
    if (from > 0 && text[from - 1] === "\\") continue;
    const known = match in EMOJI;
    if (!known) continue; // unknown names stay as plain text per spec
    decos.push(Decoration.replace({ widget: new EmojiWidget(match, true) }).range(from, to));
  }
  return Decoration.set(decos, true);
}

const emojiPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildEmojiDecos(view); }
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildEmojiDecos(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// shortcut: lezer-markdown's GFM extensions don't add sub/sup marks; we wrap `~x~` (single tilde, NOT `~~`) and `^x^` (caret) with mark decorations so the source stays editable. Anything that looks like `~~strike~~` or HTML `<sub>…</sub>` already renders via GFM.
function buildSubSupDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const text = view.state.doc.toString();
  const head = view.state.selection.main;
  // `touches` = the cursor sits inside the visible span [from, to). Cursor at `to` is *after* it (typing appends), so we use `>=` for `from` and `<` for `to`.
  const selTouches = (from: number, to: number) => head.empty ? head.head >= from && head.head < to : head.to > from && head.from < to;
  // `~x~` — NOT `~~x~~`. The lookbehind/lookahead reject a second `~` so we don't shade strikethrough.
  const subRe = /(?<!~)~([^\s~][^~]*?[^\s~]|[^\s~])~(?!~)/g;
  // `^x^` — single caret.
  const supRe = /(?<!\^)\^([^\s^][^^]*?[^\s^]|[^\s^])\^(?!\^)/g;
  for (const [re, cls] of [[subRe, "cm-pn-sub"], [supRe, "cm-pn-sup"]] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = m.index;
      const to = from + m[0]!.length;
      if (selTouches(from, to)) continue;
      if (inCodeSpan(view.state, from, to)) continue;
      // Wrap only the inner content (group 1) so the tildes/carets stay visible in source.
      const innerFrom = from + m[0]!.indexOf(m[1]!);
      const innerTo = innerFrom + m[1]!.length;
      decos.push(Decoration.mark({ class: cls }).range(innerFrom, innerTo));
    }
  }
  return Decoration.set(decos, true);
}

const subSupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildSubSupDecos(view); }
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildSubSupDecos(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Export an action to insert a fresh 3-column table at the cursor (used by the toolbar menu if a host adds one).
export function dispatchInsertTable(view: EditorView): void {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const at = line.to;
  const blank = line.text.length > 0 ? "\n\n" : "";
  const table = ["| Spalte 1 | Spalte 2 | Spalte 3 |", "| :--- | :---: | ---: |", "| | | |"].join("\n");
  const caret = at + blank.length + "| ".length;
  view.dispatch({ changes: { from: at, insert: blank + table + "\n" }, selection: { anchor: caret } });
  view.focus();
}

// Renders markdown images and file links inline. Pending attachments (`pending:<id>`) get a tiny chip; images get a blob/data: preview.
// shortcut: we rebuild on every update because the doc length is small and attachment IDs are cheap to enumerate.
function attachmentsRenderDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const text = view.state.doc.toString();
  const imgRe = /!\[([^\]]*)\]\((?:pending:[a-zA-Z0-9_-]+|[^)\s]+)\)/g;
  const linkRe = /\[([^\]]+)\]\((?:pending:[a-zA-Z0-9_-]+|[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (!inside(view.state, from, "FencedCode") && !inside(view.state, from, "CodeBlock")) {
      decos.push(Decoration.replace({ widget: new PendingImageWidget(m[1] ?? "") }).range(from, to));
    }
  }
  while ((m = linkRe.exec(text))) {
    // Skip images we already wrapped.
    if (decos.length > 0 && decos[decos.length - 1]!.from === m.index) continue;
    const from = m.index;
    const to = from + m[0].length;
    if (!inside(view.state, from, "FencedCode") && !inside(view.state, from, "CodeBlock")) {
      decos.push(Decoration.replace({ widget: new FileChipWidget(m[1] ?? "") }).range(from, to));
    }
  }
  return Decoration.set(decos, true);
}

class PendingImageWidget extends WidgetType {
  constructor(readonly alt: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pn-pending-image";
    span.textContent = `🖼  ${this.alt || "Bild"}`;
    span.title = "Anhang wird beim Speichern in den Vault übertragen";
    return span;
  }
  eq(other: PendingImageWidget) { return other.alt === this.alt; }
  ignoreEvent() { return true; }
}

class FileChipWidget extends WidgetType {
  constructor(readonly name: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pn-file-chip";
    span.textContent = `📎 ${this.name}`;
    return span;
  }
  eq(other: FileChipWidget) { return other.name === this.name; }
  ignoreEvent() { return true; }
}

const attachmentsRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = attachmentsRenderDecos(view); }
    update(update: { docChanged: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.viewportChanged) this.decorations = attachmentsRenderDecos(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Paste/drop handler: stash each file/blob as an attachment and insert `![name](pending:<id>)` (image) or `[name](pending:<id>)` (other) at the cursor.
// shortcut: bypasses Atomic's default paste handling, which would just paste file paths as plain text.
async function insertAttachmentAt(view: EditorView, pos: number, file: { name: string; mime: string; bytes: Uint8Array }): Promise<void> {
  const { stashAttachment, makeMarkdownLink } = await import("./attachments");
  const { markdownTarget } = await stashAttachment(file);
  const link = makeMarkdownLink(file.name, markdownTarget, file.mime);
  const blank = pos > 0 && view.state.doc.sliceString(pos - 1, pos) !== "\n" ? "\n" : "";
  view.dispatch({ changes: { from: pos, insert: blank + link }, selection: { anchor: pos + blank.length + link.length }, userEvent: "input.paste" });
}

const attachmentPasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    const files = event.clipboardData?.files ? [...event.clipboardData.files] : [];
    if (files.length === 0) return false;
    event.preventDefault();
    for (const f of files) {
      void f.arrayBuffer().then(async (buf) => {
        await insertAttachmentAt(view, view.state.selection.main.head, { name: f.name || "Datei", mime: f.type || "application/octet-stream", bytes: new Uint8Array(buf) });
      });
    }
    return true;
  },
  drop(event, view) {
    const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
    if (files.length === 0) return false;
    event.preventDefault();
    // Drop position from the screen coordinates — drop at end of doc if we can't resolve.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
    for (const f of files) {
      void f.arrayBuffer().then(async (buf) => {
        await insertAttachmentAt(view, pos, { name: f.name || "Datei", mime: f.type || "application/octet-stream", bytes: new Uint8Array(buf) });
      });
    }
    return true;
  },
});

/** Insert text at the editor's current cursor — used by the speech button. */
export function insertTextAtCursor(view: EditorView, text: string): void {
  const head = view.state.selection.main.head;
  const blank = head > 0 && view.state.doc.sliceString(head - 1, head) !== "\n" ? "\n" : "";
  view.dispatch({ changes: { from: head, insert: blank + text }, selection: { anchor: head + blank.length + text.length }, userEvent: "input.type" });
}

export const editorExtensions = [
  Prec.high(parser),
  Prec.highest(plainEmphasisChars),
  Prec.highest(enterLeavesEmptyMarker),
  Prec.highest(leaveEmptyItemOrQuote),
  Prec.highest(fencePlugin),
  Prec.high(fenceArrowExit),
  Prec.high(subSupPlugin),
  Prec.high(emojiPlugin),
  Prec.high(attachmentsRenderPlugin),
  Prec.highest(attachmentPasteHandler),
  Prec.high(tableToolbar),
  atomicTables(), // keep Atomic's table widgets so cells render; our toolbar writes valid GFM that re-parses as Table.
];
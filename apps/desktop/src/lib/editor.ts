import { ATOMIC_CODE_LANGUAGES } from "@atomic-editor/editor/code-languages";
import { highlightMarkdown, tables as atomicTables } from "@atomic-editor/editor";
import { indentLess } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorState, Prec, Range, StateField } from "@codemirror/state";
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
  if (inList && listMatch![1]) return /^\s*\d/.test(line.text) ? orderedListIndent(-1)(view) : indentLess(view);
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

// Tab/Shift-Tab on an ordered item must move by the marker width ("1. " = 3 columns): Atomic's 2-space step leaves `  3. c` as a sibling, not a nested list.
// A first item at the new depth restarts at 1 (Obsidian/Notion); outdent keeps the number.
const orderedListIndent = (dir: 1 | -1) => (view: EditorView): boolean => {
  const { state } = view;
  const { head, empty } = state.selection.main;
  const line = state.doc.lineAt(head);
  const m = /^(\s*)(\d+)[.)]\s/.exec(line.text);
  if (!empty || !m || !inside(state, head, "ListItem")) return false;
  const width = m[2]!.length + 2;
  if (dir === -1) {
    if (!m[1]) return false;
    view.dispatch({ changes: { from: line.from, to: line.from + Math.min(m[1].length, width) }, userEvent: "delete.dedent" });
    return true;
  }
  const prev = line.number > 1 ? /^(\s*)(?:[-*+]|\d+[.)])\s/.exec(state.doc.line(line.number - 1).text) : null;
  const first = !prev || prev[1]!.length < m[1]!.length + width;
  const num = line.from + m[1]!.length;
  view.dispatch({ changes: [{ from: line.from, insert: " ".repeat(width) }, ...(first ? [{ from: num, to: num + m[2]!.length, insert: "1" }] : [])], userEvent: "input.indent" });
  return true;
};

const leaveEmptyItemOrQuote = keymap.of([
  { key: "Tab", run: orderedListIndent(1) },
  { key: "Shift-Tab", run: orderedListIndent(-1) },
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

// Typing a table by hand breaks in Atomic: the moment header + delimiter row parse as a Table its block widget swallows the cursor line and further keystrokes are lost.
// So Enter at the end of a pipe row (not already in a table) builds the skeleton (`| --- |` + one empty body row) and moves the caret into the first body cell, like Obsidian's table helpers.
const enterBuildsTable = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
    const { state } = view;
    const { head, empty } = state.selection.main;
    const line = state.doc.lineAt(head);
    if (!empty || head !== line.to || !/^\|.*\|\s*$/.test(line.text) || (line.number > 1 && state.doc.line(line.number - 1).text.trimStart().startsWith("|"))) return false;
    if (!inside(state, head) || readTableAt(state, head)) return false;
    const cols = splitRow(line.text).length;
    if (cols < 2) return false;
    const skeleton = `\n| ${Array(cols).fill("---").join(" | ")} |\n| ${Array(cols).fill("").join(" | ")} |`;
    view.dispatch({ changes: { from: line.to, insert: skeleton }, selection: { anchor: line.from }, userEvent: "input" });
    event.preventDefault();
    // The widget is built by the dispatch above; its first body cell takes the keyboard from here.
    setTimeout(() => {
      for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>(".cm-atomic-table")) {
        try { if (view.posAtDOM(wrap) !== line.from) continue; } catch { continue; }
        wrap.querySelector<HTMLElement>("tbody .cm-atomic-table-cell-source")?.focus();
      }
    }, 0);
    return true;
  },
});

// Task list typing: Atomic renders a checkbox (and toggles `[ ]`/`[x]` on click) only for `- [ ] `, but typing `- [` yields `- []`.
// Typing `[` right after a list marker therefore writes `[ ] ` at once; the characters of `[ ]`/`[x]` typed next are folded into it
// (x/X checks, space/`]` are swallowed) and any other character reverts to a plain `[` so `- [link](url)` still types.
// State: 0 off, 1 `[` just converted (accepts x / space / `]` / reverts on anything else), 2 after x or space (accepts `]`), 3 after `]` (swallows one trailing space).
const taskMarker = Annotation.define<number>();
const taskTyping = StateField.define<number>({
  create: () => 0,
  update: (v, tr) => tr.annotation(taskMarker) ?? (tr.docChanged || tr.selection ? 0 : v),
});
const taskListInput = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (from !== to) return false;
  const phase = state.field(taskTyping);
  if (phase && state.selection.main.head === from && /^\[[ xX]\] $/.test(state.doc.sliceString(from - 4, from))) {
    const step = (next: number, changes?: { from: number; to: number; insert: string }) =>
      view.dispatch({ ...(changes ? { changes } : {}), selection: { anchor: from }, annotations: taskMarker.of(next), userEvent: "input.type" });
    if (phase === 1 && (text === "x" || text === "X")) step(2, { from: from - 3, to: from - 2, insert: "x" });
    else if (phase === 1 && text === " ") step(2);
    else if ((phase === 1 || phase === 2) && text === "]") step(3);
    else if (phase === 3 && text === " ") step(0);
    else if (phase === 1) view.dispatch({ changes: { from: from - 4, to: from, insert: "[" + text }, selection: { anchor: from - 3 + text.length }, userEvent: "input.type" });
    else return false;
    return true;
  }
  const line = state.doc.lineAt(from);
  if (text !== "[" || state.doc.sliceString(from, line.to) !== "" || !/^\s*([-*+]|\d+[.)]) $/.test(state.doc.sliceString(line.from, from)) || !inside(state, from)) return false;
  view.dispatch({ changes: { from, insert: "[ ] " }, selection: { anchor: from + 4 }, annotations: taskMarker.of(1), userEvent: "input.type" });
  return true;
});

// Atomic auto-closes ``` with a 3-backtick fence; typing a 4th (5th…) backtick on the opening line must grow the closing fence too, else the block never closes.
const growFenceWithOpening = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (text !== "`" || from !== to) return false;
  const line = state.doc.lineAt(from);
  const m = state.doc.sliceString(line.from, from).match(/^(\s{0,3})(`{3,})$/);
  if (!m || from !== line.to || line.number === state.doc.lines) return false;
  const next = state.doc.line(line.number + 1);
  if (next.text !== m[1]! + m[2]!) return false;
  view.dispatch({ changes: [{ from, insert: "`" }, { from: next.to, insert: "`" }], selection: { anchor: from + 1 }, userEvent: "input.type" });
  return true;
});

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
    return align === "C" ? `:${d}:` : align === "L" ? `:${d}` : align === "R" ? `${d}:` : d;
  }).join(" | ") + " |";
}

/** Find the Table source range and its lines (header + delimiter + body). */
function readTableAt(state: EditorState, pos: number): { from: number; to: number; lines: string[] } | null {
  // A cursor at the table's very start or end belongs to it too: look to both sides.
  for (const side of [-1, 1] as const) {
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, side);
    while (node && node.name !== "Table") node = node.parent;
    if (node) return { from: node.from, to: node.to, lines: state.doc.sliceString(node.from, node.to).split("\n") };
  }
  return null;
}

/** Position inside the table being edited: the focused Atomic cell widget (focus lives in its contenteditable, not in the CM selection) or else the cursor. */
function tablePos(view: EditorView): number {
  const wrap = document.activeElement?.closest?.(".cm-atomic-table");
  if (wrap && view.contentDOM.contains(wrap)) {
    try { return view.posAtDOM(wrap) + 1; } catch { /* widget detached mid-update: fall back to the cursor */ }
  }
  return view.state.selection.main.head;
}

const isDelimiterRow = (s: string | undefined): s is string => !!s && /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/.test(s);

// Atomic's serializeTable rewrites every delimiter row to `| --- | --- |` on a cell edit; put the old row (alignment + width) back when the column count is unchanged.
const ownTableEdit = Annotation.define<boolean>(); // toolbar writes (e.g. "Breite −" back to `---`) must not be mistaken for Atomic's flattening
const keepTableAlignment = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(ownTableEdit)) return tr;
  const fixes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    const before = tr.startState.doc.sliceString(fromA, toA).split("\n");
    const after = tr.newDoc.sliceString(fromB, toB).split("\n");
    if (before.length < 2 || after.length < 2 || !isDelimiterRow(before[1]) || !isDelimiterRow(after[1]) || before[1] === after[1]) return;
    if (!/^\|( --- \|)+$/.test(after[1]) || splitRow(before[1]).length !== splitRow(after[1]).length) return;
    const at = fromB + after[0]!.length + 1;
    fixes.push({ from: at, to: at + after[1].length, insert: before[1] });
  });
  return fixes.length ? [tr, { changes: fixes, sequential: true }] : tr;
});

const ALIGN_CLASSES = { L: "cm-pn-align-left", C: "cm-pn-align-center", R: "cm-pn-align-right", none: "" } as const;
const ALIGN_STYLE = { L: "left", C: "center", R: "right", none: "" } as const;

// Atomic's table widget ignores the delimiter row; mirror alignment (and the dash count as min width) onto its cells.
const tableAlignment = ViewPlugin.fromClass(
  class {
    obs: MutationObserver;
    constructor(public view: EditorView) {
      this.obs = new MutationObserver(() => this.apply());
      this.obs.observe(view.contentDOM, { childList: true, subtree: true });
      this.apply();
    }
    update(u: { docChanged: boolean }) { if (u.docChanged) this.view.requestMeasure({ read: () => null, write: () => this.apply() }); }
    destroy() { this.obs.disconnect(); }
    apply() {
      for (const wrap of this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-atomic-table")) {
        let t: ReturnType<typeof readTableAt>;
        try { t = readTableAt(this.view.state, this.view.posAtDOM(wrap) + 1); } catch { continue; }
        if (!t || !isDelimiterRow(t.lines[1])) continue;
        const spec = readDelimiter(t.lines[1]);
        wrap.querySelectorAll("tr").forEach((tr) => tr.querySelectorAll<HTMLElement>("th, td").forEach((cell, i) => {
          const s = spec[i];
          cell.classList.remove(...Object.values(ALIGN_CLASSES).filter(Boolean));
          if (s?.align && s.align !== "none") cell.classList.add(ALIGN_CLASSES[s.align]);
          cell.style.textAlign = s ? ALIGN_STYLE[s.align] : "";
          cell.style.minWidth = s ? `${s.dashes * 1.5}ch` : "";
        }));
      }
    }
  },
);

/** Where the user is in the table: `row` is the source line (0 header, 1 delimiter, >=2 body), `col` the cell index. Focused Atomic widget cell first, else the source cursor. */
function tableCursor(view: EditorView): { row: number; col: number } | null {
  const t = readTableAt(view.state, tablePos(view));
  if (!t) return null;
  const cols = splitRow(t.lines[0]!).length;
  const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));
  const active = document.activeElement;
  const wrap = active?.closest?.(".cm-atomic-table");
  const cell = active?.closest?.("th, td") as HTMLTableCellElement | null | undefined;
  if (wrap && cell && view.contentDOM.contains(wrap)) {
    const i = [...wrap.querySelectorAll("tr")].indexOf(cell.closest("tr")!);
    if (i >= 0) return { row: i === 0 ? 0 : i + 1, col: clamp(cell.cellIndex, cols - 1) };
  }
  const { doc } = view.state;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(clamp(head, doc.length));
  const before = doc.sliceString(line.from, head).replace(/\\\|/g, "");
  const pipes = (before.match(/\|/g) ?? []).length - (/^\s*\|/.test(line.text) ? 1 : 0);
  return { row: clamp(line.number - doc.lineAt(t.from).number, t.lines.length - 1), col: clamp(pipes, cols - 1) };
}

const spliced = (a: string[], i: number, del: number, ...ins: string[]) => { const c = [...a]; c.splice(i, del, ...ins); return c; };
const fmtRow = (cells: string[]) => "| " + cells.map((c) => c || " ").join(" | ") + " |";

/** Offset of the first character of cell `col` in a source row (after its `| `). */
function cellOffset(line: string, col: number): number {
  let n = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\" && ++n === col) return Math.min(i + 2, line.length);
  }
  return line.length;
}

/** Rewrite the table under the cursor: `edit` maps the source lines (given the cursor row/col) to the new lines and where the caret goes, or null for a no-op. */
function editTable(view: EditorView, edit: (lines: string[], cur: { row: number; col: number }, cols: number) => { lines: string[]; at: { row: number; col: number } } | null): void {
  const t = readTableAt(view.state, tablePos(view));
  const cur = tableCursor(view);
  if (!t || !cur || t.lines.length < 2) return;
  const out = edit(t.lines, cur, splitRow(t.lines[0]!).length);
  if (!out) return;
  const row = Math.min(out.at.row, out.lines.length - 1);
  const caret = t.from + out.lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0) + cellOffset(out.lines[row]!, out.at.col);
  view.dispatch({ changes: { from: t.from, to: t.to, insert: out.lines.join("\n") }, selection: { anchor: caret }, annotations: ownTableEdit.of(true) });
  view.focus();
}

/** Insert (`add`) or delete (`!add`) the current column in header, delimiter and body rows; cells are padded to the header width first. */
function editColumn(lines: string[], col: number, cols: number, add: boolean): string[] {
  const mapRow = (cells: string[], fresh: string) => {
    const c = [...cells, ...Array(Math.max(0, cols - cells.length)).fill("")];
    if (add) c.splice(col + 1, 0, fresh); else c.splice(col, 1);
    return c;
  };
  const delim = readDelimiter(lines[1]!);
  while (delim.length < cols) delim.push({ align: "none", dashes: 3 });
  if (add) delim.splice(col + 1, 0, { align: "none", dashes: 3 }); else delim.splice(col, 1);
  return [fmtRow(mapRow(splitRow(lines[0]!), "Spalte")), formatDelimiter(delim), ...lines.slice(2).map((l) => fmtRow(mapRow(splitRow(l), "")))];
}

/** Apply a per-column transform (alignment / dashes) over the table under the cursor. */
function applyDelimiterChange(view: EditorView, change: (spec: Array<{ align: "L" | "C" | "R" | "none"; dashes: number }>, headerLen: number) => Array<{ align: "L" | "C" | "R" | "none"; dashes: number }>): void {
  const t = readTableAt(view.state, tablePos(view));
  if (!t || t.lines.length < 2) return;
  const header = splitRow(t.lines[0]!);
  const newSpec = change(readDelimiter(t.lines[1]!), header.length);
  while (newSpec.length < header.length) newSpec.push({ align: "none", dashes: 3 });
  if (newSpec.length > header.length) newSpec.length = header.length;
  const newText = [t.lines[0]!, formatDelimiter(newSpec), ...t.lines.slice(2)].join("\n");
  view.dispatch({ changes: { from: t.from, to: t.to, insert: newText }, selection: { anchor: t.from }, annotations: ownTableEdit.of(true) });
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
      // Focus moves into the table widget's cells without a CM selection change; keep the toolbar in step.
      view.contentDOM.addEventListener("focusin", this.onFocus);
      view.contentDOM.addEventListener("focusout", this.onFocus);
      this.sync();
    }
    onFocus = () => setTimeout(() => this.sync(), 0);
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.sync();
    }
    destroy() {
      this.view.contentDOM.removeEventListener("focusin", this.onFocus);
      this.view.contentDOM.removeEventListener("focusout", this.onFocus);
      this.dom.remove();
    }
    private inTable(): boolean {
      return !!readTableAt(this.view.state, tablePos(this.view));
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
        mkBtn("⊕ Zeile", "Zeile unter der aktuellen einfügen", () =>
          editTable(v, (lines, cur, cols) => {
            const row = Math.max(cur.row, 1) + 1;
            return { lines: spliced(lines, row, 0, fmtRow(Array(cols).fill(""))), at: { row, col: 0 } };
          })),
        mkBtn("⊖ Zeile", "Aktuelle Zeile entfernen", () =>
          editTable(v, (lines, cur) => (cur.row < 2 || lines.length <= 3 ? null : { lines: spliced(lines, cur.row, 1), at: cur }))),
        mkBtn("⊕ Spalte", "Spalte rechts der aktuellen einfügen", () =>
          editTable(v, (lines, cur, cols) => ({ lines: editColumn(lines, cur.col, cols, true), at: { row: cur.row, col: cur.col + 1 } }))),
        mkBtn("⊖ Spalte", "Aktuelle Spalte entfernen", () =>
          editTable(v, (lines, cur, cols) => (cols <= 1 ? null : { lines: editColumn(lines, cur.col, cols, false), at: { row: cur.row, col: Math.min(cur.col, cols - 2) } }))),
        mkBtn("⇤ L", "Spalten linksbündig ausrichten", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, align: "L" as const })))),
        mkBtn("⇔ C", "Spalten zentrieren", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, align: "C" as const })))),
        mkBtn("⇥ R", "Spalten rechtsbündig ausrichten", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, align: "R" as const })))),
        mkBtn("Breite −", "Spaltenbreite verkleinern", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, dashes: Math.max(3, c.dashes - 2) })))),
        mkBtn("Breite +", "Spaltenbreite vergrößern", () => applyDelimiterChange(v, (s) => s.map((c) => ({ ...c, dashes: c.dashes + 2 })))),
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
      // Leave from the last body line already: the next ArrowDown would land on the closing fence, which is hidden once the cursor is "after" the block.
      const lastLineNo = state.doc.lineAt(node.to).number;
      const closed = node.getChildren("CodeMark").length >= 2;
      if (headLine.number < (closed ? lastLineNo - 1 : lastLineNo)) return false;
      // A wrapped line whose cursor is not on the last visual row: let CM move within the line. (coordsAtPos is null without layout, e.g. jsdom.)
      const here = view.coordsAtPos(head), tail = view.coordsAtPos(headLine.to, -1);
      if (here && tail && tail.top - here.top > 2) return false;
      // Only move the cursor to the line after the block; text is added only when the block ends the document.
      if (node.to < state.doc.length) view.dispatch({ selection: { anchor: state.doc.lineAt(node.to + 1).from }, scrollIntoView: true });
      else view.dispatch({ changes: { from: node.to, insert: "\n" }, selection: { anchor: node.to + 1 }, scrollIntoView: true });
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
  // side 1: a match at the very start of an indented code block (its node begins at `from`) is inside it too
  let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(from, 1);
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

// shortcut: lezer-markdown's GFM extensions don't add sub/sup marks; we wrap `~x~` (single tilde, NOT `~~`) and `^x^` (caret) with mark decorations so the source stays editable. `~~strike~~` renders via GFM; HTML `<sub>x</sub>`/`<sup>x</sup>` has its tags hidden (Obsidian-style) while the cursor is outside.
function buildSubSupDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const text = view.state.doc.toString();
  const head = view.state.selection.main;
  // `touches` = the cursor sits inside the visible span [from, to). Cursor at `to` is *after* it (typing appends), so we use `>=` for `from` and `<` for `to`.
  const selTouches = (from: number, to: number) => head.empty ? head.head >= from && head.head < to : head.to > from && head.from < to;
  // `~x~` — NOT `~~x~~`. The lookbehind/lookahead reject a second `~` so we don't shade strikethrough.
  // No whitespace inside (Markdown Guide: H~2~O, X^2^): otherwise `[^1] … [^2]` or two stray carets would shade whole paragraphs.
  const subRe = /(?<!~)~([^\s~]+)~(?!~)/g;
  // `^x^` — single caret.
  const supRe = /(?<![\^[])\^([^\s^]+)\^(?!\^)/g;
  for (const [re, cls] of [[subRe, "cm-pn-sub"], [supRe, "cm-pn-sup"]] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = m.index;
      const to = from + m[0]!.length;
      if (selTouches(from, to)) continue;
      if (inCodeSpan(view.state, from, to)) continue;
      // Hide the single `~`/`^` delimiters (cursor elsewhere) and lower/raise the content.
      decos.push(Decoration.replace({}).range(from, from + 1), Decoration.mark({ class: cls }).range(from + 1, to - 1), Decoration.replace({}).range(to - 1, to));
    }
  }
  const htmlRe = new RegExp(`<(${Object.keys(HTML_INLINE).join("|")})>([^<\\n]+)</\\1>`, "g");
  let h: RegExpExecArray | null;
  while ((h = htmlRe.exec(text))) {
    const from = h.index;
    const to = from + h[0].length;
    if (selTouches(from, to) || inCodeSpan(view.state, from, to)) continue;
    const open = from + h[1]!.length + 2;
    const close = to - h[1]!.length - 3;
    decos.push(
      Decoration.replace({}).range(from, open),
      Decoration.mark({ class: HTML_INLINE[h[1]!]! }).range(open, close),
      Decoration.replace({}).range(close, to),
    );
  }
  return Decoration.set(decos, true);
}

// Inline HTML (markdownguide "hacks" / basic syntax): tags are hidden while the cursor is elsewhere and the content is styled.
const HTML_INLINE: Record<string, string> = {
  sub: "cm-pn-sub", sup: "cm-pn-sup", b: "cm-pn-html-b", strong: "cm-pn-html-b", i: "cm-pn-html-i", em: "cm-pn-html-i",
  u: "cm-pn-html-u", ins: "cm-pn-html-u", s: "cm-pn-html-s", del: "cm-pn-html-s", mark: "cm-pn-html-mark", kbd: "cm-pn-html-kbd",
};

const ENTITY: Record<string, string> = {
  "&nbsp;": " ", "&ensp;": " ", "&emsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&copy;": "©", "&reg;": "®", "&hellip;": "…", "&mdash;": "—", "&ndash;": "–",
};

class GlyphWidget extends WidgetType {
  constructor(readonly source: string, readonly glyph: string, readonly cls: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.glyph;
    return span;
  }
  eq(other: GlyphWidget) { return other.source === this.source && other.cls === this.cls; }
  ignoreEvent() { return true; }
}

// shortcut: lezer GFM has no node for footnotes, definition lists, heading ids or HTML entities; per-line regexes over the doc (not fences/code) are enough for a capture editor. Footnote refs and entities become glyph widgets while the cursor is elsewhere; the rest only get classes.
function buildExtraDecos(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const sel = state.selection.main;
  const touches = (from: number, to: number) => (sel.empty ? sel.head >= from && sel.head < to : sel.to > from && sel.from < to);
  const line = (cls: string, at: number) => decos.push(Decoration.line({ attributes: { class: cls } }).range(at));
  const entityRe = new RegExp(Object.keys(ENTITY).join("|"), "g");
  for (let n = 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (!l.text || !inside(state, l.from)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\[\^([^\]\s]+)\]:\s/.exec(l.text))) {
      line("cm-pn-footnote-def", l.from);
      decos.push(Decoration.mark({ class: "cm-pn-footnote-label" }).range(l.from, l.from + m[0].length - 1));
    } else if (/^:\s+\S/.test(l.text) && n > 1 && state.doc.line(n - 1).text.trim()) {
      line("cm-pn-dl-def", l.from);
      const prev = state.doc.line(n - 1);
      if (!prev.text.startsWith(":")) line("cm-pn-dl-term", prev.from);
    } else if ((m = /^#{1,6}\s.*?(\{#[\w-]+\})\s*$/.exec(l.text))) {
      const at = l.from + l.text.lastIndexOf(m[1]!);
      decos.push(Decoration.mark({ class: "cm-pn-heading-id" }).range(at, at + m[1]!.length));
    }
    const widget = (re: RegExp, glyph: (s: string, m: RegExpExecArray) => string | undefined, cls: string) => {
      re.lastIndex = 0;
      for (let w: RegExpExecArray | null; (w = re.exec(l.text)); ) {
        const from = l.from + w.index;
        const g = glyph(w[0], w);
        if (g === undefined || touches(from, from + w[0].length) || (w.index > 0 && l.text[w.index - 1] === "\\") || inCodeSpan(state, from, from + w[0].length)) continue;
        decos.push(Decoration.replace({ widget: new GlyphWidget(w[0], g, cls) }).range(from, from + w[0].length));
      }
    };
    widget(/\[\^([^\]\s]+)\](?!:)/g, (_s, w) => w[1], "cm-pn-footnote-ref");
    widget(entityRe, (s) => ENTITY[s], "cm-pn-entity");
  }
  return Decoration.set(decos, true);
}

const extraPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildExtraDecos(view); }
    update(update: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; state: EditorState; view: EditorView }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildExtraDecos(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

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
  const linkRe = /\[([^\]]+)\]\(pending:([a-zA-Z0-9-]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text))) {
    // Images keep their source line; Atomic shows the block preview and pendingImageSrc fixes its src.
    if (text[m.index - 1] === "!") continue;
    const from = m.index;
    const to = from + m[0].length;
    if (!inCodeSpan(view.state, from, to)) {
      decos.push(Decoration.replace({ widget: new FileChipWidget(m[1] ?? "") }).range(from, to));
    }
  }
  return Decoration.set(decos, true);
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

// Atomic renders a block <img> for `![](pending:<id>)`; point it at the locally stashed bytes.
const pendingImageSrc = ViewPlugin.fromClass(
  class {
    obs: MutationObserver;
    constructor(view: EditorView) {
      const fix = () => view.contentDOM.querySelectorAll<HTMLImageElement>("img[src^=\"pending:\"]").forEach((img) => {
        const id = img.getAttribute("src")!.slice("pending:".length);
        img.removeAttribute("src"); // avoid refetching while the lookup is pending
        void import("./attachments").then(({ getAttachment }) => getAttachment(id)).then((a) => {
          if (a) img.src = URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }));
        });
      });
      this.obs = new MutationObserver(fix);
      this.obs.observe(view.contentDOM, { childList: true, subtree: true });
      fix();
    }
    destroy() { this.obs.disconnect(); }
  },
);

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
// The link gets its own line (Atomic previews an image only as a block) and the caret lands on the line below it; shared by paste, drop and the Screenshot/Datei buttons.
export async function insertAttachmentAt(view: EditorView, pos: number, file: { name: string; mime: string; bytes: Uint8Array }): Promise<void> {
  const { stashAttachment, makeMarkdownLink } = await import("./attachments");
  const { markdownTarget } = await stashAttachment(file);
  const link = makeMarkdownLink(file.name, markdownTarget, file.mime);
  const { doc } = view.state;
  pos = Math.min(pos, doc.length); // the doc may have shrunk while the bytes were stashed
  const before = pos > 0 && doc.sliceString(pos - 1, pos) !== "\n" ? "\n" : "";
  const nextIsBreak = doc.sliceString(pos, pos + 1) === "\n";
  view.dispatch({ changes: { from: pos, insert: before + link + (nextIsBreak ? "" : "\n") }, selection: { anchor: pos + before.length + link.length + 1 }, userEvent: "input.paste" });
}

/** True when the clipboard carries real text next to the files. A Finder copy puts only the file name/path in text/plain, a browser "copy image" only an `<img>` in text/html: both stay file pastes. */
function hasPastedText(data: DataTransfer, files: File[]): boolean {
  const names = new Set(files.map((f) => f.name));
  const plain = data.getData("text/plain").trim();
  if (plain && !plain.split(/\r?\n/).every((l) => names.has(l.trim().split("/").pop()!))) return true;
  const html = data.getData("text/html");
  return !!html && new DOMParser().parseFromString(html, "text/html").body.textContent!.trim() !== "";
}

const attachmentPasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    const files = event.clipboardData?.files ? [...event.clipboardData.files] : [];
    if (files.length === 0 || hasPastedText(event.clipboardData!, files)) return false; // Excel/Word: text + preview image -> paste the text
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
  taskTyping,
  Prec.highest(taskListInput),
  Prec.highest(growFenceWithOpening),
  Prec.highest(plainEmphasisChars),
  Prec.highest(enterLeavesEmptyMarker),
  Prec.highest(enterBuildsTable),
  Prec.highest(leaveEmptyItemOrQuote),
  Prec.highest(fencePlugin),
  Prec.high(fenceArrowExit),
  Prec.high(subSupPlugin),
  Prec.high(extraPlugin),
  Prec.high(emojiPlugin),
  Prec.high(attachmentsRenderPlugin),
  pendingImageSrc,
  Prec.highest(attachmentPasteHandler),
  Prec.high(tableToolbar),
  keepTableAlignment,
  tableAlignment,
  atomicTables(), // keep Atomic's table widgets so cells render; our toolbar writes valid GFM that re-parses as Table.
];
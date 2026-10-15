import { highlightMarkdown } from "@atomic-editor/editor";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Prec } from "@codemirror/state";

// shortcut: duplicates Atomic Editor's internal markdown({base: markdownLanguage, extensions: [highlightMarkdown]}) to add {remove: ["SetextHeading"]}; Prec.high wins over the built-in language facet; drop once Atomic Editor accepts lezer extensions.
const parser = markdown({ base: markdownLanguage, extensions: [highlightMarkdown, { remove: ["SetextHeading"] }] }).language;
export const editorExtensions = [Prec.high(parser)];

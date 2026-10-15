import { createHash } from "node:crypto";
import { CLAUDE_END, CLAUDE_START, SUMMARY_END, SUMMARY_START } from "./vault.js";

export type InstructionStatus = "pending" | "done" | "failed";
export interface Instruction {
  id: string;
  hash: string;
  text: string;
}

export const EXTRACT_SECTION = /<!-- extract:[^\n]*? -->[\s\S]*?<!-- \/extract -->/g;

const strip = (body: string, start: string, end: string) => {
  const s = body.indexOf(start);
  const e = body.indexOf(end);
  return s !== -1 && e > s ? body.slice(0, s) + body.slice(e + end.length) : body;
};

/** True when the text mentions @claude at all (used to mark ignored imports). */
export const mentionsClaude = (body: string) => /(^|\s)@claude\b/i.test(body);

/**
 * Extracts @claude instructions from the user's own text. Our own generated blocks and
 * quoted lines are excluded so results never trigger new instructions. Ids are derived from noteId + instruction hash.
 */
export function parseInstructions(body: string, noteId: string): Instruction[] {
  // Text the server extracted from attachments (jobs.ts "extract-inline") is not the user's own input either.
  const own = strip(strip(body, CLAUDE_START, CLAUDE_END), SUMMARY_START, SUMMARY_END).replace(EXTRACT_SECTION, "");
  const out = new Map<string, Instruction>();
  const lines = own.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:^|\s)@claude\b[:,]?\s*(.*)$/i.exec(lines[i]!);
    if (!m || lines[i]!.trimStart().startsWith(">")) continue;
    const parts = [m[1]!];
    while (i + 1 < lines.length && lines[i + 1]!.trim() && !/(?:^|\s)@claude\b/i.test(lines[i + 1]!)) parts.push(lines[++i]!);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const hash = createHash("sha256").update(text).digest("hex");
    // The id is the table's primary key, so it must differ per note: the same text in two notes is two instructions.
    out.set(hash, { id: `c_${createHash("sha256").update(`${noteId}:${hash}`).digest("hex").slice(0, 12)}`, hash, text });
  }
  return [...out.values()];
}

export const renderCallout = (id: string, status: InstructionStatus, text = "") =>
  [`> [!claude] id:${id} status:${status}`, ...(text ? text.split("\n").map((l) => `> ${l}`) : [])].join("\n");

/** Inserts or replaces the callout with the given id inside the claude block content. */
export function upsertCallout(block: string, id: string, status: InstructionStatus, text = ""): string {
  const callouts = block.split(/\n\n+/).filter(Boolean);
  const next = renderCallout(id, status, text);
  const idx = callouts.findIndex((c) => c.startsWith(`> [!claude] id:${id} `));
  if (idx === -1) callouts.push(next);
  else callouts[idx] = next;
  return callouts.join("\n\n");
}

export function readClaudeBlock(body: string): string {
  const s = body.indexOf(CLAUDE_START);
  const e = body.indexOf(CLAUDE_END);
  return s !== -1 && e > s ? body.slice(s + CLAUDE_START.length, e).trim() : "";
}

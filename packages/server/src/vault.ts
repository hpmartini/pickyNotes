import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export const SUMMARY_START = "<!-- picky:summary -->";
export const SUMMARY_END = "<!-- /picky:summary -->";
export const CLAUDE_START = "<!-- picky:claude -->";
export const CLAUDE_END = "<!-- /picky:claude -->";

export class ConflictError extends Error {}

export interface VaultFile {
  path: string; // vault-relative, posix
  data: Record<string, unknown>;
  body: string;
  hash: string;
}

export interface CuratePatch {
  frontmatter?: Record<string, unknown>;
  summary?: string;
  /** Replaces the whole claude-callout block content. */
  claudeBlock?: string;
}

const noCode = () => {
  throw new Error("code frontmatter is disabled");
};
/** gray-matter evaluates `---js` frontmatter as code; vault files are untrusted input, so only YAML/JSON is allowed. */
const parseNote = (raw: string) => matter(raw, { engines: { js: noCode, javascript: noCode, coffee: noCode, coffeescript: noCode, cson: noCode } });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules"]);

/** Body without our generated blocks (what gets indexed and shown as the note text). */
export function stripPickyBlocks(body: string): string {
  const cut = (s: string, start: string, end: string) => {
    const a = s.indexOf(start);
    const b = s.indexOf(end);
    return a !== -1 && b > a ? s.slice(0, a) + s.slice(b + end.length) : s;
  };
  return cut(cut(body, SUMMARY_START, SUMMARY_END), CLAUDE_START, CLAUDE_END).trim();
}

function replaceBlock(body: string, start: string, end: string, inner: string, where: "top" | "bottom"): string {
  const block = `${start}\n${inner}\n${end}`;
  const s = body.indexOf(start);
  const e = body.indexOf(end);
  if (s !== -1 && e > s) return body.slice(0, s) + block + body.slice(e + end.length);
  return where === "top" ? `${block}\n\n${body}` : `${body.replace(/\n*$/, "\n")}\n${block}\n`;
}

/**
 * The only module that touches the vault. Deliberately exposes NO delete/move/rename:
 * new files go to raw/ (never overwritten), existing files are read-only except the
 * curator's frontmatter + marked blocks, written compare-before-write.
 */
export class Vault {
  constructor(readonly root: string) {}

  private abs(rel: string): string {
    const p = path.resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`path escapes vault: ${rel}`);
    return p;
  }

  absPath(rel: string): string {
    return this.abs(rel);
  }

  readBytes(rel: string): Promise<Buffer> {
    return readFile(this.abs(rel));
  }

  async read(rel: string): Promise<VaultFile> {
    const raw = await readFile(this.abs(rel), "utf8");
    const m = parseNote(raw);
    return { path: rel, data: m.data, body: m.content, hash: sha(raw) };
  }

  /** Creates raw/<id>.md; fails if it already exists (flag wx), so nothing is ever overwritten. */
  async writeNew(id: string, data: Record<string, unknown>, body: string): Promise<string> {
    const rel = `raw/${id}.md`;
    await this.atomicCreate(rel, matter.stringify(body.endsWith("\n") ? body : body + "\n", data));
    return rel;
  }

  async writeAttachment(id: string, filename: string, bytes: Buffer): Promise<string> {
    const safe = path.basename(filename).replace(/[^\w.\-]+/g, "_").slice(-100) || "file";
    const rel = `raw/attachments/${id}-${safe}`;
    await mkdir(this.abs("raw/attachments"), { recursive: true });
    const fh = await open(this.abs(rel), "wx");
    try {
      await fh.writeFile(bytes);
    } finally {
      await fh.close();
    }
    return rel;
  }

  private async atomicCreate(rel: string, content: string) {
    const target = this.abs(rel);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, content, { flag: "wx" });
    try {
      await link(tmp, target); // atomic and fails with EEXIST: never clobbers an existing note
    } finally {
      await unlink(tmp); // only our own temp file
    }
  }

  /** Compare-before-write: aborts with ConflictError if the file changed since `expectedHash`. */
  async curate(rel: string, expectedHash: string, patch: CuratePatch): Promise<VaultFile> {
    const target = this.abs(rel);
    const raw = await readFile(target, "utf8");
    if (sha(raw) !== expectedHash) throw new ConflictError(`${rel} changed since read`);
    const m = parseNote(raw);
    let body = m.content;
    if (patch.summary !== undefined) body = replaceBlock(body, SUMMARY_START, SUMMARY_END, `> ${patch.summary.replace(/\n+/g, "\n> ")}`, "top");
    if (patch.claudeBlock !== undefined) body = replaceBlock(body, CLAUDE_START, CLAUDE_END, patch.claudeBlock, "bottom");
    const out = matter.stringify(body, { ...m.data, ...patch.frontmatter });
    // shortcut: tiny window between this re-check and rename; upgrade to file locks if a sync tool writes concurrently
    if (sha(await readFile(target, "utf8")) !== expectedHash) throw new ConflictError(`${rel} changed during write`);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, target);
    return this.read(rel);
  }

  /** Walks all .md files; sync-conflict copies are reported separately and never returned as notes. */
  async scan(): Promise<{ files: string[]; conflicts: string[] }> {
    const files: string[] = [];
    const conflicts: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(this.abs(dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && rel !== "raw/attachments") await walk(rel); // attachments are blobs, never notes
        } else if (e.name.endsWith(".md") || e.name.includes(".sync-conflict-")) {
          (e.name.includes(".sync-conflict-") ? conflicts : files).push(rel);
        }
      }
    };
    await walk("");
    return { files, conflicts };
  }
}

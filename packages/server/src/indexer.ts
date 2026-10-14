import { createHash } from "node:crypto";
import { SUMMARY_END, SUMMARY_START, stripPickyBlocks } from "./vault.js";
import type { Deps } from "./services.js";

const idOf = (rel: string) => "v_" + createHash("sha1").update(rel).digest("hex").slice(0, 16);

/** Rebuilds the DB index from the vault. Read-only on the vault; sync-conflict copies are recorded, never indexed. */
export async function reindex(deps: Deps): Promise<{ indexed: number; conflicts: number; removed: number }> {
  const { files, conflicts } = await deps.vault.scan();
  for (const c of conflicts) await deps.repo.recordConflict(c, "sync-conflict");
  const kept: string[] = [];
  for (const rel of files) {
    let f;
    try {
      f = await deps.vault.read(rel);
    } catch (e) {
      await deps.repo.recordConflict(rel, "unreadable", String(e).slice(0, 200));
      kept.push(rel); // keep its previous index row rather than dropping it on a parse error
      continue;
    }
    kept.push(rel);
    const id = typeof f.data.id === "string" ? f.data.id : idOf(rel);
    const body = stripPickyBlocks(f.body);
    const tags = Array.isArray(f.data.tags) ? f.data.tags.map(String) : typeof f.data.tags === "string" ? f.data.tags.split(/[,\s]+/).filter(Boolean) : [];
    const sm = f.body.indexOf(SUMMARY_START);
    const se = f.body.indexOf(SUMMARY_END);
    const summary = sm !== -1 && se > sm ? f.body.slice(sm + SUMMARY_START.length, se).replace(/^\s*>\s?/gm, "").trim() : null;
    const title = typeof f.data.title === "string" ? f.data.title : (/^#\s+(.+)$/m.exec(body)?.[1] ?? rel.split("/").pop()!.replace(/\.md$/, ""));
    const prev = await deps.repo.getNote(id);
    if (prev?.contentHash === f.hash && prev.path === rel) continue;
    await deps.repo.upsertNote({
      id, path: rel, title, body, tags, summary,
      source: f.data.source === "typed" || f.data.source === "dictated" ? f.data.source : "imported",
      status: f.data.status === "pending" ? "pending" : "curated",
      contentHash: f.hash,
      createdAt: f.data.created instanceof Date ? f.data.created.toISOString() : typeof f.data.created === "string" ? f.data.created : undefined,
    });
    await deps.queue.send("embed", { noteId: id });
  }
  const removed = await deps.repo.deleteMissing(kept);
  return { indexed: kept.length, conflicts: conflicts.length, removed };
}

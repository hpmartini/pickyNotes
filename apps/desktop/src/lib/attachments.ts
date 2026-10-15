/**
 * Local byte cache for inline attachments until the queued text capture is delivered.
 * Always an IndexedDB store; the queued capture re-reads at flush time so a retry doesn't lose the bytes.
 * The body refers to each attachment as `pending:<id>` until the server rewrites the link to the vault path.
 */
export interface StoredAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

const DB = "pickynotes-attachments";
const STORE = "attachments";

let _db: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return (_db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function stashAttachment(file: { name: string; mime: string; bytes: Uint8Array }): Promise<{ id: string; markdownTarget: string }> {
  const id = crypto.randomUUID();
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id, name: file.name, mime: file.mime, bytes: file.bytes } satisfies StoredAttachment, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { id, markdownTarget: `pending:${id}` };
}

export async function readAttachmentsForSend(): Promise<{ id: string; name: string; mime: string; data: string }[]> {
  const d = await db();
  const all = await new Promise<StoredAttachment[]>((resolve, reject) => {
    const tx = d.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as StoredAttachment[]);
    req.onerror = () => reject(req.error);
  });
  return all.map((a) => ({ id: a.id, name: a.name, mime: a.mime, data: toBase64(a.bytes) }));
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
};

export function isImage(mime: string): boolean { return mime.startsWith("image/"); }

export function makeMarkdownLink(name: string, target: string, mime: string): string {
  return isImage(mime) ? `![${name}](${target})` : `[${name}](${target})`;
}
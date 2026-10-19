import { ApiError, type CaptureInput } from "@pickynotes/shared";
import { openDB, type IDBPDatabase } from "idb";

export interface QueuedCapture {
  key?: number;
  input: CaptureInput;
  queuedAt: number;
  /** Set when the server rejected the capture permanently (4xx other than 401/429). */
  rejected?: string;
}
export type Send = (input: CaptureInput) => Promise<unknown>;

const STORE = "captures";

/** Plain-file second copy of every queued capture (Rust, app data dir): survives a lost or cleared IndexedDB. Keyed by clientId. */
export interface Outbox {
  write(item: QueuedCapture): Promise<void>;
  remove(clientId: string): Promise<void>;
  list(): Promise<QueuedCapture[]>;
}

/** `stored`: the capture sits in IndexedDB and, if there is an outbox, in the outbox too. Only then may the draft be closed before delivery. */
export interface Enqueued {
  key?: number;
  clientId: string;
  stored: boolean;
}

/**
 * Durable capture queue in IndexedDB, mirrored into an optional file outbox. Every capture is stored first,
 * then flushed in order, so nothing is lost offline or on a crash. Flush stops at the first transient failure
 * (network, 401, 429, 5xx, missing server config) and parks permanently-rejected items instead of blocking the queue.
 */
export class CaptureQueue {
  private db: Promise<IDBPDatabase>;
  private flushing?: Promise<number>;
  private listeners = new Set<() => void>();
  /** Outbox items IndexedDB does not have are copied back once at startup; every operation waits for it. */
  private ready: Promise<unknown>;

  constructor(name = "pickynotes-queue", private outbox?: Outbox) {
    this.db = openDB(name, 1, { upgrade: (db) => void db.createObjectStore(STORE, { keyPath: "key", autoIncrement: true }) });
    this.ready = this.restoreNow().catch(() => 0);
  }

  /** Calls `fn` after every change of the queue; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((f) => f());
  }

  /** Stores the capture with a stable clientId (the server dedupes retries on it) in both stores. Throws only if neither worked. */
  async enqueue(input: CaptureInput): Promise<Enqueued> {
    await this.ready;
    const clientId = input.clientId ?? crypto.randomUUID();
    const item = { input: { ...input, clientId }, queuedAt: Date.now() } satisfies QueuedCapture;
    // An absent outbox is a missing store, not a successful write.
    const [idb, file] = await Promise.allSettled([this.db.then((d) => d.add(STORE, item) as Promise<number>), this.outbox ? this.outbox.write(item) : Promise.reject(new Error("no outbox"))]);
    if (idb.status === "rejected" && (file.status === "rejected" || !this.outbox)) throw idb.reason;
    this.emit();
    return { key: idb.status === "fulfilled" ? idb.value : undefined, clientId, stored: idb.status === "fulfilled" && (file.status === "fulfilled" || !this.outbox) };
  }

  async list(): Promise<QueuedCapture[]> {
    await this.ready;
    return (await this.db).getAll(STORE);
  }

  /** Puts a rejected item back into the send queue. */
  async retry(key: number): Promise<void> {
    const db = await this.db;
    const item = (await db.get(STORE, key)) as QueuedCapture | undefined;
    if (item) await db.put(STORE, { ...item, rejected: undefined });
    this.emit();
  }

  /** Removes the item from IndexedDB and the outbox. */
  async discard(key: number): Promise<void> {
    const db = await this.db;
    const item = (await db.get(STORE, key)) as QueuedCapture | undefined;
    await db.delete(STORE, key);
    await this.removeFile(item);
    this.emit();
  }

  /** The outbox copy goes after the server confirmed (or the user discarded). A failed removal only means a later restore resends it; the server dedupes on clientId. */
  private async removeFile(item?: QueuedCapture) {
    if (item?.input.clientId) await this.outbox?.remove(item.input.clientId).catch(() => {});
  }

  /** Items still waiting to be sent. */
  async pending(): Promise<number> {
    return (await this.list()).filter((i) => !i.rejected).length;
  }

  /** Copies outbox items missing in IndexedDB back into it; returns how many. */
  async restore(): Promise<number> {
    await this.ready;
    return this.restoreNow();
  }

  private async restoreNow(): Promise<number> {
    if (!this.outbox) return 0;
    const db = await this.db;
    const have = new Set(((await db.getAll(STORE)) as QueuedCapture[]).map((i) => i.input.clientId));
    let added = 0;
    for (const { key: _drop, ...item } of await this.outbox.list()) {
      if (have.has(item.input.clientId)) continue;
      await db.add(STORE, item);
      added++;
    }
    if (added) this.emit();
    return added;
  }

  /** Sends queued captures in order; returns how many were delivered. Concurrent calls share one run. */
  flush(send: Send): Promise<number> {
    return (this.flushing ??= this.run(send).finally(() => (this.flushing = undefined)));
  }

  private async run(send: Send): Promise<number> {
    await this.ready;
    const db = await this.db;
    let sent = 0;
    try {
      for (const item of (await db.getAll(STORE)) as QueuedCapture[]) {
        if (item.rejected) continue;
        try {
          await send(item.input);
          await db.delete(STORE, item.key!);
          await this.removeFile(item);
          sent++;
        } catch (e) {
          const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;
          if (!permanent) break;
          await db.put(STORE, { ...item, rejected: e.message });
        }
      }
    } finally {
      this.emit();
    }
    return sent;
  }
}

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

/**
 * Durable capture queue in IndexedDB. Every capture is stored first, then flushed in order,
 * so nothing is lost offline or on a crash. Flush stops at the first transient failure
 * (network, 401, 429, 5xx) and parks permanently-rejected items instead of blocking the queue.
 */
export class CaptureQueue {
  private db: Promise<IDBPDatabase>;
  private flushing?: Promise<number>;

  constructor(name = "pickynotes-queue") {
    this.db = openDB(name, 1, { upgrade: (db) => void db.createObjectStore(STORE, { keyPath: "key", autoIncrement: true }) });
  }

  async enqueue(input: CaptureInput): Promise<void> {
    await (await this.db).add(STORE, { input, queuedAt: Date.now() } satisfies QueuedCapture);
  }

  async list(): Promise<QueuedCapture[]> {
    return (await this.db).getAll(STORE);
  }

  /** Items still waiting to be sent. */
  async pending(): Promise<number> {
    return (await this.list()).filter((i) => !i.rejected).length;
  }

  /** Sends queued captures in order; returns how many were delivered. Concurrent calls share one run. */
  flush(send: Send): Promise<number> {
    return (this.flushing ??= this.run(send).finally(() => (this.flushing = undefined)));
  }

  private async run(send: Send): Promise<number> {
    const db = await this.db;
    let sent = 0;
    for (const item of (await db.getAll(STORE)) as QueuedCapture[]) {
      if (item.rejected) continue;
      try {
        await send(item.input);
        await db.delete(STORE, item.key!);
        sent++;
      } catch (e) {
        const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;
        if (!permanent) break;
        await db.put(STORE, { ...item, rejected: e.message });
      }
    }
    return sent;
  }
}

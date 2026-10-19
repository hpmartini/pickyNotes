import "fake-indexeddb/auto";
import { ApiError, type CaptureInput } from "@pickynotes/shared";
import { describe, expect, it, vi } from "vitest";
import { CaptureQueue, type Outbox, type QueuedCapture } from "./queue.js";

const cap = (text: string): CaptureInput => ({ kind: "text", source: "typed", text });
let n = 0;
const fresh = () => new CaptureQueue(`q${n++}`);

describe("CaptureQueue", () => {
  it("keeps captures while offline and delivers them in order once back online", async () => {
    const q = fresh();
    await q.enqueue(cap("1"));
    await q.enqueue(cap("2"));
    const offline = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await q.flush(offline)).toBe(0);
    expect(offline).toHaveBeenCalledTimes(1); // stops at the first transient failure
    expect(await q.pending()).toBe(2);

    const seen: string[] = [];
    expect(await q.flush(async (i) => void seen.push(i.text!))).toBe(2);
    expect(seen).toEqual(["1", "2"]);
    expect(await q.pending()).toBe(0);
  });

  it("keeps items on 401/429/5xx but parks permanent rejections without blocking the rest", async () => {
    const q = fresh();
    for (const t of ["bad", "ok"]) await q.enqueue(cap(t));
    const send = vi.fn(async (i: CaptureInput) => {
      if (i.text === "bad") throw new ApiError(400, "invalid");
    });
    expect(await q.flush(send)).toBe(1);
    const left = await q.list();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ rejected: "invalid" });
    expect(await q.pending()).toBe(0);

    const q2 = fresh();
    await q2.enqueue(cap("x"));
    for (const status of [401, 429, 503]) {
      expect(await q2.flush(async () => Promise.reject(new ApiError(status, "no")))).toBe(0);
      expect(await q2.pending()).toBe(1);
    }
  });

  it("gives every capture a stable clientId that survives retries; rejected items can be retried or discarded", async () => {
    const q = fresh();
    const { key: k1 } = await q.enqueue(cap("a"));
    const { key: k2 } = await q.enqueue({ ...cap("b"), clientId: "mine" });
    const seen: CaptureInput[] = [];
    await q.flush(async (i) => {
      seen.push(i);
      throw new ApiError(400, "invalid");
    });
    expect(seen[0]!.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.clientId).toBe("mine");

    await q.retry(k1!);
    expect(await q.pending()).toBe(1);
    const again: CaptureInput[] = [];
    await q.flush(async (i) => void again.push(i));
    expect(again).toEqual([seen[0]]); // same clientId as the first attempt
    await q.discard(k2!);
    expect(await q.list()).toEqual([]);
  });

  it("concurrent flushes deliver each item once", async () => {
    const q = fresh();
    await q.enqueue(cap("a"));
    const send = vi.fn(async () => {});
    await Promise.all([q.flush(send), q.flush(send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe("with an outbox (plain-file second copy)", () => {
    /** In-memory stand-in for the Rust outbox files. */
    const fakeOutbox = () => {
      const files = new Map<string, QueuedCapture>();
      const outbox: Outbox & { failWrite?: boolean } = {
        write: async (item) => {
          if (outbox.failWrite) throw new Error("disk full");
          files.set(item.input.clientId!, item);
        },
        remove: async (id) => void files.delete(id),
        list: async () => [...files.values()],
      };
      return { files, outbox };
    };

    it("an offline save is stored in IndexedDB and the outbox and stays retrievable", async () => {
      const { files, outbox } = fakeOutbox();
      const q = new CaptureQueue(`q${n++}`, outbox);
      const r = await q.enqueue(cap("offline"));
      expect(r.stored).toBe(true);
      expect(await q.flush(vi.fn().mockRejectedValue(new TypeError("fetch failed")))).toBe(0);
      expect((await q.list()).map((i) => i.input.text)).toEqual(["offline"]);
      expect([...files.values()].map((i) => i.input.text)).toEqual(["offline"]);
      expect(files.has(r.clientId)).toBe(true);
    });

    it("restores from the outbox when IndexedDB lost the item, without duplicates", async () => {
      const { files, outbox } = fakeOutbox();
      const q = new CaptureQueue(`q${n++}`, outbox);
      const { clientId } = await q.enqueue(cap("wichtig"));
      const lost = new CaptureQueue(`q${n++}`, outbox); // new, empty IndexedDB
      const items = await lost.list();
      expect(items.map((i) => i.input)).toEqual([expect.objectContaining({ text: "wichtig", clientId })]);
      expect(items[0]!.key).toBeDefined();
      expect(await lost.restore()).toBe(0); // second run adds nothing
      expect(await lost.list()).toHaveLength(1);
      expect(files.size).toBe(1);
    });

    it("a delivered item removes both copies", async () => {
      const { files, outbox } = fakeOutbox();
      const q = new CaptureQueue(`q${n++}`, outbox);
      await q.enqueue(cap("x"));
      expect(await q.flush(async () => {})).toBe(1);
      expect(await q.list()).toEqual([]);
      expect(files.size).toBe(0);
    });

    it("discard removes both copies; a rejected item keeps its outbox copy until discarded", async () => {
      const { files, outbox } = fakeOutbox();
      const q = new CaptureQueue(`q${n++}`, outbox);
      const { key } = await q.enqueue(cap("x"));
      await q.flush(async () => Promise.reject(new ApiError(400, "invalid")));
      expect(files.size).toBe(1);
      await q.discard(key!);
      expect(files.size).toBe(0);
      expect(await q.list()).toEqual([]);
    });

    it("reports stored:false when the outbox write fails, and throws when neither store works", async () => {
      const { outbox } = fakeOutbox();
      outbox.failWrite = true;
      const q = new CaptureQueue(`q${n++}`, outbox);
      const r = await q.enqueue(cap("x"));
      expect(r.stored).toBe(false);
      expect(r.key).toBeDefined(); // IndexedDB still has it and will deliver it
      const broken = new CaptureQueue(`q${n++}`, outbox);
      const gone = Promise.reject(new Error("idb gone"));
      gone.catch(() => {});
      (broken as unknown as { db: Promise<unknown> }).db = gone;
      await expect(broken.enqueue(cap("y"))).rejects.toThrow();
    });

    it("notifies subscribers when the queue changes", async () => {
      const q = new CaptureQueue(`q${n++}`);
      const seen = vi.fn();
      const off = q.subscribe(seen);
      await q.enqueue(cap("x"));
      expect(seen).toHaveBeenCalled();
      seen.mockClear();
      off();
      await q.flush(async () => {});
      expect(seen).not.toHaveBeenCalled();
    });
  });
});

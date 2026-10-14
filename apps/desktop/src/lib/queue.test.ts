import "fake-indexeddb/auto";
import { ApiError, type CaptureInput } from "@pickynotes/shared";
import { describe, expect, it, vi } from "vitest";
import { CaptureQueue } from "./queue.js";

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

  it("concurrent flushes deliver each item once", async () => {
    const q = fresh();
    await q.enqueue(cap("a"));
    const send = vi.fn(async () => {});
    await Promise.all([q.flush(send), q.flush(send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

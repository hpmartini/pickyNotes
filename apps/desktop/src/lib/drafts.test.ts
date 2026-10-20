import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftSaver, draftChanges, restoreDrafts } from "./drafts";

const n = (id: string, text: string) => ({ id, text });

describe("restoreDrafts", () => {
  const state = { active: "a", notes: [n("a", "lokal")] };

  it("adds unknown notes and keeps the active one", () => {
    expect(restoreDrafts(state, [n("b", "von Platte")])).toEqual({ active: "a", notes: [n("a", "lokal"), n("b", "von Platte")] });
  });

  it("never replaces a note localStorage already has, even with different text", () => {
    expect(restoreDrafts(state, [n("a", "älter")])).toBe(state);
  });

  it("ignores empty drafts", () => {
    expect(restoreDrafts(state, [n("b", "  \n")])).toBe(state);
  });
});

describe("draftChanges", () => {
  it("writes new and changed non-empty notes, deletes the ones that disappeared", () => {
    expect(draftChanges([n("a", "x"), n("b", "y")], [n("a", "x2"), n("c", "neu")])).toEqual({ writes: [n("a", "x2"), n("c", "neu")], deletes: ["b"] });
  });

  it("never writes an empty text, so an emptied note keeps its old file", () => {
    expect(draftChanges([n("a", "x")], [n("a", "")])).toEqual({ writes: [], deletes: [] });
    expect(draftChanges([], [n("a", "   ")])).toEqual({ writes: [], deletes: [] });
  });
});

describe("createDraftSaver", () => {
  const store = { write: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  beforeEach(() => {
    vi.useFakeTimers();
    store.write.mockClear();
    store.remove.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("writes once, debounced, with the latest text", async () => {
    const s = createDraftSaver(store, 500);
    s.update([n("a", "h")]);
    s.update([n("a", "hallo")]);
    await vi.advanceTimersByTimeAsync(499);
    expect(store.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.write.mock.calls).toEqual([["a", "hallo"]]);
  });

  it("flush writes immediately", async () => {
    const s = createDraftSaver(store, 500);
    s.update([n("a", "hallo")]);
    await s.flush();
    expect(store.write.mock.calls).toEqual([["a", "hallo"]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it("closing or sending a note deletes its file and drops a write that was still waiting", async () => {
    const s = createDraftSaver(store, 500);
    s.update([n("a", "x"), n("b", "y")]);
    await s.flush();
    s.update([n("a", "x"), n("b", "y2")]);
    s.update([n("a", "x")]); // b closed before its debounced write
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.remove.mock.calls).toEqual([["b"]]);
    expect(store.write.mock.calls).toEqual([["a", "x"], ["b", "y"]]);
  });

  it("an emptied note neither writes nor deletes", async () => {
    const s = createDraftSaver(store, 500);
    s.update([n("a", "x")]);
    await s.flush();
    s.update([n("a", "")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("a failing write is reported and does not stop later ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.write.mockRejectedValueOnce(new Error("disk full"));
    const s = createDraftSaver(store, 500);
    s.update([n("a", "x")]);
    await s.flush();
    s.update([n("a", "xy")]);
    await s.flush();
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  describe("failed operations are kept and retried", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => void (warn = vi.spyOn(console, "warn").mockImplementation(() => {})));
    afterEach(() => warn.mockRestore());

    it("a failed write is written again by the next flush, without any new text", async () => {
      store.write.mockRejectedValueOnce(new Error("disk full"));
      const s = createDraftSaver(store, 500);
      s.update([n("a", "x")]);
      await s.flush();
      await s.flush();
      expect(store.write.mock.calls).toEqual([["a", "x"], ["a", "x"]]);
      await s.flush();
      expect(store.write).toHaveBeenCalledTimes(2); // done now
    });

    it("an update without a text change retries a failed write after the debounce", async () => {
      store.write.mockRejectedValueOnce(new Error("disk full"));
      const s = createDraftSaver(store, 500);
      const notes = [n("a", "x")];
      s.update(notes);
      await s.flush();
      s.update(notes);
      await vi.advanceTimersByTimeAsync(500);
      expect(store.write).toHaveBeenCalledTimes(2);
    });

    it("closing a note after a failed write: the delete comes last and the write is not retried behind it", async () => {
      store.write.mockRejectedValueOnce(new Error("disk full"));
      const s = createDraftSaver(store, 500);
      s.update([n("a", "x")]);
      await s.flush();
      s.update([]);
      await s.flush();
      await s.flush();
      expect(store.write).toHaveBeenCalledTimes(1);
      expect(store.remove.mock.calls).toEqual([["a"]]);
    });

    it("a failed delete is retried by the next flush", async () => {
      store.remove.mockRejectedValueOnce(new Error("busy"));
      const s = createDraftSaver(store, 500);
      s.update([n("a", "x")]);
      await s.flush();
      s.update([]);
      await s.flush();
      await s.flush();
      expect(store.remove.mock.calls).toEqual([["a"], ["a"]]);
    });

    it("a failed write holds back later operations until it succeeded", async () => {
      store.write.mockRejectedValueOnce(new Error("disk full"));
      const s = createDraftSaver(store, 500);
      s.update([n("a", "x"), n("b", "y")]);
      await s.flush();
      s.update([n("a", "x")]); // b closed while a's write is still failing
      await s.flush();
      const ordered = (m: typeof store.write | typeof store.remove, tag: string) => m.mock.calls.map((c: unknown[], i) => [m.mock.invocationCallOrder[i]!, `${tag}${c[0]}`] as const);
      const calls = [...ordered(store.write, "w"), ...ordered(store.remove, "d")];
      expect(calls.sort((x, y) => x[0] - y[0]).map((c) => c[1])).toEqual(["wa", "wa", "db"]);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOTKEYS } from "./settings";

type Handler = (e: { state: "Pressed" | "Released" }) => Promise<void>;
const sc = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), failFor: new Set<string>(), unregistered: [] as string[] }));
const win = vi.hoisted(() => ({ show: vi.fn(), unminimize: vi.fn(), setFocus: vi.fn(), hide: vi.fn(), visible: true, focused: true }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: async (key: string, h: Handler) => {
    if (sc.failFor.has(key) || sc.handlers.has(key)) throw new Error("already taken");
    sc.handlers.set(key, h);
  },
  unregister: async (key: string) => {
    sc.unregistered.push(key);
    sc.handlers.delete(key);
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ ...win, isVisible: async () => win.visible, isFocused: async () => win.focused }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { dictation: CTRL_ALT, toggle: CMD_SHIFT } = DEFAULT_HOTKEYS;

describe("applyHotkeys", () => {
  let events: CustomEvent[];
  const onEvent = (e: Event) => events.push(e as CustomEvent);
  let applyHotkeys: typeof import("./tauri").applyHotkeys;
  beforeEach(async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    sc.handlers.clear();
    sc.failFor.clear();
    sc.unregistered.length = 0;
    Object.assign(win, { visible: true, focused: true });
    events = [];
    window.addEventListener("picky:focus-capture", onEvent);
    ({ applyHotkeys } = await import("./tauri"));
    await applyHotkeys(null, DEFAULT_HOTKEYS);
  });
  afterEach(() => {
    window.removeEventListener("picky:focus-capture", onEvent);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("registers both defaults at startup", () => {
    expect([...sc.handlers.keys()]).toEqual([CMD_SHIFT, CTRL_ALT]);
  });

  it("dictation Pressed shows and focuses the window and fires picky:focus-capture with toggle", async () => {
    await sc.handlers.get(CTRL_ALT)!({ state: "Pressed" });
    expect([win.show, win.unminimize, win.setFocus].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(events.map((e) => e.detail)).toEqual([{ toggle: true }]);
  });

  it("show/hide Pressed hides a visible focused window, otherwise shows and focuses it", async () => {
    await sc.handlers.get(CMD_SHIFT)!({ state: "Pressed" });
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    for (const [visible, focused] of [[true, false], [false, false]]) {
      Object.assign(win, { visible, focused });
      await sc.handlers.get(CMD_SHIFT)!({ state: "Pressed" });
    }
    expect([win.hide, win.show, win.unminimize, win.setFocus].map((f) => f.mock.calls.length)).toEqual([1, 2, 2, 2]);
    expect(events.map((e) => e.detail)).toEqual([{ toggle: false }, { toggle: false }]);
  });

  it("ignores Released", async () => {
    await sc.handlers.get(CTRL_ALT)!({ state: "Released" });
    await sc.handlers.get(CMD_SHIFT)!({ state: "Released" });
    expect(win.show).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("overlapping changes run one after another and end with exactly the last request registered", async () => {
    const k = { ...DEFAULT_HOTKEYS, dictation: "Control+Alt+K" };
    const l = { ...DEFAULT_HOTKEYS, dictation: "Control+Alt+L" };
    // both calls carry the stale `prev` a reopened dialog would pass
    await Promise.all([applyHotkeys(DEFAULT_HOTKEYS, k), applyHotkeys(DEFAULT_HOTKEYS, l)]);
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, "Control+Alt+L"].sort());
  });

  it("a live change unregisters the old key and registers the new one; unchanged keys stay", async () => {
    sc.unregistered.length = 0;
    const next = { ...DEFAULT_HOTKEYS, dictation: "Control+Alt+K" };
    expect(await applyHotkeys(DEFAULT_HOTKEYS, next)).toEqual({ applied: next, errors: {} });
    expect(sc.unregistered).toEqual([CTRL_ALT]);
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, "Control+Alt+K"].sort());
    await sc.handlers.get("Control+Alt+K")!({ state: "Pressed" });
    expect(events.map((e) => e.detail)).toEqual([{ toggle: true }]);
  });

  it("a rejected key reports an error, restores the previous key and does not throw", async () => {
    sc.failFor.add("Control+Alt+K");
    const next = { ...DEFAULT_HOTKEYS, dictation: "Control+Alt+K" };
    const r = await applyHotkeys(DEFAULT_HOTKEYS, next);
    expect(r.applied).toEqual(DEFAULT_HOTKEYS);
    expect(r.errors).toEqual({ dictation: "already taken" });
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CTRL_ALT].sort());
  });

  it("at startup a taken key is reported, not thrown, and the other hotkey still registers", async () => {
    sc.handlers.clear();
    sc.failFor.add(CMD_SHIFT);
    const r = await applyHotkeys(null, DEFAULT_HOTKEYS);
    expect(r.errors).toEqual({ toggle: "already taken" });
    expect([...sc.handlers.keys()]).toEqual([CTRL_ALT]);
  });

  it("swapping the two keys (reset after a manual swap) unregisters both before registering either", async () => {
    const swapped = { dictation: CMD_SHIFT, toggle: CTRL_ALT };
    expect(await applyHotkeys(DEFAULT_HOTKEYS, swapped)).toEqual({ applied: swapped, errors: {} });
    expect(sc.unregistered.slice(-2).sort()).toEqual([CMD_SHIFT, CTRL_ALT].sort());
    await sc.handlers.get(CMD_SHIFT)!({ state: "Pressed" });
    expect(events.map((e) => e.detail)).toEqual([{ toggle: true }]); // CMD_SHIFT is now the dictation key
    expect(await applyHotkeys(swapped, DEFAULT_HOTKEYS)).toEqual({ applied: DEFAULT_HOTKEYS, errors: {} });
  });

  it("when one of two changes is rejected, the one that registered is dropped and both old keys come back", async () => {
    sc.failFor.add("Control+Alt+K");
    const next = { dictation: "Control+Alt+K", toggle: "CommandOrControl+Alt+J" };
    const r = await applyHotkeys(DEFAULT_HOTKEYS, next);
    expect(r).toEqual({ applied: DEFAULT_HOTKEYS, errors: { dictation: "already taken" } });
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CTRL_ALT].sort());
  });
});

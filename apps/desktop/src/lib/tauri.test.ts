import { invoke } from "@tauri-apps/api/core";
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

/** How often the window was brought to the front: Rust does the show/unminimize/focus plus the fullscreen-overlay settings. */
const shown = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "show_main_window").length;

const CTRL_ALT = DEFAULT_HOTKEYS.dictation.key;
const CMD_SHIFT = DEFAULT_HOTKEYS.toggle.key;
const CMD_K = DEFAULT_HOTKEYS.search.key;
/** The defaults with one hotkey changed. */
const set = (name: keyof typeof DEFAULT_HOTKEYS, change: Partial<{ key: string; enabled: boolean }>) => ({ ...DEFAULT_HOTKEYS, [name]: { ...DEFAULT_HOTKEYS[name], ...change } });

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

  it("registers all three defaults at startup", () => {
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CTRL_ALT, CMD_K].sort());
  });

  it("dictation Pressed shows and focuses the window and fires picky:focus-capture with toggle", async () => {
    await sc.handlers.get(CTRL_ALT)!({ state: "Pressed" });
    expect(shown()).toBe(1);
    expect(events.map((e) => e.detail)).toEqual([{ toggle: true }]);
  });

  it("show/hide Pressed hides a visible focused window, otherwise shows and focuses it", async () => {
    await sc.handlers.get(CMD_SHIFT)!({ state: "Pressed" });
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(shown()).toBe(0);
    for (const [visible, focused] of [[true, false], [false, false]]) {
      Object.assign(win, { visible, focused });
      await sc.handlers.get(CMD_SHIFT)!({ state: "Pressed" });
    }
    expect([win.hide.mock.calls.length, shown()]).toEqual([1, 2]);
    expect(events.map((e) => e.detail)).toEqual([{ toggle: false }, { toggle: false }]);
  });

  it("ignores Released", async () => {
    await sc.handlers.get(CTRL_ALT)!({ state: "Released" });
    await sc.handlers.get(CMD_SHIFT)!({ state: "Released" });
    expect(shown()).toBe(0);
    expect(win.hide).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("overlapping changes run one after another and end with exactly the last request registered", async () => {
    const k = set("dictation", { key: "Control+Alt+K" });
    const l = set("dictation", { key: "Control+Alt+L" });
    // both calls carry the stale `prev` a reopened dialog would pass
    await Promise.all([applyHotkeys(DEFAULT_HOTKEYS, k), applyHotkeys(DEFAULT_HOTKEYS, l)]);
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CMD_K, "Control+Alt+L"].sort());
  });

  it("a live change unregisters the old key and registers the new one; unchanged keys stay", async () => {
    sc.unregistered.length = 0;
    const next = set("dictation", { key: "Control+Alt+K" });
    expect(await applyHotkeys(DEFAULT_HOTKEYS, next)).toEqual({ applied: next, errors: {} });
    expect(sc.unregistered).toEqual([CTRL_ALT]);
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CMD_K, "Control+Alt+K"].sort());
    await sc.handlers.get("Control+Alt+K")!({ state: "Pressed" });
    expect(events.map((e) => e.detail)).toEqual([{ toggle: true }]);
  });

  it("a rejected key reports an error, restores the previous key and does not throw", async () => {
    sc.failFor.add("Control+Alt+K");
    const next = set("dictation", { key: "Control+Alt+K" });
    const r = await applyHotkeys(DEFAULT_HOTKEYS, next);
    expect(r.applied).toEqual(DEFAULT_HOTKEYS);
    expect(r.errors).toEqual({ dictation: "already taken" });
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CTRL_ALT, CMD_K].sort());
  });

  it("at startup a taken key is reported, not thrown, and the other hotkey still registers", async () => {
    sc.handlers.clear();
    sc.failFor.add(CMD_SHIFT);
    const r = await applyHotkeys(null, DEFAULT_HOTKEYS);
    expect(r.errors).toEqual({ toggle: "already taken" });
    expect([...sc.handlers.keys()].sort()).toEqual([CTRL_ALT, CMD_K].sort());
  });

  it("swapping the two keys (reset after a manual swap) unregisters both before registering either", async () => {
    const swapped = { ...DEFAULT_HOTKEYS, dictation: { key: CMD_SHIFT, enabled: true }, toggle: { key: CTRL_ALT, enabled: true } };
    expect(await applyHotkeys(DEFAULT_HOTKEYS, swapped)).toEqual({ applied: swapped, errors: {} });
    expect(sc.unregistered.slice(-2).sort()).toEqual([CMD_SHIFT, CTRL_ALT].sort());
    await sc.handlers.get(CMD_SHIFT)!({ state: "Pressed" });
    expect(events.map((e) => e.detail)).toEqual([{ toggle: true }]); // CMD_SHIFT is now the dictation key
    expect(await applyHotkeys(swapped, DEFAULT_HOTKEYS)).toEqual({ applied: DEFAULT_HOTKEYS, errors: {} });
  });

  it("when one of two changes is rejected, the one that registered is dropped and both old keys come back", async () => {
    sc.failFor.add("Control+Alt+K");
    const next = { ...DEFAULT_HOTKEYS, dictation: { key: "Control+Alt+K", enabled: true }, toggle: { key: "CommandOrControl+Alt+J", enabled: true } };
    const r = await applyHotkeys(DEFAULT_HOTKEYS, next);
    expect(r).toEqual({ applied: DEFAULT_HOTKEYS, errors: { dictation: "already taken" } });
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CTRL_ALT, CMD_K].sort());
  });

  it("search Pressed shows and focuses the window and opens search without closing it again via focus-capture", async () => {
    const opened: Event[] = [];
    const onOpen = (e: Event) => opened.push(e);
    window.addEventListener("picky:open-search", onOpen);
    await sc.handlers.get(CMD_K)!({ state: "Pressed" });
    window.removeEventListener("picky:open-search", onOpen);
    expect(shown()).toBe(1);
    expect(opened).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("disabling unregisters only that key; the combination stays remembered and enabling registers it again", async () => {
    sc.unregistered.length = 0;
    const off = set("search", { enabled: false });
    expect(await applyHotkeys(DEFAULT_HOTKEYS, off)).toEqual({ applied: off, errors: {} });
    expect(sc.unregistered).toEqual([CMD_K]);
    expect([...sc.handlers.keys()].sort()).toEqual([CMD_SHIFT, CTRL_ALT].sort());
    expect(await applyHotkeys(off, DEFAULT_HOTKEYS)).toEqual({ applied: DEFAULT_HOTKEYS, errors: {} });
    expect(sc.handlers.has(CMD_K)).toBe(true);
  });

  it("a disabled hotkey is not registered at startup and does not touch the OS", async () => {
    sc.handlers.clear();
    sc.unregistered.length = 0;
    const off = set("toggle", { enabled: false });
    expect(await applyHotkeys(null, off)).toEqual({ applied: off, errors: {} });
    expect([...sc.handlers.keys()].sort()).toEqual([CTRL_ALT, CMD_K].sort());
    expect(sc.unregistered).not.toContain(CMD_SHIFT);
  });

  it("enabling a key another app owns reports the error and rolls back to disabled", async () => {
    const off = set("search", { enabled: false });
    await applyHotkeys(DEFAULT_HOTKEYS, off);
    sc.failFor.add(CMD_K);
    const r = await applyHotkeys(off, DEFAULT_HOTKEYS);
    expect(r).toEqual({ applied: off, errors: { search: "already taken" } });
    expect(sc.handlers.has(CMD_K)).toBe(false);
  });

  it("a failed enable does not unregister the keys that were disabled before", async () => {
    const off = set("search", { enabled: false });
    await applyHotkeys(DEFAULT_HOTKEYS, off);
    sc.failFor.add("Control+Alt+K");
    sc.unregistered.length = 0;
    const r = await applyHotkeys(off, { ...off, dictation: { key: "Control+Alt+K", enabled: true }, search: { key: CMD_K, enabled: false } });
    expect(r.applied).toEqual(off);
    expect(sc.handlers.has(CTRL_ALT)).toBe(true);
  });
});

describe("tauriOutbox", () => {
  it("maps the outbox to the Rust commands and skips files that do not parse", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const good = { input: { kind: "text" as const, source: "typed" as const, text: "x", clientId: "c1" }, queuedAt: 1 };
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "outbox_list" ? [JSON.stringify(good), "{kaputt", JSON.stringify({ nope: 1 })] : null));
    const { tauriOutbox } = await import("./tauri");
    const outbox = tauriOutbox()!;
    expect(await outbox.list()).toEqual([good]);
    await outbox.write(good);
    await outbox.remove("c1");
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c !== "outbox_list")).toEqual([
      ["outbox_write", { clientId: "c1", json: JSON.stringify(good) }],
      ["outbox_delete", { clientId: "c1" }],
    ]);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(tauriOutbox()).toBeUndefined();
    vi.mocked(invoke).mockReset();
  });
});

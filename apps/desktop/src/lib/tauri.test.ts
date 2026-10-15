import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { state: "Pressed" | "Released" }) => Promise<void>;
const sc = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), failFor: "" }));
const win = vi.hoisted(() => ({ show: vi.fn(), unminimize: vi.fn(), setFocus: vi.fn() }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  isRegistered: async () => false,
  register: async (key: string, h: Handler) => {
    if (key === sc.failFor) throw new Error("already taken");
    sc.handlers.set(key, h);
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const CTRL_ALT = "Control+Alt+Space";
const CMD_SHIFT = "CommandOrControl+Shift+Space";

describe("registerHotkey", () => {
  let events: CustomEvent[];
  const onEvent = (e: Event) => events.push(e as CustomEvent);
  beforeEach(async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    sc.handlers.clear();
    sc.failFor = "";
    events = [];
    window.addEventListener("picky:focus-capture", onEvent);
    const { registerHotkey } = await import("./tauri");
    await registerHotkey();
  });
  afterEach(() => {
    window.removeEventListener("picky:focus-capture", onEvent);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("registers both shortcuts", () => {
    expect([...sc.handlers.keys()]).toEqual([CMD_SHIFT, CTRL_ALT]);
  });

  it.each([[CTRL_ALT, true], [CMD_SHIFT, false]])("%s Pressed shows and focuses the window and fires picky:focus-capture (toggle=%s)", async (key, toggle) => {
    await sc.handlers.get(key)!({ state: "Pressed" });
    expect([win.show, win.unminimize, win.setFocus].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(events.map((e) => e.detail)).toEqual([{ toggle }]);
  });

  it("ignores Released", async () => {
    await sc.handlers.get(CTRL_ALT)!({ state: "Released" });
    expect(win.show).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("logs and continues when a shortcut is taken by another app", async () => {
    sc.handlers.clear();
    sc.failFor = CMD_SHIFT;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registerHotkey } = await import("./tauri");
    await expect(registerHotkey()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect([...sc.handlers.keys()]).toEqual([CTRL_ALT]);
    warn.mockRestore();
  });
});

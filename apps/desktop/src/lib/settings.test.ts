import { afterEach, describe, expect, it } from "vitest";
import { clampTextWidth, DEFAULT_HOTKEYS, keydownToAccelerator, loadHotkeys, loadShell, loadTextWidth, saveHotkeys, saveShell, saveTextWidth } from "./settings";

const ev = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

afterEach(() => localStorage.clear());

describe("keydownToAccelerator", () => {
  it("orders the modifiers and maps letters, digits, Space, F-keys and punctuation from e.code", () => {
    expect(keydownToAccelerator(ev("KeyV", { ctrlKey: true, altKey: true }))).toBe("Control+Alt+V");
    expect(keydownToAccelerator(ev("Space", { shiftKey: true, metaKey: true }))).toBe("Command+Shift+Space");
    expect(keydownToAccelerator(ev("Digit7", { altKey: true }))).toBe("Alt+7");
    expect(keydownToAccelerator(ev("F5", { ctrlKey: true }))).toBe("Control+F5");
    expect(keydownToAccelerator(ev("Comma", { metaKey: true }))).toBe("Command+,");
    expect(keydownToAccelerator(ev("ArrowUp", { ctrlKey: true }))).toBe("Control+Up");
  });

  it("ignores modifier-only presses and combinations without Command/Control/Alt", () => {
    expect(keydownToAccelerator(ev("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(keydownToAccelerator(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(keydownToAccelerator(ev("KeyV"))).toBeNull();
    expect(keydownToAccelerator(ev("KeyV", { shiftKey: true }))).toBeNull();
  });
});

describe("stored settings", () => {
  it("hotkeys default, persist, and tolerate corrupt storage", () => {
    expect(loadHotkeys()).toEqual(DEFAULT_HOTKEYS);
    saveHotkeys({ ...DEFAULT_HOTKEYS, dictation: { key: "Control+Alt+K", enabled: true } });
    expect(loadHotkeys().dictation.key).toBe("Control+Alt+K");
    localStorage.setItem("picky.hotkeys", "{kaputt");
    expect(loadHotkeys()).toEqual(DEFAULT_HOTKEYS);
  });

  it("the search hotkey defaults to Cmd/Ctrl+Shift+K, enabled", () => {
    expect(loadHotkeys().search).toEqual({ key: "CommandOrControl+Shift+K", enabled: true });
  });

  it("remembers the combination and the enabled flag", () => {
    const off = { ...DEFAULT_HOTKEYS, toggle: { key: "Control+Alt+T", enabled: false } };
    saveHotkeys(off);
    expect(loadHotkeys()).toEqual(off);
  });

  it("migrates hotkeys stored as bare strings to enabled ones and adds the search default", () => {
    localStorage.setItem("picky.hotkeys", JSON.stringify({ dictation: "Control+Alt+K", toggle: "Control+Alt+J" }));
    expect(loadHotkeys()).toEqual({
      dictation: { key: "Control+Alt+K", enabled: true },
      toggle: { key: "Control+Alt+J", enabled: true },
      search: DEFAULT_HOTKEYS.search,
    });
  });

  it("text width defaults to full width, persists, and clamps to 400-2000", () => {
    expect(loadTextWidth()).toBeNull();
    saveTextWidth(900);
    expect(loadTextWidth()).toBe(900);
    saveTextWidth(null);
    expect(loadTextWidth()).toBeNull();
    saveTextWidth(100);
    expect(loadTextWidth()).toBe(400);
    saveTextWidth(99999);
    expect(loadTextWidth()).toBe(2000);
    localStorage.setItem("picky.textWidth", "50");
    expect(loadTextWidth()).toBe(400); // hand-edited storage is clamped on load too
    localStorage.setItem("picky.textWidth", "abc");
    expect(loadTextWidth()).toBeNull();
    expect([clampTextWidth(NaN), clampTextWidth(-5), clampTextWidth(1234.6)]).toEqual([800, 400, 1235]);
  });

  it("shell prefs default to Dock on, menu-bar icon off", () => {
    expect(loadShell()).toEqual({ dock: true, tray: false });
    saveShell({ dock: false, tray: true });
    expect(loadShell()).toEqual({ dock: false, tray: true });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOTKEYS, keydownToAccelerator, loadHotkeys, loadShell, saveHotkeys, saveShell } from "./settings";

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
    saveHotkeys({ dictation: "Control+Alt+K", toggle: DEFAULT_HOTKEYS.toggle });
    expect(loadHotkeys().dictation).toBe("Control+Alt+K");
    localStorage.setItem("picky.hotkeys", "{kaputt");
    expect(loadHotkeys()).toEqual(DEFAULT_HOTKEYS);
  });

  it("shell prefs default to Dock on, menu-bar icon off", () => {
    expect(loadShell()).toEqual({ dock: true, tray: false });
    saveShell({ dock: false, tray: true });
    expect(loadShell()).toEqual({ dock: false, tray: true });
  });
});

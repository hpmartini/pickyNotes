export interface Hotkeys {
  /** Toggles dictation (first press starts, second stops). */
  dictation: string;
  /** Hides the window when it is visible and focused, otherwise shows and focuses it. */
  toggle: string;
}

// Ctrl+Alt+V avoids macOS Ctrl+Alt+Space (input-source switch) and WhisperStorm's Option+Space push-to-talk.
export const DEFAULT_HOTKEYS: Hotkeys = { dictation: "Control+Alt+V", toggle: "CommandOrControl+Shift+Space" };

const HOTKEYS_KEY = "picky.hotkeys";
const SHELL_KEY = "picky.shell";

export function loadHotkeys(): Hotkeys {
  try {
    const p = JSON.parse(localStorage.getItem(HOTKEYS_KEY) ?? "null") as Partial<Hotkeys> | null;
    return { dictation: p?.dictation || DEFAULT_HOTKEYS.dictation, toggle: p?.toggle || DEFAULT_HOTKEYS.toggle };
  } catch {
    return DEFAULT_HOTKEYS;
  }
}

export function saveHotkeys(h: Hotkeys): void {
  try {
    localStorage.setItem(HOTKEYS_KEY, JSON.stringify(h));
  } catch {
    /* storage unavailable: applies for this session only */
  }
}

/** UI mirror of the Dock / menu-bar choice; the Rust side persists its own copy to apply at launch. */
export interface ShellPrefs {
  dock: boolean;
  tray: boolean;
}

export function loadShell(): ShellPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(SHELL_KEY) ?? "null") as Partial<ShellPrefs> | null;
    return { dock: p?.dock ?? true, tray: p?.tray ?? false };
  } catch {
    return { dock: true, tray: false };
  }
}

export function saveShell(s: ShellPrefs): void {
  try {
    localStorage.setItem(SHELL_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

const NAMED_KEYS: Record<string, string> = {
  Space: "Space", Enter: "Enter", Backspace: "Backspace", Tab: "Tab",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
};

/**
 * Key-capture field helper: a keydown becomes a global-shortcut accelerator ("Control+Alt+V").
 * Uses `e.code` (layout and Option-dead-key independent). Modifier-only presses and combinations
 * without Command/Control/Alt (a bare letter or Shift+letter would steal normal typing system-wide) give null.
 */
export function keydownToAccelerator(e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code : NAMED_KEYS[e.code];
  if (!key || !(e.metaKey || e.ctrlKey || e.altKey)) return null;
  return [e.metaKey && "Command", e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

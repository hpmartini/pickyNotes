/** The combination is remembered while the hotkey is off; `enabled: false` means it is not registered at all. */
export interface HotkeyConfig {
  key: string;
  enabled: boolean;
}
export interface Hotkeys {
  /** Toggles dictation (first press starts, second stops). */
  dictation: HotkeyConfig;
  /** Hides the window when it is visible and focused, otherwise shows and focuses it. */
  toggle: HotkeyConfig;
  /** Shows and focuses the window and opens the search panel. */
  search: HotkeyConfig;
}

// Ctrl+Alt+V avoids macOS Ctrl+Alt+Space (input-source switch) and WhisperStorm's Option+Space push-to-talk.
export const DEFAULT_HOTKEYS: Hotkeys = {
  dictation: { key: "Control+Alt+V", enabled: true },
  toggle: { key: "CommandOrControl+Shift+Space", enabled: true },
  search: { key: "CommandOrControl+Shift+K", enabled: true },
};

const HOTKEYS_KEY = "picky.hotkeys";
const SHELL_KEY = "picky.shell";
const WIDTH_KEY = "picky.textWidth";

export const TEXT_WIDTH = { min: 400, max: 2000, step: 20, initial: 800 };

/** Invalid or out-of-range input becomes the nearest valid width. */
export const clampTextWidth = (px: number): number => (Number.isFinite(px) ? Math.min(TEXT_WIDTH.max, Math.max(TEXT_WIDTH.min, Math.round(px))) : TEXT_WIDTH.initial);

/** Editor text column width in px; null = full width (default). */
export function loadTextWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null || raw === "full" || !Number.isFinite(Number(raw)) ? null : clampTextWidth(Number(raw));
  } catch {
    return null;
  }
}

export function saveTextWidth(px: number | null): void {
  try {
    localStorage.setItem(WIDTH_KEY, px === null ? "full" : String(clampTextWidth(px)));
  } catch {
    /* storage unavailable: applies for this session only */
  }
}

export function loadHotkeys(): Hotkeys {
  try {
    const p = JSON.parse(localStorage.getItem(HOTKEYS_KEY) ?? "null") as Record<string, unknown> | null;
    const one = (name: keyof Hotkeys): HotkeyConfig => {
      const v = p?.[name] as string | Partial<HotkeyConfig> | undefined;
      // Before the enabled flag, a hotkey was stored as the bare combination: those count as enabled.
      if (typeof v === "string") return { key: v || DEFAULT_HOTKEYS[name].key, enabled: true };
      return { key: v?.key || DEFAULT_HOTKEYS[name].key, enabled: v?.enabled !== false };
    };
    return { dictation: one("dictation"), toggle: one("toggle"), search: one("search") };
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

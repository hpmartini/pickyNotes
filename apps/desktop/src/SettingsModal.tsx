import { useState } from "react";
import { Dialog } from "./Dialog";
import { clampTextWidth, DEFAULT_HOTKEYS, DEFAULT_SHORTCUTS, keydownToAccelerator, loadHotkeys, loadShell, loadShortcuts, saveHotkeys, saveShell, saveShortcuts, TEXT_WIDTH, type Hotkeys, type ShellPrefs, type Shortcuts } from "./lib/settings";
import { applyHotkeys, setDockVisible, setTrayVisible, token, type HotkeyErrors } from "./lib/tauri";

export const URL_KEY = "picky.url";

const HOTKEY_LABELS: Record<keyof Hotkeys, string> = { dictation: "Diktat starten/stoppen", toggle: "App ein-/ausblenden", search: "Suche öffnen" };

/** Modal dialog opened with Cmd/Ctrl+, : server connection, global hotkeys, Dock and menu-bar icon. */
export function SettingsModal({ onClose, textWidth, onTextWidth }: { onClose: () => void; textWidth: number | null; onTextWidth: (px: number | null) => void }) {
  return (
    <Dialog title="Einstellungen" closeLabel="Einstellungen schließen" onClose={onClose}>
      <ServerForm />
      <HotkeySettings />
      <ShortcutSettings />
      <TextWidthSettings width={textWidth} onChange={onTextWidth} />
      <ShellSettings />
    </Dialog>
  );
}

const SHORTCUT_LABELS: Record<keyof Shortcuts, string> = {
  newTab: "Neuer Tab",
  closeTab: "Tab schließen",
  nextTab: "Nächster Tab",
  prevTab: "Vorheriger Tab",
  jumpTab: "Zu Tab 1–9 springen (Ziffer beliebig)",
  copyNote: "Notiz als Markdown kopieren",
};

/** Tab shortcuts: only while the window has focus, so no global registration and no clash with other apps. */
function ShortcutSettings() {
  const [keys, setKeys] = useState(loadShortcuts);
  const [errors, setErrors] = useState<Partial<Record<keyof Shortcuts, string>>>({});
  const apply = (next: Shortcuts) => (setKeys(next), saveShortcuts(next), setErrors({}));

  function capture(name: keyof Shortcuts, e: React.KeyboardEvent) {
    const plainTab = e.key === "Tab" && !(e.metaKey || e.ctrlKey || e.altKey); // keep keyboard navigation; Ctrl+Tab is recordable
    if (plainTab || e.key === "Escape") return; // Esc closes the dialog
    e.preventDefault();
    const acc = keydownToAccelerator(e.nativeEvent);
    if (!acc) return;
    if (name === "jumpTab" && !/\+\d$/.test(acc)) return setErrors({ [name]: "Eine Ziffer mit Modifier drücken, z. B. Strg+1" });
    const other = (Object.keys(keys) as (keyof Shortcuts)[]).find((o) => o !== name && keys[o] === acc);
    if (other) return setErrors({ [name]: `Schon belegt: ${SHORTCUT_LABELS[other]}` });
    apply({ ...keys, [name]: acc });
  }

  return (
    <fieldset>
      <legend>Tastenkürzel (im Fenster)</legend>
      {(Object.keys(SHORTCUT_LABELS) as (keyof Shortcuts)[]).map((name) => (
        <div key={name} className="shortcut-row" data-shortcut={name}>
          <span id={`shortcut-${name}`}>{SHORTCUT_LABELS[name]}</span>
          <input readOnly data-shortcut-capture aria-labelledby={`shortcut-${name}`} value={keys[name]} placeholder="—" aria-invalid={!!errors[name]} onKeyDown={(e) => capture(name, e)} />
          <button type="button" className="icon" title="Auf Standard zurücksetzen" aria-label={`Auf Standard: ${SHORTCUT_LABELS[name]}`} disabled={keys[name] === DEFAULT_SHORTCUTS[name]} onClick={() => apply({ ...keys, [name]: DEFAULT_SHORTCUTS[name] })}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" /></svg>
          </button>
          <button type="button" className="icon" title="Kürzel löschen" aria-label={`Löschen: ${SHORTCUT_LABELS[name]}`} disabled={!keys[name]} onClick={() => apply({ ...keys, [name]: "" })}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6L12 4M6.5 7v3.5M9.5 7v3.5" /></svg>
          </button>
          {errors[name] && <p role="alert" className="row-error">{errors[name]}</p>}
        </div>
      ))}
    </fieldset>
  );
}

function ServerForm() {
  const [url, setUrl] = useState(localStorage.getItem(URL_KEY) ?? "");
  const [tok, setTok] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <form
      aria-label="Server"
      onSubmit={async (e) => {
        e.preventDefault();
        localStorage.setItem(URL_KEY, url.trim());
        if (tok) await token.set(tok.trim());
        setTok("");
        setSaved(true);
      }}
    >
      <label>Server-URL <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://notes.example.net" /></label>
      <label>Geräte-Token <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="leer = unverändert" autoComplete="off" /></label>
      <button type="submit">Speichern</button>
      {saved && <p role="status">Gespeichert (Token im Schlüsselbund).</p>}
    </form>
  );
}

function HotkeySettings() {
  const [keys, setKeys] = useState(loadHotkeys);
  const [errors, setErrors] = useState<HotkeyErrors>({});
  const [pending, setPending] = useState(false);

  /** Applies live; a rejected key stays out (the previous one keeps working) and shows its error. */
  async function change(next: Hotkeys) {
    setPending(true); // a second change while this one is in flight would race on the registrations
    const { applied, errors } = await applyHotkeys(keys, next);
    setErrors(errors);
    setKeys(applied);
    saveHotkeys(applied);
    setPending(false);
  }

  function capture(name: keyof Hotkeys, e: React.KeyboardEvent) {
    if (e.key === "Tab" || e.key === "Escape") return; // keep keyboard navigation and Esc-to-close
    e.preventDefault();
    const acc = keydownToAccelerator(e.nativeEvent);
    if (!acc || acc === keys[name].key) return;
    const other = (Object.keys(keys) as (keyof Hotkeys)[]).find((o) => o !== name && keys[o].enabled && keys[o].key === acc);
    if (other) return setErrors({ [name]: `Schon belegt: ${HOTKEY_LABELS[other]}` });
    const field = e.currentTarget as HTMLElement;
    void change({ ...keys, [name]: { ...keys[name], key: acc } }).then(() => field.focus()); // disabling while pending dropped the focus
  }

  function toggleEnabled(name: keyof Hotkeys, enabled: boolean) {
    const clash = enabled && (Object.keys(keys) as (keyof Hotkeys)[]).find((o) => o !== name && keys[o].enabled && keys[o].key === keys[name].key);
    if (clash) return setErrors({ [name]: `Schon belegt: ${HOTKEY_LABELS[clash]}` });
    void change({ ...keys, [name]: { ...keys[name], enabled } });
  }

  return (
    <fieldset>
      <legend>Tastenkürzel (global)</legend>
      {(Object.keys(HOTKEY_LABELS) as (keyof Hotkeys)[]).map((name) => (
        <div key={name} className="shortcut-row" data-hotkey={name}>
          <label>
            <span id={`hotkey-${name}`}>{HOTKEY_LABELS[name]}</span>
            <input readOnly data-shortcut-capture disabled={pending} value={keys[name].key} onKeyDown={(e) => capture(name, e)} placeholder="Kombination drücken" aria-invalid={!!errors[name]} />
          </label>
          <label className="check"><input type="checkbox" aria-describedby={`hotkey-${name}`} disabled={pending} checked={keys[name].enabled} onChange={(e) => toggleEnabled(name, e.target.checked)} /> aktiv</label>
          {errors[name] && <p role="alert">{errors[name]}</p>}
        </div>
      ))}
      <button type="button" disabled={pending} onClick={() => void change(DEFAULT_HOTKEYS)}>Zurücksetzen</button>
    </fieldset>
  );
}

/** "Volle Breite" (default) or a custom column width in px; applied live by App. */
function TextWidthSettings({ width, onChange }: { width: number | null; onChange: (px: number | null) => void }) {
  const [text, setText] = useState(String(width ?? TEXT_WIDTH.initial));
  // Typing "800" passes through "8" and "80": only values in range are applied, the field is normalised on blur.
  const apply = (v: string) => {
    setText(v);
    const px = Number(v);
    if (v.trim() && px >= TEXT_WIDTH.min && px <= TEXT_WIDTH.max) onChange(Math.round(px));
  };
  return (
    <fieldset>
      <legend>Textbreite</legend>
      <label className="check"><input type="radio" name="text-width" checked={width === null} onChange={() => onChange(null)} /> Volle Breite</label>
      <label className="check"><input type="radio" name="text-width" checked={width !== null} onChange={() => onChange(clampTextWidth(Number(text)))} /> Eigene Breite</label>
      <label>
        Breite in px
        <input
          type="number"
          min={TEXT_WIDTH.min}
          max={TEXT_WIDTH.max}
          step={TEXT_WIDTH.step}
          value={text}
          disabled={width === null}
          onChange={(e) => apply(e.target.value)}
          onBlur={() => (setText(String(clampTextWidth(Number(text)))), onChange(clampTextWidth(Number(text))))}
        />
      </label>
    </fieldset>
  );
}

function ShellSettings() {
  const [shell, setShell] = useState(loadShell);
  const [error, setError] = useState("");

  async function change(next: ShellPrefs) {
    try {
      setError("");
      if (next.dock !== shell.dock) await setDockVisible(next.dock);
      if (next.tray !== shell.tray) await setTrayVisible(next.tray);
      setShell(next);
      saveShell(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <fieldset>
      <legend>Fenster</legend>
      <label className="check"><input type="checkbox" checked={shell.dock} onChange={(e) => void change({ ...shell, dock: e.target.checked })} /> Im Dock anzeigen</label>
      <label className="check"><input type="checkbox" checked={shell.tray} onChange={(e) => void change({ ...shell, tray: e.target.checked })} /> Menüleisten-Icon anzeigen</label>
      {!shell.dock && !shell.tray && <p role="alert">Ohne Dock und Menüleisten-Icon ist die App nur per Tastenkürzel erreichbar.</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

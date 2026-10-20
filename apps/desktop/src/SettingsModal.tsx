import { useState } from "react";
import { Dialog } from "./Dialog";
import { clampTextWidth, DEFAULT_HOTKEYS, keydownToAccelerator, loadHotkeys, loadShell, saveHotkeys, saveShell, TEXT_WIDTH, type Hotkeys, type ShellPrefs } from "./lib/settings";
import { applyHotkeys, setDockVisible, setTrayVisible, token, type HotkeyErrors } from "./lib/tauri";

export const URL_KEY = "picky.url";

const HOTKEY_LABELS: Record<keyof Hotkeys, string> = { dictation: "Diktat starten/stoppen", toggle: "App ein-/ausblenden", search: "Suche öffnen" };

/** Modal dialog opened with Cmd/Ctrl+, : server connection, global hotkeys, Dock and menu-bar icon. */
export function SettingsModal({ onClose, textWidth, onTextWidth }: { onClose: () => void; textWidth: number | null; onTextWidth: (px: number | null) => void }) {
  return (
    <Dialog title="Einstellungen" closeLabel="Einstellungen schließen" onClose={onClose}>
      <ServerForm />
      <HotkeySettings />
      <TextWidthSettings width={textWidth} onChange={onTextWidth} />
      <ShellSettings />
    </Dialog>
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
        <div key={name} data-hotkey={name}>
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

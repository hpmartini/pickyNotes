import { useEffect, useRef, useState } from "react";
import { DEFAULT_HOTKEYS, keydownToAccelerator, loadHotkeys, loadShell, saveHotkeys, saveShell, type Hotkeys, type ShellPrefs } from "./lib/settings";
import { applyHotkeys, setDockVisible, setTrayVisible, token, type HotkeyErrors } from "./lib/tauri";

export const URL_KEY = "picky.url";

/** Keeps Tab inside the dialog: wraps from the last control to the first and back. */
function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "Tab") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
  const edge = items[e.shiftKey ? 0 : items.length - 1];
  if (document.activeElement === edge || document.activeElement === e.currentTarget) {
    e.preventDefault();
    items[e.shiftKey ? items.length - 1 : 0]?.focus();
  }
}

const HOTKEY_LABELS: Record<keyof Hotkeys, string> = { dictation: "Diktat starten/stoppen", toggle: "App ein-/ausblenden" };

/** Modal dialog opened with Cmd/Ctrl+, : server connection, global hotkeys, Dock and menu-bar icon. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  // once: onClose changes identity on every App render and must not steal focus again
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} className="dialog" onKeyDown={trapTab}>
        <header>
          <h2 id="settings-title">Einstellungen</h2>
          <button onClick={onClose} aria-label="Einstellungen schließen">×</button>
        </header>
        <ServerForm />
        <HotkeySettings />
        <ShellSettings />
      </div>
    </div>
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
    if (!acc || acc === keys[name]) return;
    const other = name === "toggle" ? "dictation" : "toggle";
    if (acc === keys[other]) return setErrors({ [name]: `Schon belegt: ${HOTKEY_LABELS[other]}` });
    const field = e.currentTarget as HTMLElement;
    void change({ ...keys, [name]: acc }).then(() => field.focus()); // disabling while pending dropped the focus
  }

  return (
    <fieldset>
      <legend>Tastenkürzel (global)</legend>
      {(Object.keys(HOTKEY_LABELS) as (keyof Hotkeys)[]).map((name) => (
        <div key={name}>
          <label>
            {HOTKEY_LABELS[name]}
            <input readOnly data-shortcut-capture disabled={pending} value={keys[name]} onKeyDown={(e) => capture(name, e)} placeholder="Kombination drücken" aria-invalid={!!errors[name]} />
          </label>
          {errors[name] && <p role="alert">{errors[name]}</p>}
        </div>
      ))}
      <button type="button" disabled={pending} onClick={() => void change(DEFAULT_HOTKEYS)}>Zurücksetzen</button>
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

import { createClient, type PickyClient } from "@pickynotes/shared";
import { useEffect, useMemo, useState } from "react";
import { CaptureView } from "./CaptureView";
import { addNote, closeNote, loadNotes, noteTitle, saveNotes, setNoteText } from "./lib/notes";
import { CaptureQueue } from "./lib/queue";
import { loadHotkeys } from "./lib/settings";
import { applyHotkeys, inTauri, screenshot, token } from "./lib/tauri";
import { SearchView } from "./SearchView";
import { SettingsModal, URL_KEY } from "./SettingsModal";

async function client(): Promise<PickyClient> {
  const baseUrl = localStorage.getItem(URL_KEY);
  const t = await token.get();
  if (!baseUrl || !t) throw new Error("Bitte zuerst Server-URL und Token in den Einstellungen setzen.");
  return createClient({ baseUrl, token: t });
}

export function App() {
  const [notes, setNotes] = useState(loadNotes);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hotkey, setHotkey] = useState<{ toggle: boolean } | null>(null);
  const queue = useMemo(() => new CaptureQueue(), []);
  const send = async (i: Parameters<PickyClient["capture"]>[0]) => (await client()).capture(i);

  useEffect(() => void saveNotes(notes), [notes]);

  useEffect(() => {
    void applyHotkeys(null, loadHotkeys()).then(({ errors }) => Object.keys(errors).length && console.warn("Hotkeys nicht registriert:", errors));
    // Here, not in CaptureView: only App can close the search panel. CaptureView stays mounted so a running recording survives tab switches.
    const onHotkey = (e: Event) => (setSearchOpen(false), setHotkey({ toggle: !!(e as CustomEvent).detail?.toggle }));
    window.addEventListener("picky:focus-capture", onHotkey);
    // Capture phase: CodeMirror's mac keymap binds Ctrl-n and would swallow it while the editor has focus.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if ((e.target as Element | null)?.closest?.("[data-shortcut-capture]")) return; // recording a hotkey, not using one
      if (e.key === ",") (e.preventDefault(), setSettingsOpen(true));
      else if (e.key.toLowerCase() === "n") (e.preventDefault(), setNotes(addNote));
    };
    window.addEventListener("keydown", onKey, true);
    const flush = () => void queue.flush(send).catch(() => {});
    window.addEventListener("online", flush);
    const timer = setInterval(flush, 30_000);
    flush();
    // The tray menu entry "Einstellungen" (Rust) asks the webview to open the dialog.
    const unlisten = inTauri() ? import("@tauri-apps/api/event").then((m) => m.listen("picky:open-settings", () => setSettingsOpen(true))) : undefined;
    return () => {
      window.removeEventListener("picky:focus-capture", onHotkey);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("online", flush);
      clearInterval(timer);
      void unlisten?.then((f) => f());
    };
  }, [queue]);

  return (
    <main>
      <header className="topbar" data-tauri-drag-region>
        <div role="tablist" aria-label="Notizen" data-tauri-drag-region>
          {notes.notes.map((n) => (
            <div key={n.id} role="presentation" className="tab" data-active={n.id === notes.active}>
              <button role="tab" aria-selected={n.id === notes.active} onClick={() => setNotes((s) => ({ ...s, active: n.id }))}>{noteTitle(n.text)}</button>
              <button className="close" aria-label="Notiz schließen" onClick={() => setNotes((s) => closeNote(s, n.id))}>×</button>
            </div>
          ))}
        </div>
        <button className="icon" aria-label="Neue Notiz" title="Neue Notiz (Strg/Cmd+N)" onClick={() => setNotes(addNote)}>+</button>
        <span className="spacer" data-tauri-drag-region />
        <button className="icon" aria-label="Suche" onClick={() => setSearchOpen(true)}>⌕</button>
        <button className="icon" aria-label="Einstellungen" title="Einstellungen (Strg/Cmd+,)" onClick={() => setSettingsOpen(true)}>⚙</button>
      </header>
      <CaptureView
        queue={queue}
        send={send}
        screenshot={screenshot}
        hotkey={hotkey}
        onHotkeyHandled={() => setHotkey(null)}
        notes={notes.notes}
        activeId={notes.active}
        onChange={(text) => setNotes((s) => setNoteText(s, s.active, text))}
        onSent={(id) => setNotes((s) => closeNote(s, id))}
      />
      {searchOpen && (
        <div className="panel">
          <button className="close-panel" onClick={() => setSearchOpen(false)}>Suche schließen</button>
          <SearchView search={async (q) => (await (await client()).search(q)).hits} />
        </div>
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

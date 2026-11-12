import { createClient, type PickyClient } from "@pickynotes/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { CaptureView } from "./CaptureView";
import { activeNote, addNote, closeNote, jumpNote, loadNotes, newNote, noteTitle, saveNotes, setNoteText, stepNote, type NotesState } from "./lib/notes";
import { CaptureQueue } from "./lib/queue";
import { jumpIndex, keydownToAccelerator, loadHotkeys, loadShortcuts, loadTextWidth, saveTextWidth } from "./lib/settings";
import { applyHotkeys, inTauri, openIcs, revealOutbox, screenshot, setCornerRadius, tauriDrafts, tauriOutbox, token, vaultPost, vaultToken, vaultWrite } from "./lib/tauri";
import { getAttachment } from "./lib/attachments";
import { loadVaultConfig, retryQueued, sendNote, vaultStatusLine, type VaultDeps, type VaultSync } from "./lib/vault";
import { createDraftSaver, restoreDrafts } from "./lib/drafts";
import { SearchView } from "./SearchView";
import { SettingsModal, URL_KEY } from "./SettingsModal";

async function client(): Promise<PickyClient> {
  const baseUrl = localStorage.getItem(URL_KEY);
  const t = await token.get();
  if (!baseUrl || !t) throw new Error("Bitte zuerst Server-URL und Token in den Einstellungen setzen.");
  return createClient({ baseUrl, token: t });
}

const vaultDeps: VaultDeps = { post: vaultPost, hasToken: vaultToken.has, attachment: getAttachment };
const vaultSync: VaultSync = {
  send: (id, text) => sendNote(loadVaultConfig(), vaultDeps, id, text),
  auto: () => loadVaultConfig().auto,
  status: (id) => vaultStatusLine(id),
};

const configured = async () => !!localStorage.getItem(URL_KEY) && !!(await token.get());

export function App() {
  const [notes, setNotes] = useState(loadNotes);
  // Whether the window has the keyboard: the frame lights up in the accent colour, an unfocused window is dimmed.
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    // The native key-window state is the reliable source for the non-activating panel; the DOM events cover the browser and tests.
    const native = inTauri() ? import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().onFocusChanged((e) => setFocused(e.payload))).catch(() => undefined) : undefined;
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
      void native?.then((unlisten) => unlisten?.());
    };
  }, []);
  // Queued vault sends (500, offline) go out again at start and every minute.
  useEffect(() => {
    if (!inTauri()) return;
    const run = () => void retryQueued(loadVaultConfig(), vaultDeps).catch(() => undefined);
    run();
    const t = window.setInterval(run, 60_000);
    return () => window.clearInterval(t);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [textWidth, setTextWidth] = useState(loadTextWidth);
  const [hotkey, setHotkey] = useState<{ toggle: boolean } | null>(null);
  const queue = useMemo(() => new CaptureQueue("pickynotes-queue", tauriOutbox()), []);
  const send = async (i: Parameters<PickyClient["capture"]>[0]) => (await client()).capture(i);

  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const modalOpen = settingsOpen || pendingOpen;
  const openSettings = () => (setPendingOpen(false), setSettingsOpen(true));
  const drafts = useMemo(() => tauriDrafts(), []);
  const saver = useMemo(() => drafts && createDraftSaver(drafts), [drafts]);

  useEffect(() => void saveNotes(notes), [notes]);
  useEffect(() => saver?.update(notes.notes), [saver, notes]);
  // Notes only the draft files have (localStorage lost) come back as tabs; existing notes are never replaced.
  useEffect(() => {
    void drafts?.list().then((d) => setNotes((s) => restoreDrafts(s, d)), (e) => console.warn("Entwürfe nicht lesbar:", e));
  }, [drafts]);
  useEffect(() => {
    if (!saver) return;
    const hide = () => document.visibilityState === "hidden" && void saver.flush();
    const unload = () => void saver.flush();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("beforeunload", unload);
    return () => (document.removeEventListener("visibilitychange", hide), window.removeEventListener("beforeunload", unload));
  }, [saver]);
  useEffect(() => void setCornerRadius(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-radius"))), []);
  // Badge count: everything in the queue that has not reached the server (waiting plus rejected).
  useEffect(() => {
    const refresh = () => void queue.list().then((l) => (setPendingCount(l.length), l.length || setPendingOpen(false)), () => {});
    refresh();
    return queue.subscribe(refresh);
  }, [queue]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  /** The active tab's text is the Markdown source, copied as is. */
  const copyActiveNote = async () => {
    try {
      await navigator.clipboard.writeText(activeNote(notesRef.current).text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 1600);
  };
  /** Persists first; on a failed write the state stays untouched and the caller keeps the queued copies. */
  const openAsNote = (text: string) => {
    const n = newNote(text);
    const next = { active: n.id, notes: [...notesRef.current.notes, n] };
    if (!saveNotes(next)) return false;
    notesRef.current = next;
    setNotes(next);
    return true;
  };
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modalOpen;
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  // Esc leaves the search (a modal on top keeps its own Esc) and puts the cursor back into the editor.
  useEffect(() => {
    if (!searchOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalOpenRef.current) return;
      setSearchOpen(false);
      setHotkey({ toggle: false });
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [searchOpen]);

  useEffect(() => {
    void applyHotkeys(null, loadHotkeys()).then(({ errors }) => Object.keys(errors).length && console.warn("Hotkeys nicht registriert:", errors));
    // Here, not in CaptureView: only App can close the search panel. CaptureView stays mounted so a running recording survives tab switches.
    const onHotkey = (e: Event) => modalOpenRef.current || (setSearchOpen(false), setHotkey({ toggle: !!(e as CustomEvent).detail?.toggle }));
    window.addEventListener("picky:focus-capture", onHotkey);
    // Already open: just put the cursor back into its input (a fresh mount focuses it itself).
    const openSearch = () => (searchOpenRef.current ? document.querySelector<HTMLInputElement>('[role="search"] input')?.focus() : setSearchOpen(true));
    const onOpenSearch = () => modalOpenRef.current || openSearch(); // global shortcut behind a modal: ignore
    window.addEventListener("picky:open-search", onOpenSearch);
    // Capture phase: CodeMirror's mac keymap binds Ctrl-n and would swallow it while the editor has focus.
    const onKey = (e: KeyboardEvent) => {
      const acc = keydownToAccelerator(e);
      const keys = loadShortcuts(); // configurable, may include Shift/Alt
      const jump = jumpIndex(acc, keys.jumpTab);
      const tabAction =
        acc === keys.newTab ? addNote
        : acc === keys.closeTab ? (s: NotesState) => closeNote(s, s.active)
        : acc === keys.nextTab ? (s: NotesState) => stepNote(s, 1)
        : acc === keys.prevTab ? (s: NotesState) => stepNote(s, -1)
        : jump !== null ? (s: NotesState) => jumpNote(s, jump)
        : null;
      const copy = !!acc && acc === keys.copyNote;
      if (!tabAction && !copy && (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey)) return;
      if (modalOpenRef.current) return tabAction || copy || e.key.toLowerCase() === "n" ? e.preventDefault() : undefined; // modal: no background actions
      if ((e.target as Element | null)?.closest?.("[data-shortcut-capture]")) return; // recording a hotkey, not using one
      if (tabAction) return (e.preventDefault(), setNotes(tabAction));
      if (copy) return (e.preventDefault(), void copyActiveNote());
      if (e.key === ",") (e.preventDefault(), setSettingsOpen(true));
      else if (e.key.toLowerCase() === "n") (e.preventDefault(), setNotes(addNote));
      else if (e.key.toLowerCase() === "k") (e.preventDefault(), openSearch());
    };
    window.addEventListener("keydown", onKey, true);
    const flush = () => void queue.flush(send).catch(() => {});
    window.addEventListener("online", flush);
    const timer = setInterval(flush, 30_000);
    flush();
    // The tray menu entry "Einstellungen" (Rust) asks the webview to open the dialog.
    const unlisten = inTauri() ? import("@tauri-apps/api/event").then((m) => m.listen("picky:open-settings", () => (setPendingOpen(false), setSettingsOpen(true)))) : undefined;
    return () => {
      window.removeEventListener("picky:focus-capture", onHotkey);
      window.removeEventListener("picky:open-search", onOpenSearch);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("online", flush);
      clearInterval(timer);
      void unlisten?.then((f) => f());
    };
  }, [queue]);

  return (
    <main data-focused={focused} style={{ "--pn-text-width": textWidth === null ? "none" : `${textWidth}px` } as React.CSSProperties}>
      <header className="topbar" data-tauri-drag-region inert={modalOpen}>
        <div role="tablist" aria-label="Notizen" data-tauri-drag-region>
          {notes.notes.map((n) => (
            <div key={n.id} role="presentation" className="tab" data-active={n.id === notes.active}>
              <button role="tab" aria-selected={n.id === notes.active} onClick={() => setNotes((s) => ({ ...s, active: n.id }))}>{noteTitle(n.text)}</button>
              <button className="close" aria-label="Notiz schließen" onClick={() => setNotes((s) => closeNote(s, n.id))}>×</button>
            </div>
          ))}
        </div>
        <button className="icon" aria-label="Neue Notiz" title="Neue Notiz (Cmd+T / Cmd+N)" onClick={() => setNotes(addNote)}>+</button>
        <span className="spacer" data-tauri-drag-region />
        {copied && <span role="status" className="toast">{copied === "ok" ? "Als Markdown kopiert" : "Kopieren fehlgeschlagen"}</span>}
        {pendingCount > 0 && (
          <button className="badge" aria-label={`Ausstehend: ${pendingCount}`} title="Ausstehende Notizen" onClick={() => setPendingOpen(true)}>{pendingCount}</button>
        )}
        <button className="icon" aria-label="Suche" onClick={() => setSearchOpen(true)}>⌕</button>
        <button className="icon" aria-label="Einstellungen" title="Einstellungen (Strg/Cmd+,)" onClick={openSettings}>⚙</button>
      </header>
      <CaptureView
        queue={queue}
        send={send}
        screenshot={screenshot}
        vault={inTauri() ? vaultWrite : undefined}
        vaultSync={inTauri() ? vaultSync : undefined}
        openIcs={inTauri() ? openIcs : undefined}
        configured={configured}
        onOpenAsNote={openAsNote}
        onRevealOutbox={inTauri() ? () => void revealOutbox() : undefined}
        hotkey={hotkey}
        onHotkeyHandled={() => setHotkey(null)}
        notes={notes.notes}
        activeId={notes.active}
        onChange={(text) => setNotes((s) => setNoteText(s, s.active, text))}
        onSent={(id) => setNotes((s) => closeNote(s, id))}
        inert={modalOpen}
        pendingOpen={pendingOpen}
        onClosePending={() => setPendingOpen(false)}
      />
      {searchOpen && (
        <div className="panel" inert={modalOpen}>
          <button className="close-panel" onClick={() => setSearchOpen(false)}>Suche schließen</button>
          <SearchView search={async (q) => (await (await client()).search(q)).hits} />
        </div>
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} textWidth={textWidth} onTextWidth={(px) => (setTextWidth(px), saveTextWidth(px))} />}
    </main>
  );
}

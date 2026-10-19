import "fake-indexeddb/auto";
import { ApiError } from "@pickynotes/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { CaptureView } from "./CaptureView";
import { CaptureQueue, type Outbox, type QueuedCapture } from "./lib/queue";

// CodeMirror needs real layout; a textarea stands in for the editor in jsdom.
// Like the real editor, it reads markdownSource only at mount and remounts when `documentId ?? markdownSource` changes.
const editorMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@atomic-editor/editor", async () => {
  const { useEffect } = await import("react");
  type P = { markdownSource: string; documentId?: string; onMarkdownChange: (s: string) => void };
  type H = { current: { getContentDOM: () => HTMLElement | null } | null };
  const Inner = ({ markdownSource, onMarkdownChange, editorHandleRef }: P & { editorHandleRef?: H }) => {
    useEffect(() => void editorMounts.count++, []);
    return (
      <textarea
        aria-label="Editor"
        defaultValue={markdownSource}
        onChange={(e) => onMarkdownChange(e.target.value)}
        ref={(el) => void (editorHandleRef && (editorHandleRef.current = { getContentDOM: () => el }))}
      />
    );
  };
  return {
    AtomicCodeMirrorEditor: (p: P & { editorHandleRef?: H }) => <Inner key={p.documentId ?? p.markdownSource} {...p} />,
    highlightMarkdown: {}, // imported by lib/editor.ts to build editorExtensions
    tables: () => [], // editor.ts uses atomicTables()
  };
});
vi.mock("@atomic-editor/editor/styles.css", () => ({}));
// whisperstorm falls through to the real browser fallback unless a test queues replies.
const ws = vi.hoisted(() => ({ replies: [] as Array<Record<string, unknown>>, calls: [] as string[] }));
vi.mock("./lib/tauri", async (orig) => {
  const real = await orig<typeof import("./lib/tauri")>();
  return { ...real, whisperstorm: (cmd: "start" | "stop" | "status") => (ws.calls.push(cmd), ws.replies.length ? Promise.resolve(ws.replies.shift()) : real.whisperstorm(cmd)) };
});

afterEach(() => (cleanup(), localStorage.clear(), (ws.calls.length = 0), (ws.replies.length = 0)));
let n = 0;

/** CaptureView is controlled by App; this keeps one note in state like App does. */
function Capture(p: Omit<ComponentProps<typeof CaptureView>, "notes" | "activeId" | "onChange" | "onSent">) {
  const [note, setNote] = useState({ id: "n1", text: "" });
  return <CaptureView {...p} notes={[note]} activeId={note.id} onChange={(text) => setNote({ ...note, text })} onSent={() => setNote({ id: crypto.randomUUID(), text: "" })} />;
}

describe("CaptureView", () => {
  it("shows the active note's text and reports edits for it", () => {
    const onChange = vi.fn();
    const notes = [{ id: "a", text: "eins" }, { id: "b", text: "zwei" }];
    const ui = (activeId: string) => <CaptureView queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} notes={notes} activeId={activeId} onChange={onChange} onSent={vi.fn()} />;
    const r = render(ui("a"));
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("eins");
    r.rerender(ui("b"));
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("zwei"); // switching notes remounts the editor with the other text
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "zwei!" } });
    expect(onChange).toHaveBeenCalledWith("zwei!");
  });

  it("a link that also sits in another open note keeps its attachment bytes after save", async () => {
    const { stashAttachment, getAttachment } = await import("./lib/attachments");
    const shared = await stashAttachment({ name: "a.pdf", mime: "application/pdf", bytes: new Uint8Array([1]) });
    const own = await stashAttachment({ name: "b.pdf", mime: "application/pdf", bytes: new Uint8Array([2]) });
    const onSent = vi.fn();
    const notes = [{ id: "a", text: `[a](${shared.markdownTarget}) [b](${own.markdownTarget})` }, { id: "b", text: `[a](${shared.markdownTarget})` }];
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={vi.fn(async () => ({ id: "1" }))} notes={notes} activeId="a" onChange={vi.fn()} onSent={onSent} />);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith("a"));
    expect(await getAttachment(shared.id)).toBeDefined();
    expect(await getAttachment(own.id)).toBeUndefined();
  });

  it("keeps the same editor instance (and focus) while typing", () => {
    editorMounts.count = 0;
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    const editor = screen.getByLabelText("Editor");
    for (const value of ["a", "ab", "abc"]) fireEvent.change(editor, { target: { value } });
    expect(screen.getByLabelText("Editor")).toBe(editor);
    expect(editorMounts.count).toBe(1);
  });

  it("sends typed text through the queue and clears the editor", async () => {
    const send = vi.fn(async () => ({ id: "1" }));
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={send} />);
    const save = screen.getByRole("button", { name: "Speichern" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "ein Gedanke" } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    expect(send).toHaveBeenCalledWith({ kind: "text", source: "typed", text: "ein Gedanke", clientId: expect.any(String) });
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("");
  });

  it("buffers offline and delivers on the next flush", async () => {
    const queue = new CaptureQueue(`c${n++}`);
    const send = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue({ id: "1" });
    render(<Capture queue={queue} send={send} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Offline gepuffert (1"));
    expect(await queue.flush(send)).toBe(1);
    expect(await queue.pending()).toBe(0);
  });

  it("uploads a picked file as an inline attachment in the next text capture", async () => {
    const send = vi.fn(async () => ({ id: "1" }));
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={send} />);
    // The mock editor ignores files it doesn't know about, so we set the value to the link the production path would insert, then click Save to flush the capture.
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "siehe [a.txt](pending:abc)" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "text", text: expect.stringContaining("pending:abc") }));
  });

  it("sends only the attachments the text still references, then drops the stash", async () => {
    const { stashAttachment, getAttachment } = await import("./lib/attachments");
    const kept = await stashAttachment({ name: "a.pdf", mime: "application/pdf", bytes: new Uint8Array([1, 2, 3]) });
    const stray = await stashAttachment({ name: "weg.png", mime: "image/png", bytes: new Uint8Array([9]) });
    const send = vi.fn(async () => ({ id: "1" }));
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={send} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: `siehe [a.pdf](${kept.markdownTarget})` } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ id: kept.id, name: "a.pdf", mime: "application/pdf", data: "AQID" }] }));
    expect(await getAttachment(kept.id)).toBeUndefined();
    expect(await getAttachment(stray.id)).toBeDefined(); // never referenced: stays until the user links it
  });

  it("after a save the stash keeps entries the live draft still links (the user kept typing during the send)", async () => {
    const { stashAttachment, getAttachment } = await import("./lib/attachments");
    const still = await stashAttachment({ name: "bleibt.pdf", mime: "application/pdf", bytes: new Uint8Array([1]) });
    const gone = await stashAttachment({ name: "weg.pdf", mime: "application/pdf", bytes: new Uint8Array([2]) });
    let finish!: () => void;
    const send = vi.fn(() => new Promise<{ id: string }>((resolve) => (finish = () => resolve({ id: "1" }))));
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={send} />);
    const sent = `[bleibt.pdf](${still.markdownTarget}) [weg.pdf](${gone.markdownTarget})`;
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: sent } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: `[bleibt.pdf](${still.markdownTarget}) weiter` } });
    finish();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    await waitFor(async () => expect(await getAttachment(gone.id)).toBeUndefined());
    expect(await getAttachment(still.id)).toBeDefined();
  });

  it("STT without a running WhisperStorm shows a clear message and does not switch to Stopp", async () => {
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "STT" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("WhisperStorm läuft nicht"));
    expect(screen.queryByRole("button", { name: "Stopp" })).toBeNull();
  });

  it("STT shows a pending state and disables the button while start is running", async () => {
    let reply!: (r: unknown) => void;
    ws.replies.push(new Promise((res) => (reply = res)) as never);
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "STT" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Starte Aufnahme…"));
    expect((screen.getByRole("button", { name: "STT" }) as HTMLButtonElement).disabled).toBe(true);
    reply({ ok: true, phase: "recording" });
    expect(await screen.findByRole("button", { name: "Stopp" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it.each([
    ["empty", "", "Kein Text erkannt – nichts eingefügt."],
    ["whitespace-only", " \n ", "Kein Text erkannt – nichts eingefügt."],
    ["non-empty", "Hallo Welt", "Transkript eingefügt."],
  ])("STT stop with %s transcript shows the matching message", async (_n, text, message) => {
    ws.replies.push({ ok: true, phase: "recording" }, { ok: true, phase: "success", text });
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "STT" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stopp" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(message));
    expect(screen.queryByRole("button", { name: "Stopp" })).toBeNull();
  });

  it("keeps the text the user typed while the send was pending", async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<{ id: string }>((resolve) => (finish = () => resolve({ id: "1" }))));
    render(<Capture queue={new CaptureQueue(`c${n++}`)} send={send} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "erster Gedanke" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "erster Gedanke und mehr" } });
    finish();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("erster Gedanke und mehr");
  });

  it("shows rejected captures as Abgelehnt, keeps the draft, and offers retry and discard", async () => {
    const queue = new CaptureQueue(`c${n++}`);
    const send = vi.fn().mockRejectedValueOnce(new ApiError(413, "too big")).mockResolvedValue({ id: "1" });
    render(<Capture queue={queue} send={send} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Abgelehnt: too big"));
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("x");
    expect((await queue.list())[0]).toMatchObject({ rejected: "too big" });
    const list = within(screen.getByRole("region", { name: "Abgelehnte Captures" }));
    expect(list.getByText(/too big/)).toBeTruthy();

    fireEvent.click(list.getByRole("button", { name: "Erneut senden" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    expect(screen.queryByRole("region", { name: "Abgelehnte Captures" })).toBeNull();
    expect(await queue.list()).toEqual([]);
    expect(send.mock.calls[1]![0].clientId).toBe(send.mock.calls[0]![0].clientId); // same capture, same id, so the server can dedupe

    const bad = new CaptureQueue(`c${n++}`);
    await bad.enqueue({ kind: "text", source: "typed", text: "alt" });
    await bad.flush(async () => Promise.reject(new ApiError(400, "invalid")));
    cleanup();
    render(<Capture queue={bad} send={send} />);
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Abgelehnte Captures" })).toBeNull());
    expect(await bad.list()).toEqual([]);
  });

  describe("Speichern never loses a note", () => {
    const fakeOutbox = (failWrite = false) => {
      const files = new Map<string, QueuedCapture>();
      const outbox: Outbox = {
        write: async (i) => (failWrite ? Promise.reject(new Error("disk full")) : void files.set(i.input.clientId!, i)),
        remove: async (id) => void files.delete(id),
        list: async () => [...files.values()],
      };
      return { files, outbox };
    };
    const save = (text: string) => {
      fireEvent.change(screen.getByLabelText("Editor"), { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    };
    const pendingList = () => within(screen.getByRole("region", { name: "Ausstehend" }));

    it("offline: the note leaves the editor but sits visibly in Ausstehend (1), in both stores", async () => {
      const { files, outbox } = fakeOutbox();
      const queue = new CaptureQueue(`c${n++}`, outbox);
      render(<Capture queue={queue} send={vi.fn().mockRejectedValue(new TypeError("offline"))} />);
      save("mein Gedanke");
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Offline gepuffert"));
      expect(screen.getByRole("heading", { name: "Ausstehend (1)" })).toBeTruthy();
      expect(pendingList().getByText(/mein Gedanke/)).toBeTruthy();
      expect((await queue.list()).map((i) => i.input.text)).toEqual(["mein Gedanke"]);
      expect([...files.values()].map((i) => i.input.text)).toEqual(["mein Gedanke"]);
    });

    it("missing server URL/token is detected before sending, said so, and the note waits in the Postausgang", async () => {
      const queue = new CaptureQueue(`c${n++}`);
      const send = vi.fn();
      render(<Capture queue={queue} send={send} configured={async () => false} />);
      save("ohne Server");
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Server-URL/Token fehlen – Notiz liegt im Postausgang"));
      expect(send).not.toHaveBeenCalled();
      expect(pendingList().getByText(/ohne Server/)).toBeTruthy();
      expect(await queue.pending()).toBe(1);
    });

    it("keeps the tab open when the outbox copy failed, even though IndexedDB has the note", async () => {
      const queue = new CaptureQueue(`c${n++}`, fakeOutbox(true).outbox);
      render(<Capture queue={queue} send={vi.fn().mockRejectedValue(new TypeError("offline"))} />);
      save("nur eine Kopie");
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Postausgang"));
      expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("nur eine Kopie");
    });

    it("keeps the tab open and shows an error when neither store worked", async () => {
      const queue = new CaptureQueue(`c${n++}`);
      vi.spyOn(queue, "enqueue").mockRejectedValue(new Error("idb gone"));
      render(<Capture queue={queue} send={vi.fn()} />);
      save("verloren?");
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("nicht gespeichert"));
      expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("verloren?");
    });

    it("a delivered note closes the tab even if the outbox write failed", async () => {
      const queue = new CaptureQueue(`c${n++}`, fakeOutbox(true).outbox);
      render(<Capture queue={queue} send={vi.fn(async () => ({ id: "1" }))} />);
      save("kam an");
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
      expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("");
    });

    it("Als Notiz öffnen restores the text into a new note and removes it from both stores", async () => {
      const { files, outbox } = fakeOutbox();
      const queue = new CaptureQueue(`c${n++}`, outbox);
      await queue.enqueue({ kind: "text", source: "typed", text: "zurück in den Editor" });
      const onOpenAsNote = vi.fn(() => true);
      render(<Capture queue={queue} send={vi.fn()} onOpenAsNote={onOpenAsNote} />);
      fireEvent.click(await screen.findByRole("button", { name: "Als Notiz öffnen" }));
      await waitFor(() => expect(onOpenAsNote).toHaveBeenCalledWith("zurück in den Editor"));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Ausstehend" })).toBeNull());
      expect(await queue.list()).toEqual([]);
      expect(files.size).toBe(0);
    });

    it("Als Notiz öffnen keeps both copies when the new tab could not be persisted, so a restart still has the note", async () => {
      const { files, outbox } = fakeOutbox();
      const queue = new CaptureQueue(`c${n++}`, outbox);
      await queue.enqueue({ kind: "text", source: "typed", text: "darf nicht verloren gehen" });
      const onOpenAsNote = vi.fn(() => false);
      render(<Capture queue={queue} send={vi.fn()} onOpenAsNote={onOpenAsNote} />);
      fireEvent.click(await screen.findByRole("button", { name: "Als Notiz öffnen" }));
      await waitFor(() => expect(onOpenAsNote).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/nicht gespeichert/));
      expect(await queue.list()).toHaveLength(1);
      expect(files.size).toBe(1);
      expect(await new CaptureQueue(`c${n++}`, outbox).list()).toHaveLength(1); // restart: restored from the outbox
    });

    it("Erneut senden delivers a pending note; Ordner zeigen reveals the outbox folder", async () => {
      const queue = new CaptureQueue(`c${n++}`);
      await queue.enqueue({ kind: "text", source: "typed", text: "wartet" });
      const send = vi.fn(async () => ({ id: "1" }));
      const reveal = vi.fn();
      render(<Capture queue={queue} send={send} onRevealOutbox={reveal} />);
      fireEvent.click(await screen.findByRole("button", { name: "Ordner zeigen" }));
      expect(reveal).toHaveBeenCalledTimes(1);
      fireEvent.click(pendingList().getByRole("button", { name: "Erneut senden" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Ausstehend" })).toBeNull());
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("the pending list also shows notes that a background flush delivers", async () => {
      const queue = new CaptureQueue(`c${n++}`);
      render(<Capture queue={queue} send={vi.fn()} />);
      await queue.enqueue({ kind: "text", source: "typed", text: "von außen" });
      expect(await screen.findByRole("heading", { name: "Ausstehend (1)" })).toBeTruthy();
      await queue.flush(async () => {});
      await waitFor(() => expect(screen.queryByRole("region", { name: "Ausstehend" })).toBeNull());
    });
  });

  describe("global hotkey request", () => {
    const mount = (hotkey: { toggle: boolean } | null, onHotkeyHandled = vi.fn()) => {
      const ui = (h: typeof hotkey) => <Capture queue={queue} send={vi.fn()} hotkey={h} onHotkeyHandled={onHotkeyHandled} />;
      const queue = new CaptureQueue(`c${n++}`);
      const r = render(ui(hotkey));
      return { onHotkeyHandled, press: (toggle: boolean) => r.rerender(ui({ toggle })) };
    };

    it("toggle:false focuses the editor, leaves WhisperStorm alone and reports handled", () => {
      const { onHotkeyHandled } = mount({ toggle: false });
      expect(document.activeElement).toBe(screen.getByLabelText("Editor"));
      expect(ws.calls).toEqual([]);
      expect(onHotkeyHandled).toHaveBeenCalledTimes(1);
    });

    it("toggle:true starts, a second request stops and inserts via the same path as the button", async () => {
      ws.replies.push({ ok: true, phase: "recording" }, { ok: true, phase: "success", text: "Hallo" });
      const { press } = mount({ toggle: true });
      expect(await screen.findByRole("button", { name: "Stopp" })).toBeTruthy();
      press(true);
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Transkript eingefügt."));
      expect(screen.getByRole("button", { name: "STT" })).toBeTruthy();
      expect(ws.calls).toEqual(["start", "stop"]);
    });

    it("a recording started by the hotkey is stopped by the next hotkey after a tab switch", async () => {
      ws.replies.push({ ok: true, phase: "recording" }, { ok: true, phase: "success", text: "Hallo" });
      render(<App />);
      const press = () => act(() => void window.dispatchEvent(new CustomEvent("picky:focus-capture", { detail: { toggle: true } })));
      press();
      expect(await screen.findByRole("button", { name: "Stopp" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Suche" }));
      fireEvent.click(screen.getByRole("button", { name: "Neue Notiz" })); // a new tab remounts the editor, not the recording
      expect(screen.getAllByRole("tab")).toHaveLength(2);
      press();
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Transkript eingefügt."));
      expect(ws.calls).toEqual(["start", "stop"]);
    });

    it("toggle:true without WhisperStorm shows the error in the status line", async () => {
      mount({ toggle: true });
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("WhisperStorm läuft nicht"));
    });

    it("a request while start is still pending does not start twice", async () => {
      let reply!: (r: unknown) => void;
      ws.replies.push(new Promise((res) => (reply = res)) as never);
      const { press } = mount({ toggle: true });
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Starte Aufnahme…"));
      press(true);
      reply({ ok: true, phase: "recording" });
      expect(await screen.findByRole("button", { name: "Stopp" })).toBeTruthy();
      expect(ws.calls).toEqual(["start"]);
    });
  });
});

describe("App shell", () => {
  it("Ctrl+, opens the settings dialog, Esc and the close button close it", () => {
    render(<App />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Einstellungen" })).toBeTruthy();
    expect(screen.getByLabelText("Server-URL")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Einstellungen" }));
    fireEvent.click(screen.getByRole("button", { name: "Einstellungen schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Settings and Suche are no tabs; Suche opens a closable panel", () => {
    render(<App />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Neue Notiz"]);
    fireEvent.click(screen.getByRole("button", { name: "Suche" }));
    expect(screen.getByRole("search")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suche schließen" }));
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("Ctrl+N opens a note tab, tabs switch the editor text, close removes a tab, the last is cleared", () => {
    localStorage.setItem("picky.draft", "# Erste");
    render(<App />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["# Erste"]); // legacy draft migrated into the first tab
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["# Erste", "Neue Notiz"]);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "Zweite" } });
    fireEvent.click(screen.getAllByRole("tab")[0]!);
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("# Erste");
    fireEvent.click(screen.getAllByRole("button", { name: "Notiz schließen" })[0]!);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Zweite"]);
    fireEvent.click(screen.getByRole("button", { name: "Notiz schließen" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Neue Notiz"]);
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("");
  });

  it("Cmd/Ctrl+K opens the search panel and focuses its input; again while open it refocuses", () => {
    render(<App />);
    expect(screen.queryByRole("search")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByLabelText("Suchbegriff");
    expect(document.activeElement).toBe(input);
    (screen.getByLabelText("Editor") as HTMLElement).focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(document.activeElement).toBe(input);
  });

  it("Cmd+K does nothing behind the settings dialog", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("the global search hotkey event opens the panel and keeps it open on a second press", () => {
    render(<App />);
    const press = () => act(() => void window.dispatchEvent(new CustomEvent("picky:open-search")));
    press();
    expect(document.activeElement).toBe(screen.getByLabelText("Suchbegriff"));
    press();
    expect(screen.getAllByRole("search")).toHaveLength(1);
  });

  describe("Settings: hotkey flags and Textbreite", () => {
    const open = () => (render(<App />), fireEvent.keyDown(window, { key: ",", ctrlKey: true }));
    /** The "aktiv" checkbox of one hotkey row. */
    const aktiv = (name: string) => within(document.querySelector(`[data-hotkey="${name}"]`) as HTMLElement).getByLabelText("aktiv") as HTMLInputElement;

    it("each of the three hotkeys has an aktiv checkbox; the flag is stored with the combination", async () => {
      open();
      expect((screen.getByLabelText("Suche öffnen") as HTMLInputElement).value).toBe("CommandOrControl+Shift+K");
      for (const name of ["dictation", "toggle", "search"]) expect(aktiv(name).checked).toBe(true);
      fireEvent.click(aktiv("search"));
      await waitFor(() => expect(JSON.parse(localStorage.getItem("picky.hotkeys")!).search).toEqual({ key: "CommandOrControl+Shift+K", enabled: false }));
      expect(aktiv("search").checked).toBe(false);
      expect((screen.getByLabelText("Suche öffnen") as HTMLInputElement).value).toBe("CommandOrControl+Shift+K"); // still remembered
      fireEvent.click(aktiv("search"));
      await waitFor(() => expect(JSON.parse(localStorage.getItem("picky.hotkeys")!).search.enabled).toBe(true));
    });

    it("a disabled hotkey stays disabled after reopening", async () => {
      localStorage.setItem("picky.hotkeys", JSON.stringify({ toggle: { key: "Control+Alt+T", enabled: false } }));
      open();
      expect(aktiv("toggle").checked).toBe(false);
      expect((screen.getByLabelText("App ein-/ausblenden") as HTMLInputElement).value).toBe("Control+Alt+T");
    });

    it("Textbreite: full width by default, a custom px width is applied live and stored, invalid input is clamped", async () => {
      const width = () => (document.querySelector("main") as HTMLElement).style.getPropertyValue("--pn-text-width");
      open();
      expect((screen.getByLabelText("Volle Breite") as HTMLInputElement).checked).toBe(true);
      expect(width()).toBe("none");
      fireEvent.click(screen.getByLabelText("Eigene Breite"));
      expect(width()).toBe("800px");
      const px = screen.getByLabelText("Breite in px") as HTMLInputElement;
      expect([px.min, px.max, px.step]).toEqual(["400", "2000", "20"]);
      fireEvent.change(px, { target: { value: "1000" } });
      expect(width()).toBe("1000px");
      expect(localStorage.getItem("picky.textWidth")).toBe("1000");
      fireEvent.change(px, { target: { value: "100" } }); // mid-typing: not applied yet
      expect(width()).toBe("1000px");
      fireEvent.blur(px);
      expect(width()).toBe("400px");
      expect(px.value).toBe("400");
      fireEvent.change(px, { target: { value: "5000" } });
      fireEvent.blur(px);
      expect(width()).toBe("2000px");
      fireEvent.click(screen.getByLabelText("Volle Breite"));
      expect(width()).toBe("none");
      expect(localStorage.getItem("picky.textWidth")).toBe("full");
    });

    it("a stored width is applied at startup", () => {
      localStorage.setItem("picky.textWidth", "640");
      render(<App />);
      expect((document.querySelector("main") as HTMLElement).style.getPropertyValue("--pn-text-width")).toBe("640px");
    });
  });
});

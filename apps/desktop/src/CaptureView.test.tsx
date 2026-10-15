import "fake-indexeddb/auto";
import { ApiError } from "@pickynotes/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { CaptureView } from "./CaptureView";
import { CaptureQueue } from "./lib/queue";

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

describe("CaptureView", () => {
  it("restores the draft after the view is unmounted and mounted again", () => {
    const queue = new CaptureQueue(`c${n++}`);
    const first = render(<CaptureView queue={queue} send={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "- Entwurf" } });
    first.unmount();
    render(<CaptureView queue={queue} send={vi.fn()} />);
    expect((screen.getByLabelText("Editor") as HTMLTextAreaElement).value).toBe("- Entwurf");
  });

  it("keeps the same editor instance (and focus) while typing", () => {
    editorMounts.count = 0;
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    const editor = screen.getByLabelText("Editor");
    for (const value of ["a", "ab", "abc"]) fireEvent.change(editor, { target: { value } });
    expect(screen.getByLabelText("Editor")).toBe(editor);
    expect(editorMounts.count).toBe(1);
  });

  it("sends typed text through the queue and clears the editor", async () => {
    const send = vi.fn(async () => ({ id: "1" }));
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={send} />);
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
    render(<CaptureView queue={queue} send={send} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Offline gepuffert (1"));
    expect(await queue.flush(send)).toBe(1);
    expect(await queue.pending()).toBe(0);
  });

  it("uploads a picked file as an inline attachment in the next text capture", async () => {
    const send = vi.fn(async () => ({ id: "1" }));
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={send} />);
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
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={send} />);
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
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={send} />);
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
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "STT" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("WhisperStorm läuft nicht"));
    expect(screen.queryByRole("button", { name: "Stopp" })).toBeNull();
  });

  it("STT shows a pending state and disables the button while start is running", async () => {
    let reply!: (r: unknown) => void;
    ws.replies.push(new Promise((res) => (reply = res)) as never);
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
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
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "STT" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stopp" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(message));
    expect(screen.queryByRole("button", { name: "Stopp" })).toBeNull();
  });

  it("keeps the text the user typed while the send was pending", async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<{ id: string }>((resolve) => (finish = () => resolve({ id: "1" }))));
    render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={send} />);
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
    render(<CaptureView queue={queue} send={send} />);
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
    render(<CaptureView queue={bad} send={send} />);
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Abgelehnte Captures" })).toBeNull());
    expect(await bad.list()).toEqual([]);
  });

  describe("global hotkey request", () => {
    const mount = (hotkey: { toggle: boolean } | null, onHotkeyHandled = vi.fn()) => {
      const ui = (h: typeof hotkey) => <CaptureView queue={queue} send={vi.fn()} hotkey={h} onHotkeyHandled={onHotkeyHandled} />;
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

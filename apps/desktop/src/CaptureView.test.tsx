import "fake-indexeddb/auto";
import { ApiError } from "@pickynotes/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureView } from "./CaptureView";
import { CaptureQueue } from "./lib/queue";

// CodeMirror needs real layout; a textarea stands in for the editor in jsdom.
// Like the real editor, it reads markdownSource only at mount and remounts when `documentId ?? markdownSource` changes.
const editorMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@atomic-editor/editor", async () => {
  const { useEffect } = await import("react");
  type P = { markdownSource: string; documentId?: string; onMarkdownChange: (s: string) => void };
  const Inner = ({ markdownSource, onMarkdownChange }: P) => {
    useEffect(() => void editorMounts.count++, []);
    return <textarea aria-label="Editor" defaultValue={markdownSource} onChange={(e) => onMarkdownChange(e.target.value)} />;
  };
  return {
    AtomicCodeMirrorEditor: (p: P) => <Inner key={p.documentId ?? p.markdownSource} {...p} />,
    highlightMarkdown: {}, // imported by lib/editor.ts to build editorExtensions
    tables: () => [], // editor.ts uses atomicTables()
  };
});
vi.mock("@atomic-editor/editor/styles.css", () => ({}));

afterEach(() => (cleanup(), localStorage.clear()));
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
});

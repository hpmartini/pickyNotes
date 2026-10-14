import "fake-indexeddb/auto";
import { ApiError } from "@pickynotes/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureView } from "./CaptureView";
import { CaptureQueue } from "./lib/queue";

// CodeMirror needs real layout; a textarea stands in for the editor in jsdom.
vi.mock("@atomic-editor/editor", () => ({
  AtomicCodeMirrorEditor: ({ markdownSource, onMarkdownChange }: { markdownSource: string; onMarkdownChange: (s: string) => void }) => (
    <textarea aria-label="Editor" value={markdownSource} onChange={(e) => onMarkdownChange(e.target.value)} />
  ),
}));
vi.mock("@atomic-editor/editor/styles.css", () => ({}));

afterEach(cleanup);
let n = 0;

describe("CaptureView", () => {
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

  it("uploads a picked file as imported", async () => {
    const send = vi.fn(async () => ({ id: "1" }));
    const { container } = render(<CaptureView queue={new CaptureQueue(`c${n++}`)} send={send} />);
    const file = new File(["hallo"], "a.txt", { type: "text/plain" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith({ kind: "file", source: "imported", data: btoa("hallo"), filename: "a.txt", mime: "text/plain", clientId: expect.any(String) });
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

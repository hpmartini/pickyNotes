import "fake-indexeddb/auto";
import { ApiError } from "@pickynotes/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(send).toHaveBeenCalledWith({ kind: "text", source: "typed", text: "ein Gedanke" });
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
    expect(send).toHaveBeenCalledWith({ kind: "file", source: "imported", data: btoa("hallo"), filename: "a.txt", mime: "text/plain" });
  });

  it("parks permanently rejected captures instead of retrying forever", async () => {
    const queue = new CaptureQueue(`c${n++}`);
    render(<CaptureView queue={queue} send={async () => Promise.reject(new ApiError(413, "too big"))} />);
    fireEvent.change(screen.getByLabelText("Editor"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gesendet"));
    expect((await queue.list())[0]).toMatchObject({ rejected: "too big" });
  });
});

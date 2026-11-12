import { describe, expect, it } from "vitest";
import { audioExt, audioLabel, formatDuration, pickRecorderMime, transcriptChange, transcriptLineAfter } from "./audio-blocks";

const link = "[🎙 Aufnahme 2026-10-21 14:03 (3:12)](pending:rec-1)";

describe("audio block helpers", () => {
  it("formats durations as m:ss and caps the label at 10:00", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(192)).toBe("3:12");
    expect(formatDuration(600)).toBe("10:00");
    expect(audioLabel(new Date(2026, 9, 21, 14, 3), 192)).toBe("🎙 Aufnahme 2026-10-21 14:03 (3:12)");
    expect(audioLabel(new Date(2026, 9, 21, 14, 3), 9999)).toContain("(10:00)");
  });

  it("prefers audio/mp4, falls back to webm/opus, else lets the browser choose", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/mp4");
    expect(pickRecorderMime((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((t) => t === "audio/webm")).toBe("audio/webm");
    expect(pickRecorderMime(() => false)).toBeUndefined();
    expect(audioExt("audio/mp4")).toBe("m4a");
    expect(audioExt("audio/webm;codecs=opus")).toBe("webm");
  });

  it("inserts the transcript as a quote line below the link, one line, with a blank line before following text", () => {
    expect(transcriptChange(link, "rec-1", "Hallo\nWelt")).toEqual({ from: link.length, to: link.length, insert: "\n> Transkript: Hallo Welt" });
    const doc = `${link}\nweiter`;
    expect(transcriptChange(doc, "rec-1", "x")).toEqual({ from: link.length, to: link.length, insert: "\n> Transkript: x\n" });
  });

  it("replaces an existing transcript line instead of adding a second one", () => {
    const doc = `vorher\n${link}\n> Transkript: alt\n\nnachher`;
    const c = transcriptChange(doc, "rec-1", "neu")!;
    expect(doc.slice(0, c.from) + c.insert + doc.slice(c.to)).toBe(`vorher\n${link}\n> Transkript: neu\n\nnachher`);
    const end = doc.indexOf(link) + link.length;
    expect(transcriptLineAfter(doc, end)?.text).toBe("alt");
  });

  it("returns null when the block is gone or belongs to another recording", () => {
    expect(transcriptChange("nur Text", "rec-1", "x")).toBeNull();
    expect(transcriptChange(link, "rec-2", "x")).toBeNull();
  });
});

describe("audio block state across an app restart (#5)", () => {
  it("keeps collapse state and error text, drops what belongs to the run", async () => {
    const m = await import("./audio-blocks");
    localStorage.clear();
    m.reloadAudioInfos();
    m.patchAudio("rec-a", { collapsed: true });
    m.patchAudio("rec-b", { transcribing: true });
    m.patchAudio("rec-b", { transcribing: false, error: "WhisperStorm läuft nicht" });
    m.patchAudio("rec-c", { playing: true });
    expect(JSON.parse(localStorage.getItem(m.AUDIO_INFO_KEY)!)).toEqual({ "rec-a": { collapsed: true }, "rec-b": { error: "WhisperStorm läuft nicht" } });

    m.reloadAudioInfos(); // the app starts again
    expect(m.audioInfo("rec-a")).toEqual({ collapsed: true });
    expect(m.audioInfo("rec-b")).toEqual({ error: "WhisperStorm läuft nicht" });
    expect(m.audioInfo("rec-c")).toEqual({});

    m.patchAudio("rec-a", { collapsed: false });
    m.patchAudio("rec-b", { transcribing: true, error: undefined }); // retry clears the stored error
    expect(JSON.parse(localStorage.getItem(m.AUDIO_INFO_KEY)!)).toEqual({});
  });

  it("survives broken stored state and caps the list", async () => {
    const m = await import("./audio-blocks");
    localStorage.setItem(m.AUDIO_INFO_KEY, "{not json");
    m.reloadAudioInfos();
    expect(m.audioInfo("x")).toEqual({});
    localStorage.setItem(m.AUDIO_INFO_KEY, JSON.stringify({ a: { collapsed: "yes", error: 5 }, b: null, c: { error: "kaputt" } }));
    m.reloadAudioInfos();
    expect(m.audioInfo("a")).toEqual({});
    expect(m.audioInfo("c")).toEqual({ error: "kaputt" });
    for (let i = 0; i < 205; i++) m.patchAudio(`r${i}`, { collapsed: true });
    const stored = Object.keys(JSON.parse(localStorage.getItem(m.AUDIO_INFO_KEY)!));
    expect(stored).toHaveLength(200);
    expect(stored).not.toContain("c");
    expect(stored.at(-1)).toBe("r204");
  });
});

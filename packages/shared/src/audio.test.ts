import { describe, expect, it } from "vitest";
import { AUDIO_MAX_SECONDS, AUDIO_MIME_TYPES, CaptureInput, isAudioMime } from "./index.js";

describe("audio", () => {
  it("accepts the supported containers, with or without codec parameters", () => {
    for (const m of AUDIO_MIME_TYPES) expect(isAudioMime(m)).toBe(true);
    expect(isAudioMime("audio/webm;codecs=opus")).toBe(true);
    expect(isAudioMime("Audio/MP4")).toBe(true);
    expect(isAudioMime("video/mp4")).toBe(false);
    expect(isAudioMime("application/pdf")).toBe(false);
  });
  it("caps recordings at 10 minutes", () => expect(AUDIO_MAX_SECONDS).toBe(600));
  it("an audio attachment is a valid CaptureAttachment", () => {
    const r = CaptureInput.safeParse({ kind: "text", source: "typed", text: "[x](pending:a)", attachments: [{ id: "a", name: "aufnahme.m4a", mime: "audio/mp4", data: "AAAA" }] });
    expect(r.success).toBe(true);
  });
});

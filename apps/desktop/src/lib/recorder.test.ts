import { afterEach, describe, expect, it, vi } from "vitest";
import { startRecorder } from "./recorder";

class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = (t: string) => t === "audio/mp4";
  state = "inactive";
  mimeType = "audio/mp4";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["abc"]) });
    this.onstop?.();
  }
}

const track = () => ({ stop: vi.fn() });
function install() {
  const tracks = [track(), track()];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } });
  return tracks;
}
afterEach(() => vi.unstubAllGlobals());

describe("startRecorder", () => {
  it("cancel stops the recorder and every track and delivers nothing (#4)", async () => {
    const tracks = install();
    const rec = await startRecorder();
    const fake = FakeRecorder.last;
    const onstop = vi.fn();
    fake.onstop = onstop;
    rec.cancel();
    expect(fake.state).toBe("inactive");
    expect(onstop).not.toHaveBeenCalled(); // handlers are detached before the stop
    for (const t of tracks) expect(t.stop).toHaveBeenCalledTimes(1);
    rec.cancel(); // a second call must not throw on the inactive recorder
    expect(fake.state).toBe("inactive");
  });
});

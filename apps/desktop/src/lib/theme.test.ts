import { describe, expect, it } from "vitest";
import { syncTheme } from "./theme";

/** Minimal MediaQueryList whose `matches` the test flips like an OS appearance change. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    mq: { matches, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) } as unknown as MediaQueryList,
    set(v: boolean) {
      (this.mq as { matches: boolean }).matches = v;
      listeners.forEach((l) => l());
    },
    listeners,
  };
}

describe("syncTheme", () => {
  it("sets data-theme from the OS and follows changes until stopped", () => {
    const root = document.createElement("html");
    const media = fakeMedia(false);
    const stop = syncTheme(root, media.mq);
    expect(root.dataset.theme).toBe("light");
    media.set(true);
    expect(root.dataset.theme).toBe("dark");
    media.set(false);
    expect(root.dataset.theme).toBe("light");
    stop();
    expect(media.listeners.size).toBe(0);
  });
});

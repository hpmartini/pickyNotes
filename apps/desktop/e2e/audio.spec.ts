import { expect, test } from "@playwright/test";
import { activeText, mockRecorder, mockTauri, tauriCalls } from "./helpers";

type Win = { __transcribeReply?: unknown; __resolveTranscribe?: (v: unknown) => void; __micStopped: number; __recMime: string };

test.beforeEach(async ({ page }) => {
  await mockTauri(page, { start: { ok: true, phase: "recording" } });
  await mockRecorder(page);
});

test("recording stops by itself at 10:00 and becomes an audio block", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.locator(".cm-content").click();
  await page.getByRole("button", { name: "Aufnahme" }).click();
  await expect(page.getByRole("button", { name: /^Stopp 0:0\d$/ })).toBeVisible();
  // STT is locked while recording, and the recorder picked audio/mp4 like WKWebView does
  await expect(page.getByRole("button", { name: "STT" })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as Win).__recMime)).toBe("audio/mp4");

  await page.clock.fastForward(599_000);
  await expect(page.getByRole("button", { name: "Aufnahme" })).toHaveCount(0); // still recording after 9:59
  expect(await page.evaluate(() => (window as unknown as Win).__micStopped)).toBe(0);

  await page.clock.fastForward(2_000);
  await expect(page.getByRole("button", { name: "Aufnahme" })).toBeVisible();
  await expect.poll(() => activeText(page)).toMatch(/^\[🎙 Aufnahme \d{4}-\d\d-\d\d \d\d:\d\d \(10:00\)\]\(pending:[\w-]+\)/);
  expect(await page.evaluate(() => (window as unknown as Win).__micStopped)).toBe(1);
  const calls = await tauriCalls(page);
  expect(calls.filter(([c]) => c === "transcribe_audio")).toHaveLength(1);
  expect(calls.some(([c]) => c === "whisperstorm")).toBe(false); // STT untouched
});

test("audio block: player, running state, error with retry (recording kept), collapsible transcript", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as Win).__transcribeReply = new Promise((r) => ((window as unknown as Win).__resolveTranscribe = r));
  });
  await page.locator(".cm-content").click();
  await page.getByRole("button", { name: "Aufnahme" }).click();
  await page.getByRole("button", { name: /^Stopp / }).click();

  const chip = page.locator(".cm-pn-audio");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Aufnahme");
  await expect(chip.getByText("Transkription läuft")).toBeVisible();
  await expect(chip.getByRole("button", { name: "Erneut transkribieren" })).toHaveCount(0);

  // WhisperStorm is not running: the block offers a retry and keeps the recording
  await page.evaluate(() => (window as unknown as Win).__resolveTranscribe!({ ok: false, error: "WhisperStorm läuft nicht" }));
  await expect(chip.getByText("WhisperStorm läuft nicht")).toBeVisible();
  await expect(chip.getByRole("button", { name: "Erneut transkribieren" })).toBeVisible();
  expect(await activeText(page)).toMatch(/\]\(pending:[\w-]+\)\n?$/);
  expect(await activeText(page)).not.toContain("Transkript:");

  // player: Play -> Pause -> Play
  await chip.getByRole("button", { name: "▶ Abspielen" }).click();
  await expect(chip.getByRole("button", { name: "⏸ Pause" })).toBeVisible();
  await chip.getByRole("button", { name: "⏸ Pause" }).click();
  await expect(chip.getByRole("button", { name: "▶ Abspielen" })).toBeVisible();

  // retry succeeds: transcript lands in the note text as a quote line
  await page.evaluate(() => ((window as unknown as Win).__transcribeReply = { ok: true, phase: "success", text: "Hallo Aufnahme" }));
  await chip.getByRole("button", { name: "Erneut transkribieren" }).click();
  await expect.poll(() => activeText(page)).toMatch(/\]\(pending:[\w-]+\)\n> Transkript: Hallo Aufnahme/);
  const quote = page.locator(".cm-line", { hasText: "Hallo Aufnahme" });
  await expect(quote).toBeVisible();
  await expect(chip.getByRole("button", { name: "Erneut transkribieren" })).toHaveCount(0);

  // collapsible
  await chip.getByRole("button", { name: "Transkript einklappen" }).click();
  await expect(quote).toBeHidden();
  expect(await activeText(page)).toContain("> Transkript: Hallo Aufnahme"); // text stays in the note
  await chip.getByRole("button", { name: "Transkript ausklappen" }).click();
  await expect(quote).toBeVisible();
});

test("a failed WhisperStorm reply shows its message and offers the retry", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((r) => ((window as unknown as Win).__transcribeReply = r), { ok: false, phase: "error", error: "Datei nicht lesbar" });
  await page.locator(".cm-content").click();
  await page.getByRole("button", { name: "Aufnahme" }).click();
  await page.getByRole("button", { name: /^Stopp / }).click();
  await expect(page.locator(".cm-pn-audio").getByText("Datei nicht lesbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Erneut transkribieren" })).toBeVisible();
});

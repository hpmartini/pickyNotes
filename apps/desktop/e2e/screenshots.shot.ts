import { expect, test, type Page } from "@playwright/test";
import { mockTauri } from "./helpers";

// Not part of the e2e gate: `npm run screenshots -w @pickynotes/desktop` renders the README images from demo data.
const OUT = "../../docs/screenshots";

const NOTES = [
  { id: "n1", text: "# Wochenplanung\n\nDrei Dinge, die diese Woche zählen:\n\n- Angebot an Müller fertigstellen\n- Zahnarzt-Termin verschieben\n- **Ideen** für den Newsletter sammeln\n\n- [x] Rechnung gestellt\n- [ ] Flug buchen\n\n| Tag | Fokus |\n| --- | --- |\n| Mo | Angebot |\n| Di | Newsletter |\n" },
  { id: "n2", text: "Idee: Sprachnotiz per Hotkey diktieren und direkt im Editor sehen." },
  { id: "n3", text: "Lesezeichen: Artikel über lokale Embeddings" },
];

async function seed(page: Page) {
  await mockTauri(page, { start: { ok: false } });
  await page.addInitScript((notes) => {
    localStorage.setItem("picky.notes", JSON.stringify({ active: "n1", notes }));
    localStorage.setItem("picky.url", location.origin);
    localStorage.setItem("picky.dev-token", "t");
  }, NOTES);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 560, height: 640 }, deviceScaleFactor: 2 });

    test("editor", async ({ page }) => {
      await seed(page);
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(3);
      await page.screenshot({ path: `${OUT}/editor-${scheme}.png` });
    });

    test("pending modal", async ({ page }) => {
      await seed(page);
      await page.route("**/captures", (route) => route.abort("internetdisconnected"));
      await page.goto("/");
      for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: "Speichern" }).click(); // saves the active tab offline, the next one becomes active
        await expect(page.getByRole("tab")).toHaveCount(2 - i || 1);
      }
      await page.getByRole("button", { name: /^Ausstehend/ }).click();
      await expect(page.getByRole("dialog", { name: "Ausstehend" })).toBeVisible();
      await page.screenshot({ path: `${OUT}/pending-${scheme}.png` });
    });

    test("settings", async ({ page }) => {
      await seed(page);
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(3);
      await page.keyboard.press("Control+,");
      await expect(page.getByRole("dialog", { name: "Einstellungen" })).toBeVisible();
      await page.screenshot({ path: `${OUT}/settings-${scheme}.png` });
    });
  });
}

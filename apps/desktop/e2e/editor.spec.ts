import { expect, test } from "@playwright/test";

// Regression for the reported editor bugs; needs the real CodeMirror/Atomic Editor, a jsdom textarea mock cannot show them.
test("typing keeps focus, lists work, draft survives a tab switch, text is readable", async ({ page }) => {
  await page.goto("/");
  const editor = page.locator(".cm-content");
  await editor.click();

  // 1. focus: ten characters one by one without clicking again
  await page.keyboard.type("0123456789", { delay: 20 });
  await expect(editor).toContainText("0123456789");
  expect(await page.evaluate(() => document.querySelector(".cm-content")!.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");

  // 2. lists: "- " renders a bullet, Enter continues, Tab indents
  await page.keyboard.type("- eins", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("zwei", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("eingerückt", { delay: 20 });
  await expect(page.locator(".cm-line")).toHaveText(["•eins", "•zwei", "•eingerückt"]);
  expect(await page.evaluate(() => localStorage.getItem("picky.draft"))).toBe("- eins\n- zwei\n  - eingerückt");

  // 3. readable colours: editor text clearly darker than its background in the light theme
  const [fg, bg] = await page.evaluate(() => {
    const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number);
    return [rgb(getComputedStyle(document.querySelector(".cm-content")!).color), rgb(getComputedStyle(document.body).backgroundColor)];
  });
  const lum = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  expect(Math.abs(lum(fg!) - lum(bg!))).toBeGreaterThan(150);

  // 4. draft survives leaving the capture tab
  await page.getByRole("button", { name: "Einstellungen" }).click();
  await page.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.locator(".cm-line")).toHaveText(["•eins", "•zwei", "•eingerückt"]);
});

test.use({ colorScheme: "light" });

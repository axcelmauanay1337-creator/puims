import { expect, test } from "./fixtures";

test.describe("phone layout", () => {
  test("bottom navigation, drawer and card tables work on a phone", async ({ page }) => {
    await page.goto("/");
    const bottom = page.getByRole("navigation", { name: "Primary (mobile)" });
    await expect(bottom).toBeVisible();
    await expect(page.getByTestId("sync-indicator")).toBeVisible(); // sync state visible on all sizes

    await bottom.getByRole("link", { name: "Patients" }).click();
    await expect(page).toHaveURL(/\/patients$/);
    // Phones get cards, not the dense table.
    await expect(page.locator("table").first()).toBeHidden();
    await expect(page.getByRole("list", { name: "Patient masterlist" })).toBeVisible();

    await bottom.getByRole("button", { name: "More" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: /Change of tubing/i }).click();
    await expect(page).toHaveURL(/\/tubing$/);
    await expect(drawer).toBeHidden();
  });

  test("no horizontal page overflow on key screens", async ({ page }) => {
    for (const route of [
      "/",
      "/patients",
      "/nebulization",
      "/shifts",
      "/reports",
      "/reports?period=month",
      "/devices",
      "/diagnostics/pft",
      "/diagnostics/pft?view=calendar",
      "/import",
      "/settings",
    ]) {
      await page.goto(route);
      await expect(page.locator("main h1").first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, route).toBeLessThanOrEqual(0);
    }
  });

  test("offline capture page fits a phone and has no overflow", async ({ page }) => {
    await page.goto("/offline-capture.html");
    await expect(page.getByRole("heading", { name: "PUIMS · Offline capture" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("touch targets in the bottom nav are at least 44px tall", async ({ page }) => {
    await page.goto("/");
    const box = await page.getByRole("navigation", { name: "Primary (mobile)" }).getByRole("link", { name: "Today" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

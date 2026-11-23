import AxeBuilder from "@axe-core/playwright";
import { STATE } from "./env";
import { expect, test } from "./fixtures";

test.describe("reports (Chief RT)", () => {
  test.use({ storageState: STATE.chief });

  for (const period of ["week", "month", "year"]) {
    test(`${period} report renders with definitions and passes axe`, async ({ page }) => {
      await page.goto(`/reports?period=${period}&mode=operational`);
      await expect(page.getByRole("heading", { name: "Tubing replacement compliance" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Workload context by shift" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Definitions" })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    });
  }

  test("summary CSV export downloads (audited, aggregate only)", async ({ page }) => {
    await page.goto("/reports?period=month");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export summary (CSV)" }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^puims-summary-month-\d{4}-\d{2}-01\.csv$/);
  });

  test("RTs cannot export", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STATE.rt });
    const res = await ctx.request.get("/api/reports/export?kind=summary&period=month&mode=operational&date=2026-01-01");
    expect(res.status()).toBe(403);
    await ctx.close();
  });
});

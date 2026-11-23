import { expect, test } from "./fixtures";

/**
 * Coarse server-response budget on synthetic data (≈50 patients, ≈1 year of history).
 * Not a load test — it catches accidental N+1 queries or unbounded scans. Timings are printed
 * so they can be recorded in docs/PERFORMANCE.md.
 */
const BUDGET_MS = 3000;
const ROUTES = [
  "/",
  "/patients",
  "/nebulization",
  "/handover",
  "/diagnostics/pft",
  "/diagnostics/pft?view=calendar",
  "/reports",
  "/reports?period=month",
  "/reports?period=year",
  "/audit",
  "/import",
];

test("key pages render within the response budget", async ({ page }) => {
  test.setTimeout(120_000);
  const rows: string[] = [];
  for (const route of ROUTES) {
    await page.request.get(route); // warm-up (first compile of the route on a cold server)
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const res = await page.request.get(route);
      samples.push(Date.now() - t0);
      expect(res.status(), route).toBe(200);
    }
    const median = samples.sort((a, b) => a - b)[1];
    rows.push(`${route.padEnd(32)} median ${String(median).padStart(5)} ms  (max ${samples[2]} ms)`);
    expect(median, route).toBeLessThan(BUDGET_MS);
  }
  console.log("\n" + rows.join("\n"));
});

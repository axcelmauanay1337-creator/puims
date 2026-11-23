import AxeBuilder from "@axe-core/playwright";
import { STATE } from "./env";
import { ALL_ROUTES, CHIEF_ONLY, expect, test } from "./fixtures";

test.describe("navigation and core screens (Chief RT)", () => {
  for (const route of ALL_ROUTES) {
    test(`${route} renders with a heading and no errors`, async ({ page }) => {
      const res = await page.goto(route);
      expect(res?.status()).toBe(200);
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(page.getByTestId("access-denied")).toHaveCount(0);
    });
  }

  test("every sidebar link navigates to a working page (no dead navigation)", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("aside[aria-label='Sidebar']:visible");
    const hrefs = await sidebar.locator("nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.length).toBe(ALL_ROUTES.length);
    for (const href of hrefs) {
      await sidebar.locator(`nav a[href='${href}']`).click();
      await expect(page).toHaveURL(new RegExp(`${href === "/" ? "/$" : href}`));
      await expect(page.locator("main h1").first()).toBeVisible();
      await expect(sidebar.locator(`nav a[href='${href}']`)).toHaveAttribute("aria-current", "page");
    }
  });

  test("overview shows Asia/Manila operational date regardless of device timezone", async ({ page }) => {
    await page.goto("/");
    const expected = await page.evaluate(() => {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
          .formatToParts(new Date())
          .map((x) => [x.type, x.value]),
      );
      const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - (+p.hour < 6 ? 1 : 0)));
      return String(d.getUTCDate());
    });
    await expect(page.getByTestId("operational-date")).toContainText(` ${expected} `);
  });

  test("patient profile opens from the masterlist and URL holds only a UUID", async ({ page }) => {
    await page.goto("/patients");
    await page.getByRole("searchbox", { name: /search patient masterlist/i }).fill("SYN-1002");
    const link = page.locator("table a[href^='/patients/']").first();
    await link.click();
    await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Hospital no.")).toBeVisible();
  });
});

test.describe("server-side authorization (RT role)", () => {
  test.use({ storageState: STATE.rt });

  for (const route of CHIEF_ONLY) {
    test(`RT is denied ${route} by the server`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByTestId("access-denied")).toBeVisible();
    });
  }

  test("admin destinations are not offered in RT navigation", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator("aside[aria-label='Sidebar']:visible");
    for (const r of CHIEF_ONLY) await expect(sidebar.locator(`a[href='${r}']`)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), RT Bravo/ })).toBeVisible();
    // Unit KPI cards are Chief-only.
    await expect(page.getByText("Unique patients served")).toHaveCount(0);
  });

  test("RT activity is scoped to their own events", async ({ page }) => {
    await page.goto("/activities");
    await expect(page.getByRole("heading", { name: "My Daily Activities" })).toBeVisible();
    await expect(page.getByText("Workload context")).toHaveCount(0);
  });
});

test.describe("global search", () => {
  test("Ctrl+K opens search; patient search uses POST and never puts the term in a URL", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto("/");
    // The shortcut listener exists only after hydration; under parallel load that can take a moment.
    await page.waitForLoadState("networkidle");
    const box = page.getByRole("combobox");
    await expect(async () => {
      if (!(await box.isVisible())) await page.keyboard.press("Control+k");
      await expect(box).toBeFocused({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await box.fill("SYN-1002");
    const option = page.getByRole("option").filter({ hasText: "SYN-1002" }).first();
    await expect(option).toBeVisible();
    await box.press("Enter");
    await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
    expect(urls.filter((u) => u.includes("SYN-1002"))).toEqual([]);
  });

  test("module search jumps to a module", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /search \(ctrl\+k\)/i }).click();
    await page.getByRole("combobox").fill("tubing");
    await page.getByRole("option", { name: /Tubing Tracker/ }).click();
    await expect(page).toHaveURL(/\/tubing$/);
  });

  test("search API rejects GET and oversized input", async ({ request }) => {
    expect((await request.get("/api/search?q=x")).status()).toBe(405);
    expect((await request.post("/api/search", { data: { q: "x".repeat(65) } })).status()).toBe(400);
  });
});

test.describe("connectivity truthfulness", () => {
  test("shows Online, then Offline banner when the server is unreachable, then recovers", async ({ page, context }) => {
    await page.goto("/");
    const chip = page.getByTestId("sync-indicator");
    await expect(chip).toHaveAttribute("data-mode", "online");
    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByTestId("offline-banner")).toContainText("no offline patient data");
    await expect(chip).toHaveAttribute("data-mode", "offline");
    // Manual retry while still offline must keep reporting offline (never optimistic).
    await page.getByTestId("offline-banner").getByRole("button", { name: "Retry now" }).click();
    await expect(chip).toHaveAttribute("data-mode", "offline");
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    // Reconnecting triggers an automatic re-probe.
    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
    await expect(chip).toHaveAttribute("data-mode", "online");
  });

  test("sync popover never claims a sync or queue that does not exist", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("sync-indicator").click();
    const dlg = page.getByRole("dialog", { name: "Connection and sync status" });
    await expect(dlg).toContainText("offline sync not enabled");
    await expect(dlg).toContainText("No offline queue on this device");
  });
});

test.describe("security headers and PWA", () => {
  test("pages send security headers and no-store", async ({ request }) => {
    const res = await request.get("/patients");
    const h = res.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toContain("no-store");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("manifest and service worker are served; SW never caches pages or APIs", async ({ request }) => {
    const m = await (await request.get("/manifest.webmanifest")).json();
    expect(m.display).toBe("standalone");
    expect(m.icons.length).toBeGreaterThanOrEqual(2);
    const sw = await (await request.get("/sw.js")).text();
    expect(sw).toContain('req.mode === "navigate"');
    expect(sw).not.toMatch(/\/api\/.*cache\.put/);
  });

  test("service worker registers in production and offline navigation shows the PHI-free notice", async ({ page, context }) => {
    await page.goto("/");
    // Wait until the worker is active (awaited explicitly — not via a Promise-returning predicate).
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    const controlled = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          if (navigator.serviceWorker.controller) return resolve(true);
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true));
          setTimeout(() => resolve(!!navigator.serviceWorker.controller), 10_000);
        }),
    );
    expect(controlled).toBe(true);
    await context.setOffline(true);
    await page.goto("/patients").catch(() => {});
    await expect(page.getByRole("heading", { name: "No connection to PUIMS" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("SYN-");
    await context.setOffline(false);
  });
});

test.describe("accessibility (axe, WCAG 2.1 AA)", () => {
  for (const route of ["/", "/patients", "/tubing", "/reports", "/devices", "/diagnostics/pft"]) {
    test(`${route} has no serious or critical violations`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("main h1").first()).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.nodes[0]?.target}`)).toEqual([]);
    });
  }
});

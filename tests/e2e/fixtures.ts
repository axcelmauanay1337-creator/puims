import { test as base, expect } from "@playwright/test";

/** Fails any test whose page logs a console error or throws an uncaught exception. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        // The browser itself logs failed requests while a test deliberately takes the device offline.
        if (m.type() === "error" && !/net::ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const ALL_ROUTES = [
  "/",
  "/patients",
  "/activities",
  "/handover",
  "/nebulization",
  "/ventilation",
  "/tubing",
  "/diagnostics/pft",
  "/diagnostics/abg",
  "/diagnostics/sputum",
  "/shifts",
  "/staff",
  "/reports",
  "/import",
  "/notifications",
  "/audit",
  "/settings",
  "/devices",
  "/schedule",
  "/equipment",
  "/trends",
  "/charges",
];

export const CHIEF_ONLY = ["/staff", "/reports", "/import", "/audit", "/charges"];

import { defineConfig, devices } from "@playwright/test";
import { loadEnv, STATE } from "./tests/e2e/env";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const env = loadEnv();
if (!env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for e2e tests");

/**
 * E2E runs a PRODUCTION build (`npm run build` first) against the TEST database,
 * which global setup migrates and re-seeds with synthetic data. Real sign-in
 * (password + TOTP) is used throughout — there is no test-only bypass.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    timezoneId: "America/New_York", // prove the UI renders Asia/Manila regardless of device zone
    storageState: STATE.chief,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: env.TEST_DATABASE_URL,
      PUIMS_DATA_KEY: env.PUIMS_DATA_KEY,
      PUIMS_DEPLOYMENT_PROFILE: "development",
      PUIMS_INSECURE_COOKIES: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});

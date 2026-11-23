import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Load .env.local for local runs (CI provides real environment variables instead).
const fileEnv: Record<string, string> = {};
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) fileEnv[m[1]] = m[2];
  }
}
for (const [k, v] of Object.entries(fileEnv)) process.env[k] = v; // visible to globalSetup too
const env = process.env as Record<string, string>;
if (!env.TEST_DATABASE_URL || !env.TEST_MIGRATION_DATABASE_URL) throw new Error("TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL are required for DB tests");

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/db/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/db/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 100_000, // some auth tests must wait for the next 30 s TOTP window (replay protection)
    hookTimeout: 120_000,
    env: {
      ...fileEnv,
      TZ: "America/Los_Angeles",
      // The app code under test connects to the TEST database as the least-privileged role.
      DATABASE_URL: env.TEST_DATABASE_URL,
      MIGRATION_DATABASE_URL: env.TEST_MIGRATION_DATABASE_URL,
      PUIMS_DEPLOYMENT_PROFILE: "development",
    },
  },
});

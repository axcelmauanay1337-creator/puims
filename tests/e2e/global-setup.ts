import { chromium, type FullConfig } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { AUTH_DIR, loadEnv, STATE, USERS } from "./env";
import { signInViaUi } from "./auth-helpers";

/** Fresh synthetic test DB, then real UI sign-ins for the Chief RT and one RT. */
export default async function globalSetup(config: FullConfig) {
  const base = loadEnv();
  const env = {
    ...base,
    MIGRATION_DATABASE_URL: base.TEST_MIGRATION_DATABASE_URL ?? "",
    PUIMS_DEPLOYMENT_PROFILE: "development",
  } as unknown as NodeJS.ProcessEnv;
  execSync("node scripts/migrate.mjs", { env, stdio: "inherit" });
  execSync("npx tsx scripts/seed.ts --test", { env, stdio: "inherit" });
  mkdirSync(AUTH_DIR, { recursive: true });
  rmSync(STATE.steps, { recursive: true, force: true });

  const baseURL = config.projects[0].use.baseURL!;
  const browser = await chromium.launch();
  for (const [key, username] of Object.entries(USERS) as Array<[keyof typeof USERS, string]>) {
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    await signInViaUi(page, username);
    await ctx.storageState({ path: STATE[key] });
    await ctx.close();
  }
  await browser.close();
}

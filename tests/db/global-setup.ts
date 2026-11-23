import { execSync } from "node:child_process";

/** Fresh schema + synthetic seed in the TEST database before the DB suite runs. */
export default function setup() {
  const env = { ...process.env, MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL, PUIMS_DEPLOYMENT_PROFILE: "development" };
  execSync("node scripts/migrate.mjs", { env, stdio: "inherit" });
  execSync("npx tsx scripts/seed.ts --test", { env, stdio: "inherit" });
}

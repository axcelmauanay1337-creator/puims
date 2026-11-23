/** Development only: prints the current authenticator code for a SYNTHETIC seeded account. */
import { readFileSync } from "node:fs";
import { totpCode } from "../src/lib/auth/totp";

const profile = process.env.PUIMS_DEPLOYMENT_PROFILE ?? "development";
if (profile !== "development" && profile !== "uat") {
  console.error("dev:totp is only available on development/uat profiles");
  process.exit(1);
}
const user = process.argv[2];
const file = process.argv.includes("--test") ? ".seed-credentials.test.json" : ".seed-credentials.json";
const data = JSON.parse(readFileSync(file, "utf8")) as { accounts: Record<string, { totpSecret: string }> };
const acct = user ? data.accounts[user] : undefined;
if (!acct) {
  console.error(`Usage: npm run dev:totp -- <username>\nKnown: ${Object.keys(data.accounts).join(", ")}`);
  process.exit(1);
}
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${totpCode(acct.totpSecret, Date.now())}  (valid ~${left}s)`);

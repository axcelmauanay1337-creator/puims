import { expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { totpCode, totpStep } from "../../src/lib/auth/totp";
import { loadEnv, STATE } from "./env";

export const seedPassword = () => loadEnv().PUIMS_SEED_PASSWORD;

export function seedSecret(username: string): string {
  return JSON.parse(readFileSync(".seed-credentials.test.json", "utf8")).accounts[username].totpSecret;
}

/**
 * TOTP codes are single-use per 30 s step (replay protection), so tests share a
 * record of the last step used per account and wait for a newer step when needed.
 */
export async function freshCode(username: string, secret = seedSecret(username)): Promise<string> {
  // One file per account, guarded by an exclusive lock (mkdir is atomic), so parallel workers can
  // never hand out the same 30 s step twice — the server rejects a replayed step by design.
  mkdirSync(STATE.steps, { recursive: true });
  const file = `${STATE.steps}/${username}.json`;
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A lock older than 2 minutes is from a crashed worker.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* raced with its owner */
      }
      if (Date.now() - started > 120_000) throw new Error(`timed out waiting for TOTP lock (${username})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    const last: number | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).step : undefined;
    while (last !== undefined && totpStep(Date.now()) <= last) await new Promise((r) => setTimeout(r, 500));
    const now = Date.now();
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ step: totpStep(now) }));
    renameSync(`${file}.${process.pid}.tmp`, file);
    return totpCode(secret, now);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function signInViaUi(page: Page, username: string, password = seedPassword(), next = "/") {
  await page.goto(`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login\/verify/);
  await page.getByLabel("Authenticator code").fill(await freshCode(username));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

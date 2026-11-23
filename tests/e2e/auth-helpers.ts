import { expect, type Page } from "@playwright/test";
import { loadEnv } from "./env";

export const seedPassword = () => loadEnv().PUIMS_SEED_PASSWORD;

export async function signInViaUi(page: Page, username: string, password = seedPassword(), next = "/") {
  await page.goto(`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

import type { Page } from "@playwright/test";
import { freshCode, seedPassword, signInViaUi } from "./auth-helpers";
import { STATE, USERS } from "./env";
import { expect, test } from "./fixtures";

async function confirmItsYou(page: Page, username: string) {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Password").fill(seedPassword());
  await dialog.getByLabel("Authenticator code").fill(await freshCode(username));
  await dialog.getByRole("button", { name: "Confirm" }).click();
}

test.describe("offline capture (approved device)", () => {
  test.describe.configure({ mode: "serial" });

  test("an unapproved device cannot prepare offline capture", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STATE.rt });
    const page = await ctx.newPage();
    await page.goto("/offline-capture.html");
    await page.getByRole("button", { name: "Prepare offline capture" }).click();
    await expect(page.getByText(/not approved for offline use/)).toBeVisible();
    await ctx.close();
  });

  test("Chief approves the RT's device (step-up)", async ({ browser }) => {
    test.setTimeout(240_000); // sign-in and step-up each need a fresh 30 s authenticator window (shared with other Chief tests)
    // The exact device the RT's browser uses (the RT may have signed in from other test browsers too).
    const rtCtx = await browser.newContext({ storageState: STATE.rt });
    const rtPage = await rtCtx.newPage();
    await rtPage.goto("/devices");
    const deviceId = await rtPage.getByTestId("device-row").filter({ hasText: "This device" }).getAttribute("data-device-id");
    await rtCtx.close();
    expect(deviceId).toBeTruthy();
    // A separate Chief session, so this step-up does not affect other tests sharing the stored Chief session.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await signInViaUi(page, USERS.chief);
    await page.goto("/devices");
    const row = page.locator(`[data-device-id="${deviceId}"]`);
    page.once("dialog", (d) => d.accept());
    await row.getByRole("button", { name: "Approve for offline…" }).click();
    await confirmItsYou(page, USERS.chief);
    await expect(row.getByText("Offline capture: approved")).toBeVisible();
    await ctx.close();
  });

  test("airplane mode: capture offline, survive a reload (locked, still encrypted), reconnect, unlock, sync", async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ storageState: STATE.rt });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/offline-capture.html");
    await page.getByRole("button", { name: "Prepare offline capture" }).click();
    await expect(page.getByText(/Ready for offline capture until/)).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Make sure the page itself is in the SW cache before going offline.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ventilator tubing" })).toHaveCount(0); // locked after reload (key was in memory)
    await page.getByRole("button", { name: "Unlock (fetch key from PUIMS)" }).click();
    await expect(page.getByRole("heading", { name: "Ventilator tubing" })).toBeVisible();

    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByText("○ Offline — PUIMS unreachable")).toBeVisible();
    await page.getByRole("button", { name: "Replacement" }).first().click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Reason").fill("Routine replacement (e2e offline)");
    await dlg.getByRole("button", { name: "Save on this device" }).click();
    await expect(page.getByText(/Saved on this device \(encrypted\)/)).toBeVisible();
    await expect(page.getByText(/1 entry waiting to sync/)).toBeVisible();

    // The stored entry is ciphertext only.
    const raw = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const r = indexedDB.open("puims-offline");
          r.onsuccess = () => {
            const q = r.result.transaction("queue").objectStore("queue").getAll();
            q.onsuccess = () => resolve(JSON.stringify(q.result));
          };
        }),
    );
    expect(raw).not.toContain("e2e offline");

    // Reload while offline: the service worker serves the page; the key is gone, the entry is not.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();
    await expect(page.getByText(/1 encrypted entry is saved on this device/)).toBeVisible();

    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByRole("button", { name: "Unlock (fetch key from PUIMS)" }).click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText(/1 entry received by PUIMS/)).toBeVisible();
    await expect(page.getByText(/0 entries waiting to sync/)).toBeVisible();
    expect(errors).toEqual([]);

    await page.goto("/devices");
    await expect(page.getByText(/Last sync from this device:/)).toBeVisible();
    await ctx.close();
  });
});

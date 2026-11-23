import { freshCode, seedPassword, signInViaUi } from "./auth-helpers";
import { STATE } from "./env";
import { expect, test } from "./fixtures";

// Each test signs in as a DIFFERENT synthetic account: TOTP codes are single-use per
// 30 s window, so parallel sign-ins as one account would (correctly) be rejected.
const anon = { storageState: { cookies: [], origins: [] } };

test.describe("unauthenticated access", () => {
  test.use(anon);

  test("protected pages redirect to sign-in, remembering only the path", async ({ page }) => {
    await page.goto("/tubing");
    await expect(page).toHaveURL(/\/login\?next=%2Ftubing$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("APIs refuse without a session", async ({ request }) => {
    expect((await request.post("/api/search", { data: { q: "SYN" } })).status()).toBe(401);
    expect((await request.post("/api/auth/heartbeat")).status()).toBe(401);
    expect((await request.get("/api/health")).status()).toBe(200); // PHI-free probe only
  });

  test("wrong password and unknown user show the same generic message", async ({ page }) => {
    for (const [u, pw] of [
      ["rt.charlie", "definitely-wrong-pass"],
      ["no.such.user", "definitely-wrong-pass"],
    ]) {
      await page.goto("/login");
      await page.getByLabel("Username").fill(u);
      await page.getByLabel("Password").fill(pw);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Sign-in failed" })).toHaveText(/Sign-in failed\. Check your username and password/);
    }
  });

  test("a wrong authenticator code is refused, then the right one signs in and returns to the deep link", async ({ page }) => {
    await page.goto("/login?next=%2Fshifts");
    await page.getByLabel("Username").fill("rt.charlie");
    await page.getByLabel("Password").fill(seedPassword());
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Authenticator code").fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "code" })).toContainText("That code is not valid");
    await page.getByLabel("Authenticator code").fill(await freshCode("rt.charlie"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/shifts$/);
  });

  test("session cookies are HttpOnly and SameSite=Strict; pages carry a nonce-based CSP", async ({ page, context }) => {
    const res = await page.goto("/login");
    const csp = res!.headers()["content-security-policy"];
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    await signInViaUi(page, "rt.alpha");
    const session = (await context.cookies()).find((c) => c.name === "puims_session")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Strict");
  });
});

test.describe("sign out", () => {
  test.use(anon);
  test("signing out revokes the session on the server — the old cookie no longer works", async ({ page, context }) => {
    await signInViaUi(page, "rt.echo");
    const cookie = (await context.cookies()).find((c) => c.name === "puims_session")!;
    await page.getByRole("button", { name: /^Account:/ }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login\?reason=signed-out/);
    await context.addCookies([cookie]); // replay the old cookie
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Chief RT account administration", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: STATE.chief });

  test("invite an RT (with re-authentication), RT activates with password + authenticator, then signs in", async ({ page, browser }) => {
    await page.goto("/staff");
    await page.getByLabel("Username").fill("rt.e2e");
    await page.getByLabel("Display name").fill("E2E Synthetic RT");
    await page.getByRole("button", { name: "Create account" }).click();

    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Password").fill(seedPassword());
    await dialog.getByLabel("Authenticator code").fill(await freshCode("chief.demo"));
    await dialog.getByRole("button", { name: "Confirm" }).click();

    const box = page.getByTestId("activation-link");
    await expect(box).toBeVisible();
    const link = (await box.locator("code").textContent())!.trim();
    expect(link).toMatch(/\/activate#[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId("staff-rt.e2e")).toContainText("Invited");

    // The new RT, in their own browser.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rt = await ctx.newPage();
    await rt.goto(link);
    await expect(rt.getByRole("heading", { name: "Activate your account" })).toBeVisible();
    await expect(rt).toHaveURL(/\/activate$/); // token scrubbed from the address bar
    await rt.getByRole("button", { name: /Show setup key/ }).click();
    const secret = (await rt.locator("code").textContent())!.replace(/\s/g, "");
    await rt.getByLabel("New password").fill("blue harbor lantern morning");
    await rt.getByLabel("Confirm password").fill("blue harbor lantern morning");
    await rt.getByLabel("6-digit code from the app").fill(await freshCode("rt.e2e", secret));
    await rt.getByRole("button", { name: "Activate account" }).click();
    await expect(rt.getByRole("heading", { name: "Account ready" })).toBeVisible();

    // Link is single-use (load a different document first: a fragment-only change is not a page load).
    await rt.goto("about:blank");
    await rt.goto(link);
    await expect(rt.getByRole("heading", { name: "Activation link not valid" })).toBeVisible();

    await rt.goto("/login");
    await rt.getByLabel("Username").fill("rt.e2e");
    await rt.getByLabel("Password").fill("blue harbor lantern morning");
    await rt.getByRole("button", { name: "Continue" }).click();
    await rt.getByLabel("Authenticator code").fill(await freshCode("rt.e2e", secret));
    await rt.getByRole("button", { name: "Sign in" }).click();
    await expect(rt.getByRole("heading", { name: /E2E Synthetic RT/ })).toBeVisible();
    await expect(rt.locator("aside[aria-label='Sidebar']:visible a[href='/staff']")).toHaveCount(0);
    await ctx.close();
  });

  test("deactivating an RT ends their live session immediately", async ({ page, browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const rt = await ctx.newPage();
    await signInViaUi(rt, "rt.delta");
    await expect(rt.locator("main h1")).toContainText("RT Delta");

    await page.goto("/staff");
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("staff-rt.delta").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByTestId("staff-rt.delta")).toContainText("Account deactivated");

    await rt.goto("/patients");
    await expect(rt).toHaveURL(/\/login/);
    await ctx.close();
  });

  test("settings are editable by the Chief RT, validated, and saved", async ({ page }) => {
    await page.goto("/settings");
    const row = page.locator("form").filter({ hasText: "Tubing replacement interval (days)" });
    await row.getByRole("spinbutton").fill("8");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("✓ Setting saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("8 calendar days")).toBeVisible();
    const again = page.locator("form").filter({ hasText: "Tubing replacement interval (days)" });
    await again.getByRole("spinbutton").fill("7");
    await again.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("✓ Setting saved.")).toBeVisible();
  });

  test("the audit log records sign-ins and administrative actions", async ({ page }) => {
    await page.goto("/audit?action=auth.");
    await expect(page.getByRole("table", { name: "Audit log" })).toContainText("auth.login");
    await page.getByLabel("Category").selectOption("admin.");
    await page.getByRole("button", { name: "Show" }).click();
    const admin = page.getByRole("table", { name: "Audit log" });
    await expect(admin).toContainText("admin.staff_invited");
    await expect(admin).toContainText("admin.staff_deactivated");
    await expect(admin).not.toContainText("auth.login");
  });
});

test.describe("RT boundaries", () => {
  test.use({ storageState: STATE.rt });
  test("an RT cannot edit settings and sees only their own sessions", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText("Edit configuration")).toHaveCount(0);
    await page.goto("/devices");
    await expect(page.getByRole("heading", { name: "My active sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke device" })).toHaveCount(0);
  });
});

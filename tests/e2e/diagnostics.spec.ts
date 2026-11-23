import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { HOSPITAL_TZ, toLocalParts } from "../../src/lib/time/zoned";
import { buildSyntheticGuide } from "../fixtures/syntheticGuide";
import { buildSyntheticWorkbook } from "../fixtures/syntheticWorkbook";
import { seedPassword, signInViaUi } from "./auth-helpers";
import { STATE } from "./env";
import { expect, test } from "./fixtures";

const z = (n: number) => String(n).padStart(2, "0");
function manila(d: Date) {
  const p = toLocalParts(d, HOSPITAL_TZ);
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
async function confirmItsYou(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Password").fill(seedPassword());
  await dialog.getByRole("button", { name: "Confirm" }).click();
}
async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target}`);
}

test.describe("PFT scheduling and the PFT clinical record (RT)", () => {
  test.use({ storageState: STATE.rt });
  test.describe.configure({ mode: "serial" });

  test("book → start form → sign (step-up) → record pulmonologist sign-off → final, printable", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/diagnostics/pft");
    await page.getByRole("button", { name: "Book appointment" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Patient").fill("SYN-1003");
    await dlg.getByRole("listbox", { name: "Matching patients" }).getByRole("button").first().click();
    await dlg.getByLabel(/Date and time/).fill(manila(new Date(Date.now() - 20 * 60_000)));
    await dlg.getByRole("button", { name: "Book" }).click();
    await expect(page).toHaveURL(/\/diagnostics\/appointments\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Scheduled").first()).toBeVisible();
    expect(await axe(page)).toEqual([]);

    // Correct a detail of the open booking: requires a reason and shows in the history.
    await page.getByRole("button", { name: "Edit details" }).click();
    const ed = page.getByRole("dialog", { name: "Edit appointment details" });
    await ed.getByLabel("Requesting physician").fill("Dr. Demo Corrected (e2e)");
    await ed.getByLabel("Reason for the correction").fill("Physician name copied wrongly");
    await ed.getByRole("button", { name: "Save correction" }).click();
    await expect(page.getByText("Dr. Demo Corrected (e2e)")).toBeVisible();
    await expect(page.getByText(/Corrected: physician/)).toBeVisible();
    await expect(page.getByText("“Physician name copied wrongly”")).toBeVisible();

    await page.getByRole("button", { name: "Start PFT form" }).click();
    await expect(page).toHaveURL(/\/diagnostics\/pft\/forms\/[0-9a-f-]{36}$/);
    // Clinical sections start empty — nothing generated.
    await expect(page.getByLabel("Purpose of test")).toHaveValue("");
    await expect(page.getByLabel("Patient observation")).toHaveValue("");
    await page.getByLabel("Weight (kg)").fill("61.5");
    await page.getByLabel("Purpose of test").fill("Synthetic purpose (e2e)");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible();
    expect(await axe(page)).toEqual([]);

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Sign as RT…" }).click();
    await confirmItsYou(page);
    await expect(page.getByText("RT signed — awaiting pulmonologist").first()).toBeVisible();
    await expect(page.getByLabel("Purpose of test")).toHaveCount(0); // content locked

    await page.getByRole("radio", { name: "Signature on the printed copy" }).check();
    await page.getByLabel(/Interpretation — exactly as given/).fill("Synthetic interpretation transcribed from the printed copy");
    await page.getByLabel(/I confirm the pulmonologist signed/).check();
    await page.getByRole("button", { name: "Finalize record…" }).click();
    // The step-up from signing may still be fresh; confirm only if asked.
    const asked = page.getByRole("dialog", { name: "Confirm it's you" });
    if (await asked.isVisible({ timeout: 2000 }).catch(() => false)) await confirmItsYou(page);
    await expect(page.getByText("Final — official record")).toBeVisible();
    await expect(page.getByText("Synthetic interpretation transcribed from the printed copy")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add amendment…" })).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "PULMONARY FUNCTION TEST" })).toBeVisible();
    // (the header text depends on the latest template version, which other tests may create)
    await expect(page.getByText(/^6\. Salbutamol was used as the bronchodilator/)).toBeVisible();
    await expect(page.getByText("AS-PUL-PFT-006", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/pft-print.png", fullPage: true });
    await page.emulateMedia({ media: "screen" });
  });

  test("calendar view and filters use only dates and codes in the URL", async ({ page }) => {
    await page.goto("/diagnostics/pft");
    await page.getByRole("link", { name: "Calendar" }).click();
    await expect(page).toHaveURL(/view=calendar/);
    expect(page.url()).not.toMatch(/SYN-|Demo/);
    await page.getByLabel("Status").selectOption("OPEN");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/status=OPEN/);
  });
});

test.describe("import wizard (Chief RT)", () => {
  test.use({ storageState: STATE.chief });

  test("stage a messy synthetic workbook: problems flagged, contact kept as written, nothing committed until every row is decided", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/import");
    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic-e2e.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await buildSyntheticWorkbook(2023),
    });
    await page.getByRole("button", { name: "Stage for review" }).click();
    await expect(page).toHaveURL(/\/import\/[0-9a-f-]{36}/, { timeout: 30_000 });
    // The ambiguous 6/4 date is read as month/day automatically (it fits the JUNE sheet) and the reviewer is told so.
    await expect(page.getByText(/Filled in automatically:.*month\/day/)).toBeVisible();
    await expect(page.getByText("Year looks mistyped — not corrected automatically").first()).toBeVisible();
    // Contact info is kept exactly as written (U-08 approved) and flagged as not checked as a phone number.
    await expect(page.getByText("Contact kept exactly as written — not checked as a phone number").first()).toBeVisible();
    await page.getByRole("button", { name: "Accept clean rows" }).click();
    await page.getByRole("button", { name: "Accept suggested repeat visits" }).click();
    await expect(page.getByText(/Repeat visits accepted:/)).toBeVisible();
    await page.getByRole("button", { name: "Dry run" }).click();
    await expect(page.getByText("Dry run: not ready")).toBeVisible();
    await expect(page.getByRole("button", { name: "Commit import…" })).toBeDisabled();
    expect(await axe(page)).toEqual([]);

    await page.getByRole("button", { name: "Discard batch" }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill("E2E rehearsal — discard");
    await page.getByRole("dialog").getByRole("button", { name: "Discard staged batch" }).click();
    await expect(page.getByText("discarded").first()).toBeVisible();
  });

  test("RTs cannot reach the import center or its upload endpoint", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STATE.rt });
    const page = await ctx.newPage();
    await page.goto("/import");
    await expect(page.getByText(/not have access|don.t have access|Access denied/i).first()).toBeVisible();
    const res = await page.request.post("/api/import/upload", {
      headers: { origin: new URL(page.url()).origin },
      multipart: { file: { name: "x.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("PK") } },
    });
    expect(res.status()).toBe(403);
    await ctx.close();
  });
});

test.describe("PFT guide workbook (Chief RT)", () => {
  test("load the guide as-is: logo + header become a template version; signatures are offered for the directory", async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await signInViaUi(page, "chief.demo");
    await page.goto("/settings");
    const g = await buildSyntheticGuide();
    await page
      .getByLabel("PFT guide workbook")
      .setInputFiles({ name: "guide.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: g.bytes });
    await page.getByRole("button", { name: "Load guide…" }).click();
    await confirmItsYou(page);
    await expect(page.getByText(/created with the logo; 2 signature\(s\) found for review/)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    const proposals = page.getByTestId("signature-proposal");
    await expect(proposals).toHaveCount(2);
    const pulmo = proposals.filter({ hasText: "Dr. Demo Pulmo Signer" });
    await pulmo.getByRole("button", { name: "Add…" }).click();
    await expect(
      page.getByTestId("signatory-row").filter({ hasText: "Dr. Demo Pulmo Signer" }).getByAltText("E-signature of Dr. Demo Pulmo Signer"),
    ).toBeVisible();

    // Replace the logo with an uploaded PNG as a further template version (same step-up window).
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4830000000049454e44ae426082",
      "hex",
    );
    await page.getByLabel(/Hospital logo/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
    await expect(page.getByAltText("New logo preview")).toBeVisible();
    await page.getByRole("button", { name: "Save as new version…" }).click();
    const again = page.getByRole("dialog", { name: "Confirm it's you" });
    if (await again.isVisible({ timeout: 2000 }).catch(() => false)) await confirmItsYou(page);
    await expect(page.getByText(/New template version saved/)).toBeVisible();
    await page.reload();
    const logo = page.getByAltText("Current hospital logo on the PFT form");
    await expect(logo).toBeVisible();
    const res = await page.request.get((await logo.getAttribute("src"))!);
    expect(res.headers()["content-type"]).toBe("image/png");
    await ctx.close();
  });
});

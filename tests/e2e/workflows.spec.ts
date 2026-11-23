import { STATE } from "./env";
import { expect, test } from "./fixtures";

test.describe("patient registration and correction", () => {
  test("register a patient with no hospital number; a second same-name registration requires duplicate review", async ({ page }) => {
    const name = `Workflow, Synthetic ${Date.now() % 100000}`;
    await page.goto("/patients");
    await page.getByRole("link", { name: "Register patient" }).click();
    await page.getByLabel(/Full name/).fill(name);
    await page.getByRole("radio", { name: "Female" }).check();
    await page.getByLabel(/Category/).selectOption("OPD");
    await page.getByRole("button", { name: "Register patient" }).click();
    await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("No hospital no.")).toBeVisible();
    await expect(page.getByText("Female")).toBeVisible();

    // Same person's name typed in a different order → flagged, never merged.
    const [family, given] = name.split(", ");
    await page.goto("/patients/new");
    await page.getByLabel(/Full name/).fill(`${given} ${family}`);
    await page.getByRole("radio", { name: "Male", exact: true }).check();
    await page.getByLabel(/Category/).selectOption("OPD");
    await page.getByRole("button", { name: "Register patient" }).click();
    const review = page.getByTestId("duplicate-review");
    await expect(review).toContainText(name);
    await expect(review).toContainText("Same name");
    const submit = page.getByRole("button", { name: "Register as a new patient" });
    await expect(submit).toBeDisabled();
    await review.getByLabel("This is a different person").first().check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
  });

  test("sex must be Male or Female (no other option exists)", async ({ page }) => {
    await page.goto("/patients/new");
    await expect(page.getByRole("radio")).toHaveCount(2);
    await page.getByLabel(/Full name/).fill("Nosex, Synthetic");
    await page.getByLabel(/Category/).selectOption("INP");
    await page.getByRole("button", { name: "Register patient" }).click();
    await expect(page.getByText("Select Male or Female.")).toBeVisible();
  });

  test.describe("as an RT", () => {
    test.use({ storageState: STATE.rt });
    test("correcting a name requires a reason and is shown in the correction history", async ({ page }) => {
      await page.goto("/patients");
      await page.getByRole("searchbox", { name: /search patient masterlist/i }).fill("SYN-1003");
      await page.locator("table a[href^='/patients/']").first().click();
      await page.getByRole("link", { name: "Correct details" }).click();
      const nameBox = page.getByLabel(/Full name/);
      const old = await nameBox.inputValue();
      await nameBox.fill(`${old} Jr`);
      await page.getByRole("button", { name: "Save correction" }).click();
      await expect(page.getByText(/Give a reason/)).toBeVisible();
      await page.getByLabel(/Reason for correction/).fill("Suffix omitted at registration (synthetic)");
      await page.getByRole("button", { name: "Save correction" }).click();
      await expect(page.getByRole("heading", { level: 1, name: `${old} Jr` })).toBeVisible();
      const history = page.getByTestId("revision-list");
      await expect(history).toContainText("Suffix omitted at registration");
      await expect(history).toContainText("RT Bravo (Demo)");
    });
  });
});

test.describe("roster editing", () => {
  test("the Chief RT adds and removes an assignment", async ({ page }) => {
    await page.goto("/shifts");
    const rows = page.locator("[data-testid^='roster-']");
    const row = rows.nth(6);
    const cell = row.locator("[data-testid$='-AFTERNOON']");
    const add = cell.getByRole("combobox", { name: /Add staff to/ });
    const option = (await add.locator("option").allTextContents()).find((t) => t.startsWith("RT "))!;
    await add.selectOption({ label: option });
    await expect(page.getByRole("status")).toContainText(`${option} added`);
    await expect(cell).toContainText(option);
    page.once("dialog", (d) => d.accept("test swap"));
    await cell.getByRole("button", { name: `Remove ${option} from`, exact: false }).click();
    await expect(page.getByRole("status")).toContainText(`${option} removed`);
    await expect(cell.getByRole("button", { name: new RegExp(`Remove ${option}`) })).toHaveCount(0);
  });

  test.describe("as an RT", () => {
    test.use({ storageState: STATE.rt });
    test("an RT sees the roster read-only", async ({ page }) => {
      await page.goto("/shifts");
      await expect(page.getByRole("heading", { name: "Roster", exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: /Add staff to/ })).toHaveCount(0);
    });
  });
});

test.describe("handover: write, then acknowledged by someone else", () => {
  test.describe.configure({ mode: "serial" });

  test("the Chief RT writes the current shift's handover with linked open items", async ({ page }) => {
    await page.goto("/handover");
    const form = page.getByRole("form", { name: /Write handover/ }).first();
    await expect(form).toBeVisible();
    await form.getByLabel("Handover notes").fill("E2E synthetic handover note");
    await form.getByRole("button", { name: "Submit handover" }).click();
    const card = page.locator("article").filter({ hasText: "E2E synthetic handover note" });
    await expect(card).toContainText("Awaiting acknowledgment");
    await expect(card).toContainText("live status");
    // The author cannot acknowledge their own handover.
    await expect(card.getByRole("button", { name: "Acknowledge handover" })).toHaveCount(0);
  });

  test.describe("incoming RT", () => {
    test.use({ storageState: STATE.rt });
    test("another RT acknowledges it; it is then recorded with who and when", async ({ page }) => {
      await page.goto("/handover");
      const card = page.locator("article").filter({ hasText: "E2E synthetic handover note" });
      await card.getByRole("button", { name: "Acknowledge handover" }).click();
      await expect(card).toContainText("Acknowledged");
      await expect(card).toContainText("by RT Bravo (Demo)");
    });
  });
});

import { HOSPITAL_TZ, toLocalParts } from "../../src/lib/time/zoned";
import { STATE } from "./env";
import { expect, test } from "./fixtures";

const z = (n: number) => String(n).padStart(2, "0");
/** Asia/Manila wall time, as the datetime-local inputs expect. */
function manila(d: Date) {
  const p = toLocalParts(d, HOSPITAL_TZ);
  return { date: `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`, hm: `${z(p.hour)}:${z(p.minute)}` };
}

async function pickPatient(page: import("@playwright/test").Page, query: string) {
  await page.getByLabel("Patient").fill(query);
  await page.getByRole("listbox", { name: "Matching patients" }).getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "Change" })).toBeVisible();
}

test.describe("nebulization (RT)", () => {
  test.use({ storageState: STATE.rt });
  test.describe.configure({ mode: "serial" });
  const ref = `SYN-E2E-${Date.now() % 100000}`;

  test("an RT enters an order; its written time appears on the worklist as an expected dose", async ({ page }) => {
    await page.goto("/nebulization");
    await page.getByRole("link", { name: "New order" }).click();
    await pickPatient(page, "SYN-1002");
    await page.getByLabel(/Order date\/time/).fill(manila(new Date(Date.now() - 3 * 3_600_000)).date);
    await page.getByLabel(/Attending physician/).fill("Dr. Demo E2E");
    await page.getByLabel(/Medication exactly as ordered/).fill(`Medication as written (synthetic) ${ref}`);
    await page.getByRole("radio", { name: "Q12H" }).click();
    // The current minute is always inside the current operational day and not in the future.
    await page.getByLabel(/First dose time/).fill(manila(new Date()).hm);
    await expect(page.getByTestId("neb-dose-preview").locator("span")).toHaveCount(2);
    await page.getByRole("button", { name: "Save order" }).click();
    await expect(page).toHaveURL(/\/nebulization$/);
    await page.getByRole("button", { name: /All doses today/ }).click();
    await page.getByRole("searchbox", { name: /Search Nebulization worklist/i }).fill(ref);
    // Q12H from the current minute: this dose (Pending) and, if still today, the one 12 h later (Scheduled).
    const row = page.locator("table").first().locator("tr").filter({ hasText: ref }).first();
    await expect(row).toContainText("Pending");
  });

  test("document the dose as given, then void it with a reason (the dose re-opens)", async ({ page }) => {
    await page.goto("/nebulization");
    await page.getByRole("button", { name: /All doses today/ }).click();
    await page.getByRole("searchbox", { name: /Search Nebulization worklist/i }).fill(ref);
    const row = page.locator("table").first().locator("tr").filter({ hasText: ref }).first();
    await row.getByRole("button", { name: "Document" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("radio", { name: "Given", exact: true })).toBeChecked();
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText("Completed");
    await expect(row).toContainText("RT Bravo (Demo)");

    await row.getByRole("button", { name: "Void" }).click();
    await page
      .getByRole("dialog")
      .getByLabel(/Reason/)
      .fill("Documented against the wrong patient (test)");
    await page.getByRole("dialog").getByRole("button", { name: "Void entry" }).click();
    await expect(row).toContainText("Pending");
  });

  test("a not-given outcome requires a reason", async ({ page }) => {
    await page.goto("/nebulization");
    await page.getByRole("button", { name: /All doses today/ }).click();
    await page.getByRole("searchbox", { name: /Search Nebulization worklist/i }).fill(ref);
    const row = page.locator("table").first().locator("tr").filter({ hasText: ref }).first();
    await row.getByRole("button", { name: "Document" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("radio", { name: "Refused" }).check();
    await dlg.getByLabel(/Reason/).fill("Patient declined; physician informed (synthetic)");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText("Refused");
    await expect(row).toContainText("Patient declined");
  });
});

test.describe("orders are RT-only (decision 2026-11-22)", () => {
  test("the Chief RT has no New order button and is refused by the server", async ({ page }) => {
    await page.goto("/nebulization");
    await expect(page.getByRole("link", { name: "New order" })).toHaveCount(0);
    await page.getByRole("button", { name: /Active orders/ }).click();
    await expect(page.getByRole("button", { name: "Discontinue", exact: true })).toHaveCount(0);
    await page.goto("/nebulization/orders/new");
    await expect(page.getByTestId("access-denied")).toBeVisible();
  });
});

test.describe("ventilation and tubing (RT)", () => {
  test.use({ storageState: STATE.rt });
  test.describe.configure({ mode: "serial" });
  const name = `Ventflow, Synthetic ${Date.now() % 100000}`;
  let vent = `VENT-E2E-${Date.now() % 10000}`;

  test("hook-in with a documented new circuit, replace tubing, then disconnect", async ({ page }) => {
    // A fresh patient so no overlapping encounter exists.
    await page.goto("/patients/new");
    await page.getByLabel(/Full name/).fill(name);
    await page.getByRole("radio", { name: "Female" }).check();
    await page.getByLabel(/Category/).selectOption("INP");
    await page.getByRole("button", { name: "Register patient" }).click();
    await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);

    await page.goto("/ventilation/new");
    await pickPatient(page, name.split(",")[0]);
    // The equipment board has ventilators, so hook-in must pick a free board unit (no typed names).
    const unitSelect = page.getByLabel(/Ventilator \(free units\)/);
    await unitSelect.selectOption({ index: 1 });
    vent = ((await unitSelect.locator("option:checked").textContent()) ?? "").split(" · ")[0].trim();
    await page.getByLabel(/Ward \/ room/).fill("ICU-E2E");
    await page.getByLabel(/Hook-in time/).fill(manila(new Date(Date.now() - 60 * 60_000)).date);
    await page.getByLabel(/new ventilator circuit was installed/).check();
    await page.getByRole("button", { name: "Record hook-in" }).click();
    await expect(page).toHaveURL(/\/ventilation$/);

    await page.goto("/tubing");
    const row = page.locator("tr").filter({ hasText: vent });
    await expect(row).toContainText("Current");
    await row.getByRole("button", { name: "Change tubing" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel(/Reason/).selectOption("Visibly soiled / contaminated");
    await dlg.getByRole("button", { name: "Save change of tubing" }).click();
    await row.getByText(/event\(s\)/).click();
    await expect(row).toContainText("Visibly soiled");
    await expect(row).toContainText("New circuit installed at hook-in");

    await page.goto("/ventilation");
    await page.getByRole("searchbox", { name: /Search Ventilator encounters/i }).fill(vent);
    const v = page.locator("tr").filter({ hasText: vent });
    await expect(v).toContainText("No settings recorded");
    await v.getByRole("button", { name: "Record settings" }).click();
    const sd = page.getByRole("dialog");
    await sd.getByLabel(/^Mode/).selectOption("VC_AC");
    await sd.getByLabel(/FiO₂/).fill("210");
    await sd.getByLabel(/PEEP/).fill("5");
    await sd.getByRole("button", { name: "Save settings" }).click();
    await expect(sd).toContainText("between 21 and 100"); // typo is stopped, nothing saved
    await sd.getByLabel(/FiO₂/).fill("40");
    await sd.getByLabel(/^Tidal volume/).fill("450");
    await sd.getByLabel(/^Rate/).fill("14");
    await sd.getByRole("button", { name: "Save settings" }).click();
    await expect(sd).toBeHidden();
    await expect(v).toContainText("Volume control A/C · FiO₂ 40% · PEEP 5 · Vt 450 · RR 14");

    await v.getByRole("link", { name: "Flowsheet" }).click();
    await expect(page.getByRole("heading", { name: "Mechanical Ventilation Flowsheet" })).toBeVisible();
    const fs = page.locator("table").first();
    await expect(fs).toContainText("Volume control A/C");
    await expect(fs.locator("tbody tr").first()).toContainText("450");
    await expect(page.getByText("New circuit installed at hook-in")).toBeVisible();
    await expect(page.getByRole("button", { name: "Print flowsheet" })).toBeVisible();
    await page.goto("/ventilation");
    await page.getByRole("searchbox", { name: /Search Ventilator encounters/i }).fill(vent);

    await v.getByRole("button", { name: "Disconnect" }).click();
    const dd = page.getByRole("dialog");
    await dd.getByLabel(/^Reason/).selectOption("EXTUBATED");
    await dd.getByRole("button", { name: "Record disconnection" }).click();
    await expect(v).toContainText("Discontinued");
    await expect(v).toContainText("Extubated");
  });
});

test.describe("MGH removes the patient from nebulization (Chief RT)", () => {
  test("marking MGH discontinues the patient's neb orders; undo keeps them stopped", async ({ page }) => {
    await page.goto("/nebulization");
    const cards = page.getByTestId("neb-order-cards");
    const link = cards.locator("a[href^='/patients/']").last();
    const name = ((await link.textContent()) ?? "").trim();
    await link.click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await page.getByRole("button", { name: "Mark MGH" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("automatically discontinues");
    await dlg.getByRole("button", { name: "Mark MGH" }).click();
    await expect(page.getByTestId("mgh-banner")).toContainText("MGH (may go home)");
    await page.goto("/nebulization");
    await expect(page.getByTestId("neb-order-cards").getByRole("link", { name, exact: true })).toHaveCount(0);
    await page.goto("/patients");
    await page.getByRole("searchbox", { name: /search patient masterlist/i }).fill(name);
    await expect(page.locator("table").getByText("MGH", { exact: true }).first()).toBeVisible();
    await page.locator("a[href^='/patients/']").filter({ hasText: name }).first().click();
    await page.getByRole("button", { name: "Undo MGH" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Undo MGH" }).click();
    await expect(page.getByTestId("mgh-banner")).toHaveCount(0);
  });
});

// Writes a messy, fully synthetic PFT scheduling workbook for trying the import wizard.
// Usage: npm run fixture:workbook  → synthetic-pft-schedule.xlsx
import { writeFileSync } from "node:fs";
import { buildSyntheticWorkbook } from "../tests/fixtures/syntheticWorkbook";

buildSyntheticWorkbook(Number(process.argv[2] ?? new Date().getFullYear())).then((b) => {
  writeFileSync("synthetic-pft-schedule.xlsx", b);
  console.log(`wrote synthetic-pft-schedule.xlsx (${b.length} bytes) — synthetic data only`);
});

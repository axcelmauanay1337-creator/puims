import ExcelJS from "exceljs";

/**
 * A deliberately MESSY, fully SYNTHETIC scheduling workbook that reproduces the layout problems
 * described in DATA_IMPORT_AND_PFT_SPEC.md §2 — without any real patient data:
 *  - a title row above the header; "DATE" on one sheet and a generic "Column 1" on another;
 *  - separate AGE / SEX columns on one sheet, combined "Age / Sex" on the other;
 *  - real date cells, text dates, an ambiguous date, a malformed year, a year typo, a missing date;
 *  - a contact column holding a note instead of a number, and a payment column (neither may be imported, U-08/U-09);
 *  - status variants, an unknown status, a repeated patient and an exact duplicate row.
 */
export async function buildSyntheticWorkbook(year = 2025): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const june = wb.addWorksheet("JUNE");
  june.addRow(["PULMONARY UNIT — PFT SCHEDULE (SYNTHETIC)"]);
  june.addRow([]);
  june.addRow(["DATE", "TIME", "NAME", "AGE", "SEX", "CONTACT NO.", "PHYSICIAN", "PROCEDURE", "STATUS", "OPD/INP", "RT SCHEDULER", "REMARKS"]);
  const d = (m: number, day: number) => new Date(Date.UTC(year, m - 1, day));
  june.addRow([
    d(6, 2),
    "8:00 AM",
    "Demo, Patient Alpha",
    45,
    "M",
    "SYN-0917-000-0001",
    "Dr. Demo Requesting",
    "Simple PFT",
    "Done",
    "OPD",
    "RT Demo Scheduler",
    "",
  ]); // 4 clean
  june.addRow([
    d(6, 3),
    "9:30 AM",
    "Demo, Patient Bravo",
    62,
    "F",
    "call relative (SYN note)",
    "Dr. Demo Requesting",
    "Complete PFT with post-bronchodilator",
    "no-show",
    "OPD",
    "",
    "",
  ]); // 5 clean
  june.addRow(["6/4/" + year, "10:00 AM", "Demo, Patient Charlie", 51, "Female", "", "Dr. Demo Requesting", "Simple PFT", "pending", "INP", "", ""]); // 6 ambiguous date
  june.addRow(["06/25/" + year + "5", "1:00 PM", "Demo, Patient Delta", 39, "M", "", "Dr. Demo Requesting", "PFT with DLCO", "cancelled", "OPD", "", ""]); // 7 malformed year
  june.addRow(["", "2:00 PM", "Demo, Patient Echo", 70, "M", "", "Dr. Demo Requesting", "Simple PFT", "for resched", "OPD", "", ""]); // 8 missing date
  june.addRow([d(6, 9), "8:00", "Demo, Patient Foxtrot", 28, "F", "", "Dr. Demo Requesting", "Simple PFT", "Maybe?", "OPD", "", ""]); // 9 no meridiem + unknown status
  june.addRow([d(6, 2), "8:00 AM", "Demo, Patient Alpha", 45, "M", "", "Dr. Demo Requesting", "Simple PFT", "Done", "OPD", "", "entered twice"]); // 10 exact duplicate of row 4
  june.addRow([]); // blank — skipped and counted
  june.addRow([d(6, 30), "3:00 PM", "", 33, "X", "", "Dr. Demo Requesting", "", "", "", "", ""]); // 12 missing name, procedure, status, category; uncertain sex

  const july = wb.addWorksheet("JULY");
  july.addRow(["Column 1", "TIME", "PATIENT NAME", "Age / Sex", "CONTACT INFO", "PHYSICIAN", "PROCEDURE", "STATUS", "OPD/INP", "PAYMENT"]);
  july.addRow([
    d(7, 1),
    "8:00 AM",
    "Demo, Patient Bravo",
    "62/F",
    "SYN-0917-000-0002",
    "Dr. Demo Requesting",
    "Simple PFT",
    "Rescheduled",
    "OPD",
    "SYN-HMO-PLAN",
  ]); // 2 repeat visit of Bravo
  july.addRow([`July 2, ${year - 1}`, "9:00 AM", "Demo, Patient Golf", "8 mos/F", "", "Dr. Demo Requesting", "Simple PFT", "completed", "OPD"]); // 3 year typo + uncertain age
  july.addRow(["July 3", "10:00 AM", "Demo, Patient Hotel", "55 y/o M", "", "Dr. Demo Requesting", "Simple PFT", "scheduled", "OPD"]); // 4 no year
  july.addRow([d(8, 1), "11:00 AM", "Demo, Patient India", "41/M", "", "Dr. Demo Requesting", "Simple PFT", "scheduled", "INP"]); // 5 August date on JULY sheet
  return Buffer.from(await wb.xlsx.writeBuffer());
}

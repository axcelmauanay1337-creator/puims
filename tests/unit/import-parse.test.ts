import { describe, expect, it } from "vitest";
import {
  csvField,
  DEFAULT_OPTIONS,
  detectHeaderRow,
  effectiveRow,
  parseAgeSex,
  parseCategory,
  parseDateCell,
  parseRow,
  parseStatus,
  parseTimeCell,
  scrubRaw,
  sheetMonth,
  suggestMapping,
  validateResolution,
  type ImportOptions,
  type RawCell,
} from "@/lib/import/parse";

const s = (v: string): RawCell => ({ t: "s", v });
const n = (v: number): RawCell => ({ t: "n", v });
const d = (iso: string): RawCell => ({ t: "d", v: iso });
const opts = (o: Partial<ImportOptions> = {}): ImportOptions => ({ ...DEFAULT_OPTIONS, ...o });

describe("dates — never guessed, never silently corrected", () => {
  it("reads real spreadsheet date cells and serial numbers", () => {
    expect(parseDateCell(d("2025-06-03T00:00:00.000Z"), opts()).date).toBe("2025-06-03");
    expect(parseDateCell(n(45811), opts()).date).toBe("2025-06-03");
  });
  it("flags missing dates instead of inferring them", () => {
    expect(parseDateCell(null, opts())).toEqual({ date: null, flags: ["DATE_MISSING"] });
    expect(parseDateCell(s("  "), opts()).flags).toEqual(["DATE_MISSING"]);
  });
  it("flags ambiguous day/month order unless the reviewer declared it", () => {
    expect(parseDateCell(s("6/3/2025"), opts()).flags).toEqual(["DATE_AMBIGUOUS"]);
    expect(parseDateCell(s("6/3/2025"), opts({ dateOrder: "MDY" })).date).toBe("2025-06-03");
    expect(parseDateCell(s("6/3/2025"), opts({ dateOrder: "DMY" })).date).toBe("2025-03-06");
    // unambiguous without a declaration
    expect(parseDateCell(s("25/06/2025"), opts()).date).toBe("2025-06-25");
    expect(parseDateCell(s("06/25/2025"), opts()).date).toBe("2025-06-25");
    expect(parseDateCell(s("7/7/2025"), opts()).date).toBe("2025-07-07");
  });
  it("treats a value that contradicts the declared order as impossible, not swapped", () => {
    expect(parseDateCell(s("25/06/2025"), opts({ dateOrder: "MDY" })).flags).toEqual(["DATE_IMPOSSIBLE"]);
  });
  it("never fixes an apparent year typo", () => {
    expect(parseDateCell(s("06/25/20255"), opts()).flags).toEqual(["YEAR_MALFORMED"]);
    expect(parseDateCell(s("06/25/205"), opts()).flags).toEqual(["YEAR_MALFORMED"]);
    expect(parseDateCell(s("06/25/2052"), opts({ workbookYear: 2025 })).flags).toEqual(["YEAR_MISMATCH"]);
    expect(parseDateCell(d("2052-06-25T00:00:00.000Z"), opts({ workbookYear: 2025 })).flags).toEqual(["YEAR_MISMATCH"]);
    expect(parseDateCell(s("06/25/1925"), opts()).flags).toEqual(["DATE_IMPOSSIBLE"]);
  });
  it("uses the stated workbook year only for dates written without one, and says so", () => {
    expect(parseDateCell(s("June 25"), opts())).toEqual({ date: null, flags: ["YEAR_MISSING"] });
    const r = parseDateCell(s("June 25"), opts({ workbookYear: 2025 }), "JUNE");
    expect(r).toEqual({ date: "2025-06-25", flags: ["YEAR_FROM_WORKBOOK"] });
    expect(parseDateCell(s("6/25/25"), opts({ workbookYear: 2025 })).date).toBe("2025-06-25");
    expect(parseDateCell(s("6/25/24"), opts({ workbookYear: 2025 })).flags).toEqual(["YEAR_MISMATCH"]);
    expect(parseDateCell(s("6/25/25"), opts()).flags).toEqual(["YEAR_MISSING"]);
  });
  it("reads month names and rejects non-existent days", () => {
    expect(parseDateCell(s("June 3, 2025"), opts()).date).toBe("2025-06-03");
    expect(parseDateCell(s("3 Jun 2025"), opts()).date).toBe("2025-06-03");
    expect(parseDateCell(s("3-Jun-2025"), opts()).date).toBe("2025-06-03");
    expect(parseDateCell(s("February 30, 2025"), opts()).flags).toEqual(["DATE_IMPOSSIBLE"]);
    expect(parseDateCell(s("Junly 3, 2025"), opts()).flags).toEqual(["DATE_MALFORMED"]);
    expect(parseDateCell(s("next week"), opts()).flags).toEqual(["DATE_MALFORMED"]);
  });
  it("warns (does not block) when the month differs from the worksheet's month", () => {
    expect(parseDateCell(s("July 1, 2025"), opts(), "JUNE")).toEqual({ date: "2025-07-01", flags: ["SHEET_MONTH_MISMATCH"] });
    expect(sheetMonth("SEPTEMBER")).toBe(9);
    expect(sheetMonth("Sept 2025")).toBe(9);
    expect(sheetMonth("Sheet1")).toBeNull();
  });
});

describe("times", () => {
  it("reads AM/PM, noon and spreadsheet time values", () => {
    expect(parseTimeCell(s("8:00 AM"), opts()).time).toBe("08:00");
    expect(parseTimeCell(s("1:30pm"), opts()).time).toBe("13:30");
    expect(parseTimeCell(s("12:00 A.M."), opts()).time).toBe("00:00");
    expect(parseTimeCell(s("12 NN"), opts()).time).toBe("12:00");
    expect(parseTimeCell(s("9 AM"), opts()).time).toBe("09:00");
    expect(parseTimeCell(n(0.375), opts()).time).toBe("09:00");
    expect(parseTimeCell(d("1899-12-30T14:15:00.000Z"), opts()).time).toBe("14:15");
  });
  it("does not assume AM/PM", () => {
    expect(parseTimeCell(s("8:00"), opts()).flags).toEqual(["TIME_NO_MERIDIEM"]);
    expect(parseTimeCell(s("8:00"), opts({ times24h: true })).time).toBe("08:00");
    expect(parseTimeCell(s("14:00"), opts()).time).toBe("14:00");
  });
  it("flags missing and malformed times", () => {
    expect(parseTimeCell(null, opts()).flags).toEqual(["TIME_MISSING"]);
    for (const v of ["8", "25:00", "13:00 PM", "8:75 AM", "morning"]) expect(parseTimeCell(s(v), opts()).flags).toEqual(["TIME_MALFORMED"]);
  });
});

describe("age / sex — raw kept, only clear values normalized (M/F only)", () => {
  it("parses separate and combined columns", () => {
    expect(parseAgeSex(n(45), s("M"), null)).toEqual({ ageYears: 45, sex: "M", raw: "45 | M", uncertain: false });
    expect(parseAgeSex(null, null, s("45/F"))).toMatchObject({ ageYears: 45, sex: "F", uncertain: false });
    expect(parseAgeSex(null, null, s("62 y/o Male"))).toMatchObject({ ageYears: 62, sex: "M" });
    expect(parseAgeSex(null, null, s("F / 30"))).toMatchObject({ ageYears: 30, sex: "F" });
  });
  it("marks anything unclear as uncertain and normalizes nothing", () => {
    expect(parseAgeSex(null, null, s("8 mos/F"))).toEqual({ ageYears: null, sex: null, raw: "8 mos/F", uncertain: true });
    expect(parseAgeSex(n(45), s("X"), null)).toMatchObject({ sex: null, ageYears: null, uncertain: true });
    expect(parseAgeSex(n(45), null, s("50/M"))).toMatchObject({ uncertain: true });
    expect(parseAgeSex(null, null, null)).toEqual({ ageYears: null, sex: null, raw: "", uncertain: false });
  });
});

describe("status and category", () => {
  it("maps known variants and keeps unknown ones flagged", () => {
    expect(parseStatus(s("Done")).status).toBe("COMPLETED");
    expect(parseStatus(s("no-show")).status).toBe("NO_SHOW");
    expect(parseStatus(s("CANCELLED")).status).toBe("CANCELLED");
    expect(parseStatus(s("for resched")).status).toBe("FOR_RESCHEDULE");
    expect(parseStatus(s("Rescheduled")).status).toBe("RESCHEDULED");
    expect(parseStatus(s("pending")).status).toBe("PENDING");
    expect(parseStatus(s("maybe?")).flags).toEqual(["STATUS_UNKNOWN"]);
    expect(parseStatus(null).flags).toEqual(["STATUS_MISSING"]);
  });
  it("uses a declared category only for empty cells", () => {
    expect(parseCategory(s("opd"), opts()).category).toBe("OPD");
    expect(parseCategory(s("In-patient"), opts()).category).toBe("INP");
    expect(parseCategory(null, opts()).flags).toEqual(["CATEGORY_MISSING"]);
    expect(parseCategory(null, opts({ categoryWhenMissing: "OPD" }))).toEqual({ category: "OPD", flags: ["CATEGORY_FROM_DECLARATION"] });
    expect(parseCategory(s("ER"), opts({ categoryWhenMissing: "OPD" })).flags).toEqual(["CATEGORY_UNKNOWN"]);
  });
});

describe("headers and mapping", () => {
  const rows: RawCell[][] = [
    [s("PULMONARY UNIT — JUNE")],
    [],
    [s("DATE"), s("TIME"), s("NAME"), s("AGE"), s("SEX"), s("CONTACT NO."), s("PHYSICIAN"), s("PROCEDURE"), s("STATUS")],
  ];
  it("finds the header row below title rows", () => {
    expect(detectHeaderRow(rows)).toBe(3);
    expect(detectHeaderRow([[s("just a title")]])).toBeNull();
  });
  it("suggests a mapping, and only suggests a generic 'Column 1' as Date when the values look like dates", () => {
    const { mapping } = suggestMapping(
      rows[2].map((c) => (c.t === "s" ? c.v : "")),
      [],
    );
    expect(mapping).toMatchObject({ 0: "DATE", 1: "TIME", 2: "PATIENT_NAME", 3: "AGE", 4: "SEX", 5: "CONTACT", 6: "PHYSICIAN", 7: "PROCEDURE", 8: "STATUS" });
    const body = [[d("2025-07-01T00:00:00Z")], [s("7/2/2025")], [s("July 3")], [s("x")]];
    const r = suggestMapping(["Column 1", "Age / Sex"], body);
    expect(r.mapping).toEqual({ 0: "DATE", 1: "AGE_SEX" });
    expect(r.inferredFromValues).toEqual([0]);
    expect(suggestMapping(["Column 1"], [[s("a")], [s("b")], [s("c")]]).mapping).toEqual({});
  });
});

describe("row parsing", () => {
  const mapping = { 0: "DATE", 1: "TIME", 2: "PATIENT_NAME", 3: "AGE_SEX", 4: "CONTACT", 5: "PROCEDURE", 6: "STATUS", 7: "CATEGORY" } as const;
  const row = {
    0: s("6/25/2025"),
    1: s("9:00 AM"),
    2: s("Demo, Patient Q"),
    3: s("45/M"),
    4: s("SYN note: call relative"),
    5: s("Simple PFT"),
    6: s("Done"),
    7: s("OPD"),
  };
  it("keeps payment (U-09 approved 2026-11-23)", () => {
    expect(scrubRaw({ 0: s("x"), 1: s("HMO") }, { 0: "PATIENT_NAME", 1: "PAYMENT" })).toEqual({ 0: s("x"), 1: s("HMO") });
    expect(parseRow({ 1: s("HMO") }, { 1: "PAYMENT" }, opts(), "JUNE").parsed.payment).toBe("HMO");
  });
  it("keeps contact exactly as written, never parsed as a phone number (U-08 approved 2026-11-23)", () => {
    expect(scrubRaw(row, mapping)).toHaveProperty("4");
    const r = parseRow(row, mapping, opts({ dateOrder: "MDY" }), "JUNE");
    expect(r.parsed.contactNote).toBe("SYN note: call relative");
    expect(r.flags).toContain("CONTACT_AS_NOTE");
    // two contact columns are joined, not merged or reformatted
    expect(parseRow({ 0: s("0917 000 0001"), 1: s("ask for daughter") }, { 0: "CONTACT", 1: "CONTACT" }, opts(), "JUNE").parsed.contactNote).toBe(
      "0917 000 0001 / ask for daughter",
    );
  });
  it("produces a clean row with only informational flags", () => {
    const r = parseRow(row, mapping, opts({ dateOrder: "MDY" }), "JUNE");
    expect(r.parsed).toMatchObject({
      date: "2025-06-25",
      time: "09:00",
      name: "Demo, Patient Q",
      ageYears: 45,
      sex: "M",
      status: "COMPLETED",
      category: "OPD",
    });
    expect(r.flags).toEqual(["CONTACT_AS_NOTE"]);
    expect(effectiveRow(r.parsed, r.flags, {}).blocking).toEqual([]);
  });
  it("reports every blocking problem and clears each only by an explicit resolution", () => {
    const bad = parseRow({ 0: s("6/3/2025"), 1: s("8:00"), 6: s("??") }, mapping, opts(), "JUNE");
    expect(bad.flags).toEqual(
      expect.arrayContaining(["DATE_AMBIGUOUS", "TIME_NO_MERIDIEM", "NAME_MISSING", "STATUS_UNKNOWN", "CATEGORY_MISSING", "PROCEDURE_MISSING"]),
    );
    const e1 = effectiveRow(bad.parsed, bad.flags, { date: "2025-06-03", time: "08:00" });
    expect(e1.blocking).toEqual(expect.arrayContaining(["NAME_MISSING", "STATUS_UNKNOWN", "CATEGORY_MISSING", "PROCEDURE_MISSING"]));
    expect(e1.blocking).not.toContain("DATE_AMBIGUOUS");
    const e2 = effectiveRow(bad.parsed, bad.flags, {
      date: "2025-06-03",
      time: "08:00",
      name: "Demo X",
      status: "SCHEDULED",
      category: "OPD",
      procedure: "Simple PFT",
    });
    expect(e2.blocking).toEqual([]);
    expect(e2).toMatchObject({ date: "2025-06-03", status: "SCHEDULED", name: "Demo X" });
  });
  it("validates reviewer values", () => {
    expect(validateResolution("date", "2025-02-30")).not.toBeNull();
    expect(validateResolution("date", "2025-02-28")).toBeNull();
    expect(validateResolution("time", "24:00")).not.toBeNull();
    expect(validateResolution("status", "DONE")).not.toBeNull();
  });
});

describe("CSV safety", () => {
  it("neutralizes formula injection and quotes properly", () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@SUM")).toBe("'@SUM");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField(null)).toBe("");
    expect(csvField(12)).toBe("12");
  });
});

describe("text is kept exactly as written in the workbook", () => {
  it("does not trim, collapse or re-case names, procedures or remarks", () => {
    const r = parseRow(
      { 0: s("June 3, 2025"), 1: s("9:00 AM"), 2: s("  DELA CRUZ,  Juan  "), 3: s("Simple  PFT"), 4: s("Done"), 5: s("OPD"), 6: s("call  after 5pm ") },
      { 0: "DATE", 1: "TIME", 2: "PATIENT_NAME", 3: "PROCEDURE", 4: "STATUS", 5: "CATEGORY", 6: "REMARKS" },
      opts(),
      "JUNE",
    );
    expect(r.parsed.name).toBe("  DELA CRUZ,  Juan  ");
    expect(r.parsed.procedure).toBe("Simple  PFT");
    expect(r.parsed.remarks).toBe("call  after 5pm ");
    expect(r.parsed.rawStatus).toBe("Done");
  });
});

/**
 * Conservative parsing of legacy scheduling workbooks (DATA_IMPORT_AND_PFT_SPEC.md §2–5).
 *
 * Pure and isomorphic so every rule is unit-tested. Rules:
 *  - Never silently change an apparent year typo; never infer a missing date.
 *  - Ambiguous day/month order is only resolved by an explicit reviewer declaration.
 *  - Times without AM/PM are only read as 24-hour clock when the reviewer says so.
 *  - Contact info is kept exactly as written and never interpreted as a phone number (U-08, approved 2026-11-23).
 *  - The raw age/sex text is always kept; normalized values are derived separately.
 *  - Every problem becomes a flag; blocking flags must be resolved by a person.
 */
import type { DiagnosticStatus, PatientCategory } from "@/lib/clinical/vocabulary";

export type RawCell = { t: "s"; v: string } | { t: "n"; v: number } | { t: "d"; v: string /* ISO, UTC parts = wall date/time */ } | { t: "b"; v: boolean };

export const IMPORT_FIELDS = [
  "DATE",
  "TIME",
  "PATIENT_NAME",
  "AGE",
  "SEX",
  "AGE_SEX",
  "CATEGORY",
  "PHYSICIAN",
  "PROCEDURE",
  "STATUS",
  "PAYMENT",
  "SCHEDULER",
  "PERFORMED_BY",
  "REMARKS",
  "CONTACT",
  "IGNORE",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  DATE: "Date",
  TIME: "Time",
  PATIENT_NAME: "Patient name",
  AGE: "Age",
  SEX: "Sex",
  AGE_SEX: "Age / Sex (combined)",
  CATEGORY: "OPD / INP",
  PHYSICIAN: "Requesting physician",
  PROCEDURE: "Procedure",
  STATUS: "Status",
  PAYMENT: "Payment",
  SCHEDULER: "RT scheduler (name kept as text)",
  PERFORMED_BY: "Performed by (name kept as text)",
  REMARKS: "Remarks",
  CONTACT: "Contact info (kept as written)",
  IGNORE: "Ignore column",
};

/** Column index (0-based) → field. */
export type ColumnMapping = Record<number, ImportField>;

export interface ImportOptions {
  /** How numeric text dates such as 6/3/2025 are written. null = undeclared → ambiguous dates are flagged. */
  dateOrder: "MDY" | "DMY" | null;
  /** The year the workbook covers, stated by the reviewer. Used only for dates written without a year. */
  workbookYear: number | null;
  /** Reviewer declares that times without AM/PM are 24-hour clock. */
  times24h: boolean;
  /** Reviewer declares the category for rows whose OPD/INP cell is empty. */
  categoryWhenMissing: PatientCategory | null;
  /** Set when PUIMS filled these settings itself on upload (shown to the reviewer; any change replaces it). */
  auto?: string[];
}

export const DEFAULT_OPTIONS: ImportOptions = { dateOrder: null, workbookYear: null, times24h: false, categoryWhenMissing: null };

// ---------------------------------------------------------------- flags

export const FLAG_INFO = {
  DATE_MISSING: { blocking: true, field: "date", label: "Date is empty (never inferred)" },
  DATE_MALFORMED: { blocking: true, field: "date", label: "Date could not be read" },
  DATE_AMBIGUOUS: { blocking: true, field: "date", label: "Day/month order is ambiguous" },
  DATE_IMPOSSIBLE: { blocking: true, field: "date", label: "Date does not exist or is out of range" },
  YEAR_MALFORMED: { blocking: true, field: "date", label: "Year looks mistyped — not corrected automatically" },
  YEAR_MISMATCH: { blocking: true, field: "date", label: "Year differs from the stated workbook year — not corrected automatically" },
  YEAR_MISSING: { blocking: true, field: "date", label: "Date has no year and no workbook year was stated" },
  YEAR_FROM_WORKBOOK: { blocking: false, field: "date", label: "Year taken from the stated workbook year" },
  SHEET_MONTH_MISMATCH: { blocking: false, field: "date", label: "Month differs from the worksheet's month" },
  TIME_MISSING: { blocking: true, field: "time", label: "Time is empty" },
  TIME_MALFORMED: { blocking: true, field: "time", label: "Time could not be read" },
  TIME_NO_MERIDIEM: { blocking: true, field: "time", label: "Time has no AM/PM" },
  NAME_MISSING: { blocking: true, field: "name", label: "Patient name is empty" },
  NAME_SUSPECT: { blocking: false, field: "name", label: "Name contains digits or symbols" },
  AGE_SEX_UNCERTAIN: { blocking: false, field: null, label: "Age/sex could not be normalized (raw value kept)" },
  STATUS_MISSING: { blocking: true, field: "status", label: "Status is empty" },
  STATUS_UNKNOWN: { blocking: true, field: "status", label: "Status not recognized" },
  CATEGORY_MISSING: { blocking: false, field: "category", label: "OPD/INP not stated — saved as “Other / not stated” (correct later if known)" },
  CATEGORY_UNKNOWN: { blocking: true, field: "category", label: "OPD/INP not recognized" },
  CATEGORY_FROM_DECLARATION: { blocking: false, field: "category", label: "OPD/INP taken from the reviewer's declaration" },
  PROCEDURE_MISSING: { blocking: true, field: "procedure", label: "Procedure is empty" },
  VALUE_TOO_LONG: { blocking: true, field: null, label: "A value is longer than PUIMS allows" },
  CONTACT_AS_NOTE: { blocking: false, field: null, label: "Contact kept exactly as written — not checked as a phone number" },
  // added by the server against the database / the rest of the batch
  NAME_MATCHES_EXISTING: { blocking: false, field: null, label: "Name matches an existing patient — choose the patient explicitly" },
  NAME_REPEATS_IN_BATCH: { blocking: false, field: null, label: "Name appears on other rows — repeat visit or a different person?" },
  DUPLICATE_CANDIDATE: { blocking: false, field: null, label: "Possible duplicate (same name, date, time, procedure) — never auto-discarded" },
} as const;
export type ImportFlag = keyof typeof FLAG_INFO;
export type ResolvableField = "date" | "time" | "name" | "status" | "category" | "procedure";

// ---------------------------------------------------------------- header detection

const norm = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const HEADER_SYNONYMS: Array<[ImportField, RegExp]> = [
  ["AGE_SEX", /^(AGE ?\/ ?SEX|AGE SEX|AGE ?\/ ?GENDER|SEX ?\/ ?AGE)$/],
  ["DATE", /^(DATE|DATE OF (PFT|TEST|PROCEDURE|APPOINTMENT)|SCHEDULE DATE|SCHED DATE)$/],
  ["TIME", /^(TIME|SCHEDULE TIME|SCHED TIME)$/],
  ["PATIENT_NAME", /^(NAME|PATIENT|PATIENT NAME|PATIENTS NAME|NAME OF PATIENT|FULL NAME)$/],
  ["AGE", /^AGE$/],
  ["SEX", /^(SEX|GENDER)$/],
  ["CATEGORY", /^(OPD ?\/ ?INP|OPD ?\/ ?IN ?PATIENT|INP ?\/ ?OPD|CATEGORY|PATIENT TYPE|OPD INP)$/],
  ["CONTACT", /^(CONTACT|CONTACT NO|CONTACT NUMBER|CONTACT INFO|CONTACT DETAILS|CP|CP NO|CELLPHONE|MOBILE|PHONE|TEL|TEL NO)$/],
  ["PHYSICIAN", /^(PHYSICIAN|DOCTOR|DR|REQUESTING PHYSICIAN|REQUESTING DOCTOR|ATTENDING PHYSICIAN|AP)$/],
  ["PROCEDURE", /^(PROCEDURE|TEST|PROCEDURE ?\/ ?TEST|TEST TYPE|TYPE OF TEST|EXAM)$/],
  ["STATUS", /^STATUS$/],
  ["PAYMENT", /^(PAYMENT|MODE OF PAYMENT|PAYMENT TYPE|HMO ?\/ ?CASH)$/],
  ["SCHEDULER", /^(RT SCHEDULER|SCHEDULER|SCHEDULED BY|BOOKED BY)$/],
  ["PERFORMED_BY", /^(PERFORMED BY|DONE BY|RT IN CHARGE|PERFORMER)$/],
  ["REMARKS", /^(REMARKS|REMARK|NOTES|NOTE|COMMENTS)$/],
];

export function headerField(text: string): ImportField | null {
  const n = norm(text);
  if (!n) return null;
  for (const [f, re] of HEADER_SYNONYMS) if (re.test(n)) return f;
  return null;
}

export function cellText(c: RawCell | null | undefined): string {
  if (!c) return "";
  if (c.t === "s") return c.v.trim();
  if (c.t === "n") return String(c.v);
  if (c.t === "b") return c.v ? "TRUE" : "FALSE";
  return c.v;
}

/** Finds the most header-like row among the first rows (1-based row number), or null. */
export function detectHeaderRow(rows: Array<Array<RawCell | null>>, scan = 15): number | null {
  let best: { row: number; score: number } | null = null;
  for (let i = 0; i < Math.min(scan, rows.length); i++) {
    const score = (rows[i] ?? []).filter((c) => c && c.t === "s" && headerField(c.v)).length;
    if (score >= 2 && (!best || score > best.score)) best = { row: i + 1, score };
  }
  return best?.row ?? null;
}

/**
 * Suggests a mapping from header text. A generic header ("Column 1", blank) is suggested as DATE
 * only when most of its values look like dates — and is shown to the reviewer as a suggestion.
 */
export function suggestMapping(headers: string[], body: Array<Array<RawCell | null>>): { mapping: ColumnMapping; inferredFromValues: number[] } {
  const mapping: ColumnMapping = {};
  const inferredFromValues: number[] = [];
  const used = new Set<ImportField>();
  headers.forEach((h, i) => {
    const f = headerField(h);
    if (f && (!used.has(f) || f === "CONTACT")) {
      mapping[i] = f;
      used.add(f);
    }
  });
  if (!used.has("DATE")) {
    headers.forEach((h, i) => {
      if (mapping[i] || used.has("DATE")) return;
      if (h.trim() && !/^COLUMN ?\d+$/i.test(h.trim())) return;
      const vals = body.map((r) => r[i]).filter((c): c is RawCell => !!c && cellText(c) !== "");
      if (vals.length < 3) return;
      const datey = vals.filter(
        (c) => c.t === "d" || /\d{1,4}[/.-]\d{1,2}([/.-]\d{1,5})?|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/i.test(cellText(c)),
      ).length;
      if (datey / vals.length >= 0.6) {
        mapping[i] = "DATE";
        used.add("DATE");
        inferredFromValues.push(i);
      }
    });
  }
  return { mapping, inferredFromValues };
}

// ---------------------------------------------------------------- value parsers

export interface ParsedDate {
  date: string | null; // YYYY-MM-DD
  flags: ImportFlag[];
}

const MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
/** Full name, 3-letter abbreviation, or "SEPT" — nothing looser (a misspelling is malformed, not guessed). */
const monthFromName = (s: string): number | null => {
  const w = s.toUpperCase();
  const i = MONTH_NAMES.findIndex((f) => f === w || f.slice(0, 3) === w || (w === "SEPT" && f === "SEPTEMBER"));
  return i < 0 ? null : i + 1;
};
export const sheetMonth = (sheetName: string): number | null => {
  const m = /^\s*([A-Za-z]{3,9})\b/.exec(sheetName);
  if (!m) return null;
  return monthFromName(m[1]);
};

const pad = (n: number) => String(n).padStart(2, "0");
function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

function finishDate(y: number | null, m: number, d: number, yearDigits: number, opts: ImportOptions, sheetName: string, flags: ImportFlag[]): ParsedDate {
  let year = y;
  if (year === null) {
    if (opts.workbookYear === null) return { date: null, flags: [...flags, "YEAR_MISSING"] };
    year = opts.workbookYear;
    flags.push("YEAR_FROM_WORKBOOK");
  } else if (yearDigits === 2) {
    // Two-digit year: only accepted when it matches the stated workbook year exactly.
    if (opts.workbookYear !== null && opts.workbookYear % 100 === year) year = opts.workbookYear;
    else return { date: null, flags: [...flags, opts.workbookYear === null ? "YEAR_MISSING" : "YEAR_MISMATCH"] };
  } else if (yearDigits !== 4) {
    return { date: null, flags: [...flags, "YEAR_MALFORMED"] };
  }
  if (year < 2000 || year > 2100 || !validYmd(year, m, d)) return { date: null, flags: [...flags, "DATE_IMPOSSIBLE"] };
  if (opts.workbookYear !== null && year !== opts.workbookYear) return { date: null, flags: [...flags, "YEAR_MISMATCH"] };
  const sm = sheetMonth(sheetName);
  if (sm !== null && sm !== m) flags.push("SHEET_MONTH_MISMATCH");
  return { date: `${year}-${pad(m)}-${pad(d)}`, flags };
}

export function parseDateCell(c: RawCell | null | undefined, opts: ImportOptions, sheetName = ""): ParsedDate {
  if (!c || cellText(c) === "") return { date: null, flags: ["DATE_MISSING"] };
  if (c.t === "d") {
    const t = new Date(c.v);
    if (Number.isNaN(t.getTime())) return { date: null, flags: ["DATE_MALFORMED"] };
    return finishDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 4, opts, sheetName, []);
  }
  if (c.t === "n") {
    // Spreadsheet serial day number (1900 date system; serial 60 is the fictitious 1900-02-29).
    if (!Number.isFinite(c.v) || c.v < 61 || c.v > 80_000) return { date: null, flags: ["DATE_MALFORMED"] };
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(c.v) * 86_400_000);
    return finishDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 4, opts, sheetName, []);
  }
  if (c.t !== "s") return { date: null, flags: ["DATE_MALFORMED"] };
  const s = c.v.trim().replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  // ISO 2025-06-03
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return finishDate(Number(m[1]), Number(m[2]), Number(m[3]), 4, opts, sheetName, []);
  // Numeric a/b/y, a-b-y, a.b.y (year optional, any number of digits so typos are caught)
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{1,6}))?$/.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3] === undefined ? null : Number(m[3]);
    const digits = m[3]?.length ?? 0;
    let month: number;
    let day: number;
    if (a > 12 && b <= 12) [day, month] = [a, b];
    else if (b > 12 && a <= 12) [month, day] = [a, b];
    else if (a === b) [month, day] = [a, b];
    else if (opts.dateOrder === "MDY") [month, day] = [a, b];
    else if (opts.dateOrder === "DMY") [day, month] = [a, b];
    else return { date: null, flags: ["DATE_AMBIGUOUS"] };
    // A stated order that contradicts the value (e.g. 25/06 under MDY) is impossible, not swapped.
    if (opts.dateOrder === "MDY" && a > 12) return { date: null, flags: ["DATE_IMPOSSIBLE"] };
    if (opts.dateOrder === "DMY" && b > 12) return { date: null, flags: ["DATE_IMPOSSIBLE"] };
    return finishDate(y, month, day, y === null ? 0 : digits, opts, sheetName, []);
  }
  // "June 3, 2025" / "Jun 3" / "JUNE 3 2025"
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{1,6})?$/.exec(s))) {
    const month = monthFromName(m[1]);
    if (!month) return { date: null, flags: ["DATE_MALFORMED"] };
    const y = m[3] === undefined ? null : Number(m[3]);
    return finishDate(y, month, Number(m[2]), m[3]?.length ?? 0, opts, sheetName, []);
  }
  // "3 June 2025" / "3-Jun-25"
  if ((m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]? ?(\d{1,6})?$/.exec(s))) {
    const month = monthFromName(m[2]);
    if (!month) return { date: null, flags: ["DATE_MALFORMED"] };
    const y = m[3] === undefined ? null : Number(m[3]);
    return finishDate(y, month, Number(m[1]), m[3]?.length ?? 0, opts, sheetName, []);
  }
  return { date: null, flags: ["DATE_MALFORMED"] };
}

export interface ParsedTime {
  time: string | null; // HH:MM 24-hour
  flags: ImportFlag[];
}

export function parseTimeCell(c: RawCell | null | undefined, opts: ImportOptions): ParsedTime {
  if (!c || cellText(c) === "") return { time: null, flags: ["TIME_MISSING"] };
  if (c.t === "d") {
    const t = new Date(c.v);
    if (Number.isNaN(t.getTime())) return { time: null, flags: ["TIME_MALFORMED"] };
    return { time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, flags: [] };
  }
  if (c.t === "n") {
    if (c.v < 0 || c.v >= 1) return { time: null, flags: ["TIME_MALFORMED"] };
    const mins = Math.round(c.v * 1440);
    return { time: `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`, flags: [] };
  }
  if (c.t !== "s") return { time: null, flags: ["TIME_MALFORMED"] };
  const s = c.v.trim().toUpperCase().replace(/\s+/g, " ");
  const m = /^(\d{1,2})(?:[:.](\d{2}))? ?(A\.?M\.?|P\.?M\.?|NN|NOON)?$/.exec(s);
  if (!m) return { time: null, flags: ["TIME_MALFORMED"] };
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const mer = m[3]?.replace(/\./g, "");
  if (min > 59) return { time: null, flags: ["TIME_MALFORMED"] };
  if (mer === "NN" || mer === "NOON") {
    if (h !== 12) return { time: null, flags: ["TIME_MALFORMED"] };
  } else if (mer) {
    if (h < 1 || h > 12) return { time: null, flags: ["TIME_MALFORMED"] };
    if (mer === "AM") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else {
    if (m[2] === undefined) return { time: null, flags: ["TIME_MALFORMED"] }; // bare "8"
    if (h > 23) return { time: null, flags: ["TIME_MALFORMED"] };
    if (h <= 12 && !opts.times24h) return { time: null, flags: ["TIME_NO_MERIDIEM"] };
  }
  return { time: `${pad(h)}:${pad(min)}`, flags: [] };
}

export interface ParsedAgeSex {
  ageYears: number | null;
  sex: "M" | "F" | null;
  raw: string;
  uncertain: boolean;
}

const SEX_RE = /^(M|MALE|F|FEMALE)$/;
const toSex = (s: string): "M" | "F" | null => (SEX_RE.test(s) ? (s.startsWith("M") ? "M" : "F") : null);
function toAge(s: string): number | null {
  const m = /^(\d{1,3})(?: ?(Y|YR|YRS|YEAR|YEARS|YO|Y\/O|Y\.O))?$/.exec(s.replace(/\./g, "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 120 ? n : null;
}

export function parseAgeSex(age: RawCell | null | undefined, sex: RawCell | null | undefined, combined: RawCell | null | undefined): ParsedAgeSex {
  const rawParts = [cellText(combined), cellText(age), cellText(sex)].filter(Boolean);
  const raw = rawParts.join(" | ");
  if (!raw) return { ageYears: null, sex: null, raw: "", uncertain: false };
  let ageYears: number | null = null;
  let sx: "M" | "F" | null = null;
  let uncertain = false;
  if (cellText(combined)) {
    const t = cellText(combined).toUpperCase().replace(/\s+/g, " ").trim();
    const m = /^(\d{1,3}) ?(?:Y|YR|YRS|YO|Y\/O|YEARS?)?\.? ?[/,-]? ?(M|F|MALE|FEMALE)$/.exec(t) ?? null;
    const r = /^(M|F|MALE|FEMALE) ?[/,-]? ?(\d{1,3}) ?(?:Y|YR|YRS|YO|Y\/O|YEARS?)?$/.exec(t) ?? null;
    if (m) {
      ageYears = toAge(m[1]);
      sx = toSex(m[2]);
    } else if (r) {
      ageYears = toAge(r[2]);
      sx = toSex(r[1]);
    }
    if (ageYears === null || sx === null) uncertain = true;
  }
  if (cellText(age)) {
    const a = age!.t === "n" && Number.isInteger(age!.v) ? (age!.v <= 120 && age!.v >= 0 ? age!.v : null) : toAge(cellText(age).toUpperCase());
    if (a === null) uncertain = true;
    else if (ageYears !== null && ageYears !== a) uncertain = true;
    else ageYears = a;
  }
  if (cellText(sex)) {
    const s = toSex(cellText(sex).toUpperCase());
    if (s === null) uncertain = true;
    else if (sx !== null && sx !== s) uncertain = true;
    else sx = s;
  }
  if (uncertain) return { ageYears: null, sex: null, raw, uncertain: true };
  return { ageYears, sex: sx, raw, uncertain: false };
}

const STATUS_MAP: Array<[RegExp, DiagnosticStatus]> = [
  [/^(DONE|COMPLETED?|PERFORMED|FINISHED|OK DONE)$/, "COMPLETED"],
  [/^(NO ?SHOW|NOSHOW|DID NOT COME|DNC|NOT CAME|NO APPEARANCE)$/, "NO_SHOW"],
  [/^(CANCEL+ED|CANCEL|CANCELED BY PATIENT|CXL)$/, "CANCELLED"],
  [/^(PENDING|ON HOLD|HOLD)$/, "PENDING"],
  [/^(FOR RE ?SCHED(ULE|ULING)?|FOR RESCHED|TO BE RESCHEDULED|RESCHED|RE ?SCHED)$/, "FOR_RESCHEDULE"],
  [/^(RE ?SCHEDULED|MOVED)$/, "RESCHEDULED"],
  [/^(SCHEDULED|BOOKED|CONFIRMED|FOR PFT|FOR TEST)$/, "SCHEDULED"],
];

export function parseStatus(c: RawCell | null | undefined): { status: DiagnosticStatus | null; flags: ImportFlag[] } {
  if (!cellText(c)) return { status: null, flags: ["STATUS_MISSING"] };
  const t = norm(cellText(c)).replace(/\//g, " ").trim();
  for (const [re, st] of STATUS_MAP) if (re.test(t)) return { status: st, flags: [] };
  return { status: null, flags: ["STATUS_UNKNOWN"] };
}

export function parseCategory(c: RawCell | null | undefined, opts: ImportOptions): { category: PatientCategory | null; flags: ImportFlag[] } {
  const t = norm(cellText(c));
  if (!cellText(c))
    return opts.categoryWhenMissing
      ? { category: opts.categoryWhenMissing, flags: ["CATEGORY_FROM_DECLARATION"] }
      : { category: "OTHER", flags: ["CATEGORY_MISSING"] };
  if (/^(OPD|OUT ?PATIENT|OUT|OP)$/.test(t)) return { category: "OPD", flags: [] };
  if (/^(INP|IN ?PATIENT|IN|IP|ADMITTED|WARD)$/.test(t)) return { category: "INP", flags: [] };
  return { category: null, flags: ["CATEGORY_UNKNOWN"] };
}

// ---------------------------------------------------------------- row parsing

export interface ParsedRow {
  date: string | null;
  time: string | null;
  name: string | null;
  ageYears: number | null;
  sex: "M" | "F" | null;
  rawAgeSex: string;
  category: PatientCategory | null;
  physician: string | null;
  procedure: string | null;
  status: DiagnosticStatus | null;
  rawStatus: string | null;
  payment: string | null;
  /** Contact info exactly as written (U-08 approved 2026-11-23); never parsed or validated as a phone number. */
  contactNote: string | null;
  schedulerLabel: string | null;
  performerLabel: string | null;
  remarks: string | null;
}

const LIMITS: Partial<Record<keyof ParsedRow, number>> = {
  name: 160,
  physician: 120,
  procedure: 160,
  payment: 60,
  contactNote: 300,
  remarks: 1000,
  rawStatus: 80,
  rawAgeSex: 40,
  schedulerLabel: 120,
  performerLabel: 120,
};

/** Text exactly as written in the workbook (product owner rule: nothing in the Excel file is changed — not even spacing). */
const txt = (c: RawCell | null | undefined) => {
  if (!c || cellText(c) === "") return null;
  return c.t === "s" ? c.v : cellText(c);
};

/** Row cells keyed by column index. */
export type RawRow = Record<number, RawCell | null>;

export function isBlankRow(row: RawRow): boolean {
  return Object.values(row).every((c) => cellText(c) === "");
}

/** Keeps the non-empty source cells. (Until 2026-11-23 contact/payment columns were dropped here; U-08/U-09 now approved.) */
export function scrubRaw(row: RawRow, _mapping: ColumnMapping): RawRow {
  void _mapping;
  const out: RawRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && cellText(v) !== "") out[Number(k)] = v;
  }
  return out;
}

export function parseRow(row: RawRow, mapping: ColumnMapping, opts: ImportOptions, sheetName: string): { parsed: ParsedRow; flags: ImportFlag[] } {
  const col = (f: ImportField): RawCell | null => {
    for (const [k, v] of Object.entries(mapping)) if (v === f) return row[Number(k)] ?? null;
    return null;
  };
  const flags: ImportFlag[] = [];
  const d = parseDateCell(col("DATE"), opts, sheetName);
  flags.push(...d.flags);
  const t = parseTimeCell(col("TIME"), opts);
  flags.push(...t.flags);
  const name = txt(col("PATIENT_NAME"));
  if (!name) flags.push("NAME_MISSING");
  else if (/[0-9@#$%^*_=+<>{}[\]|\\~]/.test(name)) flags.push("NAME_SUSPECT");
  const as = parseAgeSex(col("AGE"), col("SEX"), col("AGE_SEX"));
  if (as.uncertain) flags.push("AGE_SEX_UNCERTAIN");
  const st = parseStatus(col("STATUS"));
  flags.push(...st.flags);
  const cat = parseCategory(col("CATEGORY"), opts);
  flags.push(...cat.flags);
  const procedure = txt(col("PROCEDURE"));
  if (!procedure) flags.push("PROCEDURE_MISSING");
  const contacts = Object.entries(mapping)
    .filter(([, f]) => f === "CONTACT")
    .map(([k]) => txt(row[Number(k)]))
    .filter((x): x is string => !!x);
  if (contacts.length) flags.push("CONTACT_AS_NOTE");
  const parsed: ParsedRow = {
    date: d.date,
    time: t.time,
    name,
    ageYears: as.ageYears,
    sex: as.sex,
    rawAgeSex: as.raw,
    category: cat.category,
    physician: txt(col("PHYSICIAN")),
    procedure,
    status: st.status,
    rawStatus: txt(col("STATUS")),
    payment: txt(col("PAYMENT")),
    contactNote: contacts.length ? contacts.join(" / ") : null,
    schedulerLabel: txt(col("SCHEDULER")),
    performerLabel: txt(col("PERFORMED_BY")),
    remarks: txt(col("REMARKS")),
  };
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = parsed[k as keyof ParsedRow];
    if (typeof v === "string" && v.length > max!) {
      flags.push("VALUE_TOO_LONG");
      break;
    }
  }
  return { parsed, flags: [...new Set(flags)] };
}

// ---------------------------------------------------------------- reviewer resolution

export type Resolution = Partial<Record<ResolvableField, string>>;

export interface EffectiveRow extends ParsedRow {
  blocking: ImportFlag[];
}

/** Applies the reviewer's overrides and reports which blocking flags remain. */
export function effectiveRow(parsed: ParsedRow, flags: ImportFlag[], resolved: Resolution): EffectiveRow {
  const e: EffectiveRow = { ...parsed, blocking: [] };
  if (resolved.date) e.date = resolved.date;
  if (resolved.time) e.time = resolved.time;
  if (resolved.name) e.name = resolved.name;
  if (resolved.status) e.status = resolved.status as DiagnosticStatus;
  if (resolved.category) e.category = resolved.category as PatientCategory;
  if (resolved.procedure) e.procedure = resolved.procedure;
  for (const f of flags) {
    const info = FLAG_INFO[f];
    if (!info.blocking) continue;
    if (info.field && resolved[info.field as ResolvableField]) continue;
    if (f === "VALUE_TOO_LONG") {
      const still = Object.entries(LIMITS).some(([k, max]) => {
        const v = e[k as keyof ParsedRow];
        return typeof v === "string" && v.length > max!;
      });
      if (!still) continue;
    }
    e.blocking.push(f);
  }
  return e;
}

/** Validates a reviewer override value; returns an error message or null. */
export function validateResolution(field: ResolvableField, value: string): string | null {
  const v = value.trim();
  switch (field) {
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m || !validYmd(Number(m[1]), Number(m[2]), Number(m[3])) || Number(m[1]) < 2000 || Number(m[1]) > 2100) return "Enter a real date (YYYY-MM-DD).";
      return null;
    }
    case "time":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : "Enter a 24-hour time (HH:MM).";
    case "status":
      return ["SCHEDULED", "PENDING", "COMPLETED", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE", "RESCHEDULED"].includes(v) ? null : "Choose a status.";
    case "category":
      return ["OPD", "INP", "OTHER"].includes(v) ? null : "Choose OPD, INP or Other.";
    case "name":
      return v.length >= 2 && v.length <= 160 ? null : "Name: 2–160 characters.";
    case "procedure":
      return v.length >= 2 && v.length <= 160 ? null : "Procedure: 2–160 characters.";
  }
}

// ---------------------------------------------------------------- CSV (exception report, exports)

/** RFC 4180 field with spreadsheet formula-injection neutralized (OWASP CSV injection). */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (vals: unknown[]) => vals.map(csvField).join(",") + "\r\n";

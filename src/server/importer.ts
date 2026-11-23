import "server-only";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import {
  cellText,
  csvLine,
  detectHeaderRow,
  effectiveRow,
  FLAG_INFO,
  IMPORT_FIELDS,
  isBlankRow,
  parseRow,
  scrubRaw,
  suggestMapping,
  validateResolution,
  type ColumnMapping,
  type ImportFlag,
  type ImportOptions,
  type ParsedRow,
  type RawCell,
  type RawRow,
  type Resolution,
  type ResolvableField,
} from "@/lib/import/parse";
import type { DiagnosticService } from "@/lib/clinical/vocabulary";
import { HOSPITAL_TZ, parseIsoDate, zonedWallTimeToUtc } from "@/lib/time/zoned";
import { encryptBytes, decryptBytes } from "@/lib/auth/tokens";
import { hasRecentReauth } from "./auth/service";
import { ClinicalError } from "./clinical";
import { audit, tx, type Tx } from "./db";
import type { Session } from "./session";

/**
 * Milestone 5 — legacy workbook import (DATA_IMPORT_AND_PFT_SPEC.md §4–5).
 *
 * The workbook is parsed in memory on the server (never written to disk, never sent anywhere),
 * staged row-by-row with sheet/row provenance, and nothing reaches the clinical tables until the
 * Chief RT has decided EVERY row and confirms the commit with a fresh password check.
 * Committed batches can be reversed (voided) as a unit. Discarding a staged batch erases its raw values
 * and its retained original. The original workbook is kept encrypted (privacy officer approval, 2026-11-23).
 */

/** Upload limit (MB). Hosted serverless platforms cap request bodies (Vercel: 4.5 MB), so it is configurable. */
export const MAX_UPLOAD_MB = Math.max(1, Math.min(10, Number(process.env.PUIMS_MAX_UPLOAD_MB ?? 10) || 10));
export const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_SHEETS = 24;
export const MAX_ROWS_PER_SHEET = 3000;
export const MAX_COLS = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SheetMeta {
  name: string;
  headerRow: number | null;
  headers: string[];
  mapping: ColumnMapping;
  inferredFromValues: number[];
  rows: number;
  blankRowsSkipped: number;
  truncated: boolean;
}

function asChief<T>(s: Session, fn: (c: Tx) => Promise<T>): Promise<T> {
  if (s.role !== "CHIEF_RT_ADMIN") throw new ClinicalError("FORBIDDEN", "Only the Chief RT can import records.");
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}
function requireReauth(s: Session) {
  if (!hasRecentReauth(s)) throw new ClinicalError("REAUTH_REQUIRED", "Confirm your password to continue.");
}

// ---------------------------------------------------------------- workbook → cells

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toRawCell(v: any): RawCell | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { t: "s", v: "#INVALID DATE" } : { t: "d", v: v.toISOString() };
  if (typeof v === "number") return Number.isFinite(v) ? { t: "n", v } : null;
  if (typeof v === "boolean") return { t: "b", v };
  if (typeof v === "string") return v.trim() === "" ? null : { t: "s", v: v.slice(0, 2000) };
  if (typeof v === "object") {
    if ("result" in v) return toRawCell(v.result); // formula → cached result only (formulas are never evaluated)
    if ("richText" in v && Array.isArray(v.richText)) return toRawCell(v.richText.map((r: { text?: string }) => r.text ?? "").join(""));
    if ("text" in v) return toRawCell(String(v.text));
    if ("error" in v) return { t: "s", v: String(v.error) };
  }
  return toRawCell(String(v));
}

interface StagedSheet {
  meta: SheetMeta;
  rows: Array<{ rowNumber: number; raw: RawRow }>;
}

export async function readWorkbook(bytes: Buffer): Promise<StagedSheet[]> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs typing expects its own Buffer type
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new ClinicalError("INVALID", "The file could not be read as an Excel workbook (.xlsx).");
  }
  if (wb.worksheets.length > MAX_SHEETS) throw new ClinicalError("INVALID", `The workbook has more than ${MAX_SHEETS} worksheets.`);
  const out: StagedSheet[] = [];
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== "visible") continue; // hidden sheets are listed in the summary only
    const grid: Array<Array<RawCell | null>> = [];
    const last = Math.min(ws.rowCount, MAX_ROWS_PER_SHEET + 20);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: Array<RawCell | null> = [];
      for (let col = 1; col <= Math.min(Math.max(ws.columnCount, 1), MAX_COLS); col++) cells.push(toRawCell(row.getCell(col).value));
      grid.push(cells);
    }
    const headerRow = detectHeaderRow(grid);
    const firstNonBlank = grid.findIndex((r) => r.some((c) => c && cellText(c) !== ""));
    const hIdx = headerRow ? headerRow - 1 : firstNonBlank;
    if (hIdx < 0) {
      out.push({
        meta: { name: ws.name, headerRow: null, headers: [], mapping: {}, inferredFromValues: [], rows: 0, blankRowsSkipped: 0, truncated: false },
        rows: [],
      });
      continue;
    }
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    const headers = Array.from({ length: width }, (_, i) => cellText(grid[hIdx]?.[i]) || `Column ${i + 1}`);
    const body = grid.slice(hIdx + 1);
    const { mapping, inferredFromValues } = suggestMapping(headers, body);
    const rows: StagedSheet["rows"] = [];
    let blank = 0;
    body.forEach((cells, i) => {
      const raw: RawRow = {};
      cells.forEach((c, k) => {
        if (c) raw[k] = c;
      });
      if (isBlankRow(raw)) blank++;
      else rows.push({ rowNumber: hIdx + 2 + i, raw });
    });
    out.push({
      meta: {
        name: ws.name.slice(0, 100),
        headerRow: hIdx + 1,
        headers,
        mapping,
        inferredFromValues,
        rows: Math.min(rows.length, MAX_ROWS_PER_SHEET),
        blankRowsSkipped: blank,
        truncated: rows.length > MAX_ROWS_PER_SHEET || ws.rowCount > last,
      },
      rows: rows.slice(0, MAX_ROWS_PER_SHEET),
    });
  }
  return out;
}

/** Reviewer-facing rendering of a source cell: spreadsheet date cells are labelled as such. */
function displayCell(c: RawCell | null): string {
  if (c?.t !== "d") return cellText(c);
  const [d, t] = c.v.split("T");
  const time = t?.slice(0, 5);
  if (d === "1899-12-30") return `${time} (time cell)`;
  return `${d}${time && time !== "00:00" ? ` ${time}` : ""} (date cell)`;
}

// ---------------------------------------------------------------- staging

export async function stageWorkbook(s: Session, input: { fileName: string; bytes: Buffer; service?: DiagnosticService }): Promise<{ batchId: string }> {
  if (s.role !== "CHIEF_RT_ADMIN") throw new ClinicalError("FORBIDDEN", "Only the Chief RT can import records.");
  if (!input.bytes.length) throw new ClinicalError("INVALID", "The file is empty.");
  if (input.bytes.length > MAX_FILE_BYTES) throw new ClinicalError("INVALID", `The file is larger than ${MAX_UPLOAD_MB} MB.`);
  if (input.bytes[0] !== 0x50 || input.bytes[1] !== 0x4b) throw new ClinicalError("INVALID", "Only .xlsx workbooks are accepted.");
  const fileName = input.fileName.replace(/[\\/]/g, "_").slice(0, 200) || "workbook.xlsx";
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const sheets = await readWorkbook(input.bytes);
  if (!sheets.some((x) => x.rows.length)) throw new ClinicalError("INVALID", "No data rows were found in the workbook.");
  return asChief(s, async (c) => {
    const dup = await c.query<{ id: string; status: string }>(
      "SELECT id, status FROM import_batch WHERE file_sha256 = $1 AND status IN ('STAGED', 'COMMITTED')",
      [sha],
    );
    if (dup.rows[0])
      throw new ClinicalError("CONFLICT", dup.rows[0].status === "COMMITTED" ? "This exact file was already imported." : "This exact file is already staged.", {
        id: dup.rows[0].id,
      });
    const options = await initialOptions(c, sheets);
    const b = await c.query<{ id: string }>(
      "INSERT INTO import_batch (file_name, file_sha256, file_bytes, service, sheets, options, created_by, original_enc, original_mime, workbook_year) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
      [
        fileName,
        sha,
        input.bytes.length,
        input.service ?? "PFT",
        JSON.stringify(sheets.map((x) => x.meta)),
        JSON.stringify(options),
        s.staffId,
        // Original workbook retained encrypted (approved by the privacy officer, 2026-11-23).
        encryptBytes(input.bytes),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        options.workbookYear,
      ],
    );
    const batchId = b.rows[0].id;
    for (const sh of sheets) {
      const recs = sh.rows.map((r) => {
        const raw = scrubRaw(r.raw, sh.meta.mapping);
        const p = parseRow(raw, sh.meta.mapping, options, sh.meta.name);
        return { batch_id: batchId, sheet_name: sh.meta.name, row_number: r.rowNumber, raw, parsed: p.parsed, flags: p.flags };
      });
      for (let i = 0; i < recs.length; i += 500) {
        await c.query(
          `INSERT INTO import_row (batch_id, sheet_name, row_number, raw, parsed, flags)
           SELECT batch_id, sheet_name, row_number, raw, parsed, flags FROM json_populate_recordset(NULL::import_row, $1)`,
          [JSON.stringify(recs.slice(i, i + 500))],
        );
      }
    }
    await refreshCrossFlags(c, batchId);
    await audit(
      c,
      "import.staged",
      { sheets: sheets.length, rows: sheets.reduce((n, x) => n + x.rows.length, 0), sha256: sha, auto_settings: options.auto ?? [] },
      { table: "import_batch", id: batchId },
    );
    return { batchId };
  });
}

/**
 * Settings for a new batch, so the reviewer does not have to declare them every time:
 *  - date order, 24-hour times and the empty-OPD/INP default are remembered from the last
 *    committed import (the same workbook layout is uploaded every month);
 *  - the workbook year is the year shared by at least 80 % of the real date cells;
 *  - an undeclared date order is chosen only when one order gives clearly fewer problems.
 * Nothing is ever corrected: a typo year still raises YEAR_MISMATCH and must be resolved.
 */
async function initialOptions(c: Tx, sheets: StagedSheet[]): Promise<ImportOptions> {
  const last = await c.query<{ options: ImportOptions }>("SELECT options FROM import_batch WHERE committed_at IS NOT NULL ORDER BY committed_at DESC LIMIT 1");
  const prev = last.rows[0]?.options;
  const o: ImportOptions = {
    dateOrder: prev?.dateOrder ?? null,
    workbookYear: null,
    times24h: !!prev?.times24h,
    categoryWhenMissing: prev?.categoryWhenMissing ?? null,
  };
  const auto: string[] = [];
  if (prev && (prev.dateOrder || prev.times24h || prev.categoryWhenMissing)) auto.push("settings remembered from your last import");

  const parseAll = (opts: ImportOptions) =>
    sheets.flatMap((sh) => sh.rows.map((r) => parseRow(scrubRaw(r.raw, sh.meta.mapping), sh.meta.mapping, opts, sh.meta.name)));
  const count = (rows: ReturnType<typeof parseAll>, flags: ImportFlag[]) => rows.filter((r) => r.flags.some((f) => flags.includes(f))).length;

  const base = parseAll(o);
  const years = new Map<number, number>();
  for (const r of base) {
    const y = r.parsed.date ? Number(r.parsed.date.slice(0, 4)) : NaN;
    if (Number.isInteger(y)) years.set(y, (years.get(y) ?? 0) + 1);
  }
  const total = [...years.values()].reduce((a, b) => a + b, 0);
  const top = [...years].sort((a, b) => b[1] - a[1])[0];
  if (top && total >= 5 && top[1] / total >= 0.8 && top[0] >= 2000 && top[0] <= 2100) {
    o.workbookYear = top[0];
    auto.push(`workbook year ${top[0]} (${top[1]} of ${total} dates)`);
  }

  if (!o.dateOrder && count(base, ["DATE_AMBIGUOUS"]) > 0) {
    const bad: ImportFlag[] = ["DATE_AMBIGUOUS", "DATE_IMPOSSIBLE", "DATE_MALFORMED", "SHEET_MONTH_MISMATCH"];
    const mdy = count(parseAll({ ...o, dateOrder: "MDY" }), bad);
    const dmy = count(parseAll({ ...o, dateOrder: "DMY" }), bad);
    if (mdy !== dmy && Math.min(mdy, dmy) * 2 < Math.max(mdy, dmy)) {
      o.dateOrder = mdy < dmy ? "MDY" : "DMY";
      auto.push(`dates read as ${o.dateOrder === "MDY" ? "month/day" : "day/month"} (fits the sheet months)`);
    }
  }
  return auto.length ? { ...o, auto } : o;
}

const CROSS: ImportFlag[] = ["NAME_MATCHES_EXISTING", "NAME_REPEATS_IN_BATCH", "DUPLICATE_CANDIDATE"];

/** Recomputes the flags that depend on the database and on other rows. Never changes decisions to ACCEPT. */
async function refreshCrossFlags(c: Tx, batchId: string) {
  await c.query(
    `WITH e AS (
       SELECT r.id, name_key(coalesce(r.resolved ->> 'name', r.parsed ->> 'name')) AS nk,
              coalesce(r.resolved ->> 'date', r.parsed ->> 'date') AS d, coalesce(r.resolved ->> 'time', r.parsed ->> 'time') AS t,
              lower(coalesce(r.resolved ->> 'procedure', r.parsed ->> 'procedure', '')) AS pr
         FROM import_row r WHERE r.batch_id = $1),
     f AS (
       SELECT e.id,
              (e.nk <> '' AND EXISTS (SELECT 1 FROM patient p WHERE p.voided_at IS NULL AND name_key(p.full_name) = e.nk)) AS matches,
              (e.nk <> '' AND EXISTS (SELECT 1 FROM e e2 WHERE e2.id <> e.id AND e2.nk = e.nk)) AS repeats,
              (e.nk <> '' AND e.d IS NOT NULL AND (
                 EXISTS (SELECT 1 FROM e e2 WHERE e2.id <> e.id AND e2.nk = e.nk AND e2.d = e.d AND e2.t IS NOT DISTINCT FROM e.t AND e2.pr = e.pr)
                 OR EXISTS (SELECT 1 FROM diagnostic_appointment a JOIN patient p ON p.id = a.patient_id
                             WHERE a.voided_at IS NULL AND name_key(p.full_name) = e.nk
                               AND (a.scheduled_at AT TIME ZONE '${HOSPITAL_TZ}')::date = e.d::date))) AS dup
         FROM e)
     UPDATE import_row r SET flags = ARRAY(
         SELECT x FROM unnest(r.flags) x WHERE x <> ALL ($2::text[])
         UNION ALL SELECT 'NAME_MATCHES_EXISTING' WHERE f.matches
         UNION ALL SELECT 'NAME_REPEATS_IN_BATCH' WHERE f.repeats
         UNION ALL SELECT 'DUPLICATE_CANDIDATE' WHERE f.dup)
       FROM f WHERE f.id = r.id`,
    [batchId, CROSS],
  );
}

// Never pull the (encrypted, up to 10 MB) original into ordinary page loads.
const BATCH_COLS =
  "id, file_name, file_sha256, file_bytes, service, workbook_year, sheets, options, status, created_at, created_by, committed_at, committed_by, closed_at, closed_by, close_reason, summary, (original_enc IS NOT NULL) AS has_original";

async function loadBatch(c: Tx, batchId: string, lock = false) {
  if (!UUID_RE.test(batchId)) throw new ClinicalError("NOT_FOUND", "Import batch not found.");
  const r = await c.query<{
    id: string;
    file_name: string;
    file_sha256: string;
    file_bytes: number;
    service: DiagnosticService;
    sheets: SheetMeta[];
    options: ImportOptions;
    status: "STAGED" | "COMMITTED" | "VOIDED" | "DISCARDED";
    created_at: Date;
    created_by: string;
    committed_at: Date | null;
    closed_at: Date | null;
    close_reason: string | null;
    summary: unknown;
    has_original: boolean;
  }>(`SELECT ${BATCH_COLS} FROM import_batch WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [batchId]);
  if (!r.rows[0]) throw new ClinicalError("NOT_FOUND", "Import batch not found.");
  return r.rows[0];
}
function requireStaged(b: { status: string }) {
  if (b.status !== "STAGED") throw new ClinicalError("CONFLICT", "This import batch is closed.");
}

/** Re-parses rows from their stored raw values (after a mapping or option change). Decisions go back to PENDING. */
async function reparse(c: Tx, batchId: string, sheets: SheetMeta[], options: ImportOptions, onlySheet?: string) {
  for (const sh of sheets) {
    if (onlySheet && sh.name !== onlySheet) continue;
    const rows = await c.query<{ id: string; raw: RawRow }>("SELECT id, raw FROM import_row WHERE batch_id = $1 AND sheet_name = $2", [batchId, sh.name]);
    const recs = rows.rows.map((r) => {
      const raw = scrubRaw(r.raw, sh.mapping);
      const p = parseRow(raw, sh.mapping, options, sh.name);
      return { id: r.id, raw, parsed: p.parsed, flags: p.flags };
    });
    for (let i = 0; i < recs.length; i += 500) {
      await c.query(
        `UPDATE import_row r SET raw = x.raw, parsed = x.parsed, flags = x.flags, decision = 'PENDING', decision_reason = NULL, decided_at = NULL, decided_by = NULL
           FROM json_populate_recordset(NULL::import_row, $1) x WHERE r.id = x.id`,
        [JSON.stringify(recs.slice(i, i + 500))],
      );
    }
  }
  await refreshCrossFlags(c, batchId);
}

export async function updateMapping(s: Session, batchId: string, sheetName: string, mapping: Record<string, string>): Promise<void> {
  const clean: ColumnMapping = {};
  for (const [k, v] of Object.entries(mapping)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= MAX_COLS) throw new ClinicalError("INVALID", "Invalid column.");
    if (!(IMPORT_FIELDS as readonly string[]).includes(v)) throw new ClinicalError("INVALID", "Invalid field.");
    if (v !== "IGNORE") clean[i] = v as ColumnMapping[number];
  }
  const counts = new Map<string, number>();
  for (const v of Object.values(clean)) if (v !== "CONTACT") counts.set(v, (counts.get(v) ?? 0) + 1);
  const twice = [...counts].find(([, n]) => n > 1);
  if (twice) throw new ClinicalError("INVALID", `Each field can be mapped to one column only (${twice[0]}).`);
  await asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    const sheets = b.sheets.map((x) => (x.name === sheetName ? { ...x, mapping: clean, inferredFromValues: [] } : x));
    if (!b.sheets.some((x) => x.name === sheetName)) throw new ClinicalError("NOT_FOUND", "Worksheet not found.");
    await c.query("UPDATE import_batch SET sheets = $2 WHERE id = $1", [batchId, JSON.stringify(sheets)]);
    await reparse(c, batchId, sheets, b.options, sheetName);
    await audit(c, "import.mapping_changed", { sheet: sheetName, mapping: clean }, { table: "import_batch", id: batchId });
  });
}

export async function updateOptions(
  s: Session,
  batchId: string,
  o: { dateOrder: string; workbookYear: string; times24h: boolean; categoryWhenMissing: string },
): Promise<void> {
  const year = o.workbookYear.trim() ? Number(o.workbookYear) : null;
  if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)) throw new ClinicalError("INVALID", "Workbook year: 2000–2100, or leave blank.");
  const options: ImportOptions = {
    dateOrder: o.dateOrder === "MDY" || o.dateOrder === "DMY" ? o.dateOrder : null,
    workbookYear: year,
    times24h: !!o.times24h,
    categoryWhenMissing: o.categoryWhenMissing === "OPD" || o.categoryWhenMissing === "INP" || o.categoryWhenMissing === "OTHER" ? o.categoryWhenMissing : null,
  };
  await asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    await c.query("UPDATE import_batch SET options = $2, workbook_year = $3 WHERE id = $1", [batchId, JSON.stringify(options), options.workbookYear]);
    await reparse(c, batchId, b.sheets, options);
    await audit(c, "import.options_changed", { ...options }, { table: "import_batch", id: batchId });
  });
}

// ---------------------------------------------------------------- reviewing

export interface ImportRowView {
  id: string;
  sheet: string;
  rowNumber: number;
  raw: Array<{ header: string; value: string }>;
  effective: ParsedRow;
  flags: ImportFlag[];
  blocking: ImportFlag[];
  resolved: Resolution;
  decision: "PENDING" | "ACCEPT" | "REJECT";
  decisionReason: string | null;
  patientLink: "NEW" | "EXISTING" | "SAME_AS_ROW" | null;
  patientId: string | null;
  sameAsRowId: string | null;
  appointmentId: string | null;
}

export type RowFilter = "all" | "blocking" | "review" | "pending" | "accepted" | "rejected";

export async function getBatch(s: Session, batchId: string, opts: { sheet?: string; filter?: RowFilter; page?: number } = {}) {
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId);
    const counts = await c.query<{ sheet_name: string; decision: string; n: number }>(
      "SELECT sheet_name, decision, count(*)::int AS n FROM import_row WHERE batch_id = $1 GROUP BY 1, 2",
      [batchId],
    );
    const all = await c.query<{
      id: string;
      sheet_name: string;
      row_number: number;
      raw: RawRow;
      parsed: ParsedRow;
      flags: ImportFlag[];
      resolved: Resolution;
      decision: ImportRowView["decision"];
      decision_reason: string | null;
      patient_link: ImportRowView["patientLink"];
      patient_id: string | null;
      same_as_row_id: string | null;
      appointment_id: string | null;
    }>("SELECT * FROM import_row WHERE batch_id = $1 ORDER BY sheet_name, row_number", [batchId]);
    const headersOf = new Map(b.sheets.map((x) => [x.name, x.headers]));
    const views: ImportRowView[] = all.rows.map((r) => {
      const e = effectiveRow(r.parsed, r.flags, r.resolved);
      const { blocking, ...effective } = e;
      const hs = headersOf.get(r.sheet_name) ?? [];
      return {
        id: r.id,
        sheet: r.sheet_name,
        rowNumber: r.row_number,
        raw: Object.entries(r.raw).map(([k, v]) => ({ header: hs[Number(k)] ?? `Column ${Number(k) + 1}`, value: displayCell(v) })),
        effective,
        flags: r.flags,
        blocking,
        resolved: r.resolved,
        decision: r.decision,
        decisionReason: r.decision_reason,
        patientLink: r.patient_link,
        patientId: r.patient_id,
        sameAsRowId: r.same_as_row_id,
        appointmentId: r.appointment_id,
      };
    });
    const needsReview = (v: ImportRowView) => v.blocking.length > 0 || v.flags.some((f) => CROSS.includes(f));
    const totals = {
      rows: views.length,
      pending: views.filter((v) => v.decision === "PENDING").length,
      accepted: views.filter((v) => v.decision === "ACCEPT").length,
      rejected: views.filter((v) => v.decision === "REJECT").length,
      blocking: views.filter((v) => v.blocking.length && v.decision !== "REJECT").length,
      review: views.filter(needsReview).length,
      clean: views.filter((v) => !needsReview(v)).length,
    };
    const filter = opts.filter ?? "all";
    const pool = views.filter(
      (v) =>
        (!opts.sheet || v.sheet === opts.sheet) &&
        (filter === "all" ||
          (filter === "blocking" && v.blocking.length > 0 && v.decision !== "REJECT") ||
          (filter === "review" && needsReview(v)) ||
          (filter === "pending" && v.decision === "PENDING") ||
          (filter === "accepted" && v.decision === "ACCEPT") ||
          (filter === "rejected" && v.decision === "REJECT")),
    );
    const pageSize = 50;
    const page = Math.max(0, Math.min(opts.page ?? 0, Math.floor(Math.max(pool.length - 1, 0) / pageSize)));
    await audit(c, "import.batch_viewed", { sheet: opts.sheet ?? null, filter, page }, { table: "import_batch", id: batchId });
    return {
      batch: {
        id: b.id,
        fileName: b.file_name,
        sha256: b.file_sha256,
        bytes: b.file_bytes,
        service: b.service,
        status: b.status,
        sheets: b.sheets,
        options: b.options,
        createdIso: new Date(b.created_at).toISOString(),
        committedIso: b.committed_at ? new Date(b.committed_at).toISOString() : null,
        closedIso: b.closed_at ? new Date(b.closed_at).toISOString() : null,
        closeReason: b.close_reason,
        summary: b.summary as DryRun | null,
        hasOriginal: b.has_original,
      },
      sheetCounts: counts.rows,
      totals,
      rows: pool.slice(page * pageSize, page * pageSize + pageSize),
      page,
      pages: Math.max(1, Math.ceil(pool.length / pageSize)),
      filtered: pool.length,
    };
  });
}

/** Existing patients and other batch rows with the same name key (for the explicit patient-link choice). */
export async function rowCandidates(s: Session, rowId: string) {
  return asChief(s, async (c) => {
    const r = await c.query<{ batch_id: string; nk: string }>(
      "SELECT batch_id, name_key(coalesce(resolved ->> 'name', parsed ->> 'name')) AS nk FROM import_row WHERE id = $1",
      [rowId],
    );
    if (!r.rows[0]) throw new ClinicalError("NOT_FOUND", "Row not found.");
    const { batch_id, nk } = r.rows[0];
    if (!nk) return { patients: [], rows: [] };
    const p = await c.query<{
      id: string;
      full_name: string;
      hospital_patient_id: string | null;
      date_of_birth: string | null;
      sex: string | null;
      category: string;
    }>(
      "SELECT id, full_name, hospital_patient_id, date_of_birth, sex, category FROM patient WHERE voided_at IS NULL AND name_key(full_name) = $1 ORDER BY full_name LIMIT 20",
      [nk],
    );
    const o = await c.query<{ id: string; sheet_name: string; row_number: number; date: string | null; decision: string; patient_link: string | null }>(
      `SELECT id, sheet_name, row_number, coalesce(resolved ->> 'date', parsed ->> 'date') AS date, decision, patient_link FROM import_row
        WHERE batch_id = $1 AND id <> $2 AND name_key(coalesce(resolved ->> 'name', parsed ->> 'name')) = $3 ORDER BY sheet_name, row_number LIMIT 50`,
      [batch_id, rowId, nk],
    );
    return {
      patients: p.rows.map((x) => ({ id: x.id, name: x.full_name, hospitalId: x.hospital_patient_id, dob: x.date_of_birth, sex: x.sex, category: x.category })),
      rows: o.rows.map((x) => ({ id: x.id, sheet: x.sheet_name, rowNumber: x.row_number, date: x.date, decision: x.decision, patientLink: x.patient_link })),
    };
  });
}

export interface RowDecision {
  resolved: Resolution;
  decision: "ACCEPT" | "REJECT" | "PENDING";
  reason: string;
  patientLink: "NEW" | "EXISTING" | "SAME_AS_ROW" | null;
  patientId: string | null;
  sameAsRowId: string | null;
}

export async function decideRow(s: Session, rowId: string, d: RowDecision): Promise<void> {
  const resolved: Resolution = {};
  for (const [k, v] of Object.entries(d.resolved ?? {})) {
    if (!v || !v.trim()) continue;
    if (!["date", "time", "name", "status", "category", "procedure"].includes(k)) throw new ClinicalError("INVALID", "Unknown field.");
    const err = validateResolution(k as ResolvableField, v);
    if (err) throw new ClinicalError("INVALID", err);
    resolved[k as ResolvableField] = v.trim().replace(/\s+/g, " ");
  }
  const reason = d.reason.trim().replace(/\s+/g, " ");
  if (d.decision === "REJECT" && reason.length < 5) throw new ClinicalError("INVALID", "Give a reason for not importing this row (at least 5 characters).");
  if (reason.length > 300) throw new ClinicalError("INVALID", "Reason: at most 300 characters.");
  await asChief(s, async (c) => {
    const r = await c.query<{ batch_id: string; parsed: ParsedRow; flags: ImportFlag[] }>(
      "SELECT batch_id, parsed, flags FROM import_row WHERE id = $1 FOR UPDATE",
      [rowId],
    );
    const row = r.rows[0];
    if (!row) throw new ClinicalError("NOT_FOUND", "Row not found.");
    requireStaged(await loadBatch(c, row.batch_id, true));
    if (d.decision === "ACCEPT") {
      const e = effectiveRow(row.parsed, row.flags, resolved);
      if (e.blocking.length) throw new ClinicalError("INVALID", `Resolve first: ${e.blocking.map((f) => FLAG_INFO[f].label).join("; ")}.`);
      if (!d.patientLink) throw new ClinicalError("INVALID", "Choose whether this is a new patient or an existing one.");
      if (d.patientLink === "EXISTING") {
        if (!d.patientId || !UUID_RE.test(d.patientId)) throw new ClinicalError("INVALID", "Choose the existing patient.");
        const p = await c.query("SELECT 1 FROM patient WHERE id = $1 AND voided_at IS NULL", [d.patientId]);
        if (!p.rowCount) throw new ClinicalError("INVALID", "That patient is not available.");
      }
      if (d.patientLink === "SAME_AS_ROW") {
        if (!d.sameAsRowId || d.sameAsRowId === rowId) throw new ClinicalError("INVALID", "Choose the other row for the same person.");
        const o = await c.query<{ batch_id: string; patient_link: string | null }>("SELECT batch_id, patient_link FROM import_row WHERE id = $1", [
          d.sameAsRowId,
        ]);
        if (o.rows[0]?.batch_id !== row.batch_id) throw new ClinicalError("INVALID", "The other row must be in the same import.");
        if (o.rows[0].patient_link === "SAME_AS_ROW")
          throw new ClinicalError("INVALID", "Link to the row that creates or names the patient, not to another linked row.");
      }
    }
    await c.query(
      `UPDATE import_row SET resolved = $2, decision = $3, decision_reason = $4, patient_link = $5, patient_id = $6, same_as_row_id = $7,
              decided_at = CASE WHEN $3 = 'PENDING' THEN NULL ELSE now() END, decided_by = CASE WHEN $3 = 'PENDING' THEN NULL ELSE $8::uuid END
        WHERE id = $1`,
      [
        rowId,
        JSON.stringify(resolved),
        d.decision,
        reason || null,
        d.decision === "ACCEPT" ? d.patientLink : null,
        d.decision === "ACCEPT" && d.patientLink === "EXISTING" ? d.patientId : null,
        d.decision === "ACCEPT" && d.patientLink === "SAME_AS_ROW" ? d.sameAsRowId : null,
        s.staffId,
      ],
    );
    await refreshCrossFlags(c, row.batch_id);
  });
}

/**
 * Accepts repeat visits that can be linked safely, so the reviewer only sees the real doubts:
 *  - a row whose name matches exactly ONE existing patient with no sex conflict → that patient;
 *  - rows in this batch with the same name whose sex agrees and ages differ by ≤ 2 years →
 *    the earliest row creates the patient, the others are linked to it.
 * Rows with a blocking problem or a possible duplicate entry are never touched.
 */
export async function acceptSuggestedLinks(s: Session, batchId: string): Promise<{ existing: number; linked: number; created: number }> {
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    const rows = await c.query<{
      id: string;
      sheet_name: string;
      row_number: number;
      parsed: ParsedRow;
      flags: ImportFlag[];
      resolved: Resolution;
      decision: string;
      patient_link: string | null;
      nk: string;
    }>(
      `SELECT id, sheet_name, row_number, parsed, flags, resolved, decision, patient_link,
              name_key(coalesce(resolved ->> 'name', parsed ->> 'name')) AS nk
         FROM import_row WHERE batch_id = $1`,
      [batchId],
    );
    const sheetOrder = new Map(b.sheets.map((x, i) => [x.name, i]));
    const ok = (r: (typeof rows.rows)[number]) =>
      r.nk !== "" && !effectiveRow(r.parsed, r.flags, r.resolved).blocking.length && !r.flags.includes("DUPLICATE_CANDIDATE");
    const consistent = (group: Array<(typeof rows.rows)[number]>, extraSex?: string | null) => {
      const sexes = new Set(group.map((r) => r.parsed.sex).filter(Boolean) as string[]);
      if (extraSex && extraSex !== "UNKNOWN" && extraSex !== "X") sexes.add(extraSex);
      if (sexes.size > 1) return false;
      const ages = group.map((r) => r.parsed.ageYears).filter((a): a is number => a !== null);
      return !ages.length || Math.max(...ages) - Math.min(...ages) <= 2;
    };
    const groups = new Map<string, Array<(typeof rows.rows)[number]>>();
    for (const r of rows.rows) if (r.nk) groups.set(r.nk, [...(groups.get(r.nk) ?? []), r]);

    let existing = 0,
      linked = 0,
      created = 0;
    const decide = async (id: string, link: "NEW" | "EXISTING" | "SAME_AS_ROW", ref: string | null, why: string) => {
      await c.query(
        `UPDATE import_row SET decision = 'ACCEPT', patient_link = $2, patient_id = $3, same_as_row_id = $4, decided_at = now(), decided_by = $5, decision_reason = $6
          WHERE id = $1 AND decision = 'PENDING'`,
        [id, link, link === "EXISTING" ? ref : null, link === "SAME_AS_ROW" ? ref : null, s.staffId, why],
      );
    };
    for (const [nk, group] of groups) {
      const pending = group.filter((r) => r.decision === "PENDING" && ok(r));
      if (!pending.length) continue;
      const matches = await c.query<{ id: string; sex: string }>("SELECT id, sex FROM patient WHERE voided_at IS NULL AND name_key(full_name) = $1", [nk]);
      if (matches.rowCount === 1) {
        if (!consistent(group, matches.rows[0].sex)) continue;
        for (const r of pending) {
          await decide(r.id, "EXISTING", matches.rows[0].id, "Auto-linked: same name and sex as the one existing patient");
          existing++;
        }
        continue;
      }
      if (matches.rowCount! > 1 || group.length < 2 || !consistent(group)) continue;
      const sorted = [...group].sort(
        (a, b2) =>
          (a.parsed.date ?? "9999").localeCompare(b2.parsed.date ?? "9999") ||
          (sheetOrder.get(a.sheet_name) ?? 0) - (sheetOrder.get(b2.sheet_name) ?? 0) ||
          a.row_number - b2.row_number,
      );
      const anchor = sorted.find((r) => r.decision === "ACCEPT" && r.patient_link !== "SAME_AS_ROW") ?? sorted.find((r) => r.decision === "PENDING" && ok(r));
      if (!anchor) continue;
      if (anchor.decision === "PENDING") {
        await decide(anchor.id, "NEW", null, "Auto: first visit of a repeat patient");
        created++;
      }
      for (const r of pending) {
        if (r.id === anchor.id) continue;
        await decide(r.id, "SAME_AS_ROW", anchor.id, "Auto-linked: repeat visit (same name, sex and age)");
        linked++;
      }
    }
    await audit(c, "import.suggested_links_accepted", { existing, linked, created }, { table: "import_batch", id: batchId });
    return { existing, linked, created };
  });
}

/** Accepts, as NEW patients, only rows with no blocking flag and nothing needing a matching decision. */
export async function acceptCleanRows(s: Session, batchId: string, sheet?: string): Promise<{ accepted: number }> {
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    const rows = await c.query<{ id: string; parsed: ParsedRow; flags: ImportFlag[]; resolved: Resolution }>(
      "SELECT id, parsed, flags, resolved FROM import_row WHERE batch_id = $1 AND decision = 'PENDING' AND ($2::text IS NULL OR sheet_name = $2)",
      [batchId, sheet ?? null],
    );
    const ids = rows.rows
      .filter((r) => !effectiveRow(r.parsed, r.flags, r.resolved).blocking.length && !r.flags.some((f) => CROSS.includes(f)))
      .map((r) => r.id);
    if (ids.length) {
      await c.query(
        "UPDATE import_row SET decision = 'ACCEPT', patient_link = 'NEW', decided_at = now(), decided_by = $2, decision_reason = 'Bulk-accepted: no flags needing review' WHERE id = ANY($1::uuid[])",
        [ids, s.staffId],
      );
    }
    await audit(c, "import.bulk_accepted", { rows: ids.length, sheet: sheet ?? null }, { table: "import_batch", id: batchId });
    return { accepted: ids.length };
  });
}

// ---------------------------------------------------------------- dry run, report, commit, reverse

export interface DryRun {
  atIso: string;
  rows: number;
  accepted: number;
  rejected: number;
  pending: number;
  blockingOnAccepted: number;
  newPatients: number;
  existingPatients: number;
  linkedRows: number;
  appointments: number;
  problems: string[];
  ready: boolean;
}

async function computeDryRun(c: Tx, batchId: string): Promise<DryRun> {
  const rows = await c.query<{
    id: string;
    parsed: ParsedRow;
    flags: ImportFlag[];
    resolved: Resolution;
    decision: string;
    patient_link: string | null;
    same_as_row_id: string | null;
  }>("SELECT id, parsed, flags, resolved, decision, patient_link, same_as_row_id FROM import_row WHERE batch_id = $1", [batchId]);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const acc = rows.rows.filter((r) => r.decision === "ACCEPT");
  const problems: string[] = [];
  const blockingOnAccepted = acc.filter((r) => effectiveRow(r.parsed, r.flags, r.resolved).blocking.length).length;
  const pending = rows.rows.filter((r) => r.decision === "PENDING").length;
  if (pending) problems.push(`${pending} row(s) still need a decision (import or not).`);
  if (blockingOnAccepted) problems.push(`${blockingOnAccepted} accepted row(s) still have unresolved problems.`);
  const badLinks = acc.filter((r) => r.patient_link === "SAME_AS_ROW" && byId.get(r.same_as_row_id!)?.decision !== "ACCEPT").length;
  if (badLinks) problems.push(`${badLinks} row(s) are linked to a row that will not be imported.`);
  return {
    atIso: new Date().toISOString(),
    rows: rows.rows.length,
    accepted: acc.length,
    rejected: rows.rows.filter((r) => r.decision === "REJECT").length,
    pending,
    blockingOnAccepted,
    newPatients: acc.filter((r) => r.patient_link === "NEW").length,
    existingPatients: acc.filter((r) => r.patient_link === "EXISTING").length,
    linkedRows: acc.filter((r) => r.patient_link === "SAME_AS_ROW").length,
    appointments: acc.length,
    problems,
    ready: problems.length === 0 && acc.length > 0,
  };
}

export async function dryRun(s: Session, batchId: string): Promise<DryRun> {
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    const d = await computeDryRun(c, batchId);
    await c.query("UPDATE import_batch SET summary = $2 WHERE id = $1", [batchId, JSON.stringify(d)]);
    await audit(c, "import.dry_run", { ...d, problems: d.problems.length }, { table: "import_batch", id: batchId });
    return d;
  });
}

/**
 * Exception report (CSV). Identifies rows only by worksheet and row number — no names or other
 * patient values — so the file is safe to circulate to the reviewers who hold the workbook.
 */
export async function exceptionReport(s: Session, batchId: string): Promise<{ fileName: string; csv: string }> {
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId);
    const rows = await c.query<{
      sheet_name: string;
      row_number: number;
      parsed: ParsedRow;
      flags: ImportFlag[];
      resolved: Resolution;
      decision: string;
      decision_reason: string | null;
      patient_link: string | null;
    }>(
      "SELECT sheet_name, row_number, parsed, flags, resolved, decision, decision_reason, patient_link FROM import_row WHERE batch_id = $1 ORDER BY sheet_name, row_number",
      [batchId],
    );
    let csv = csvLine(["PUIMS import exception report", `file sha256 ${b.file_sha256}`, `status ${b.status}`, `generated ${new Date().toISOString()}`]);
    csv += csvLine(["worksheet", "row", "decision", "patient link", "unresolved (blocking)", "other flags", "resolved fields", "reviewer reason"]);
    for (const r of rows.rows) {
      const e = effectiveRow(r.parsed, r.flags, r.resolved);
      const other = r.flags.filter((f) => !e.blocking.includes(f));
      if (!r.flags.length && r.decision === "ACCEPT") continue; // clean, accepted rows are not exceptions
      csv += csvLine([
        r.sheet_name,
        r.row_number,
        r.decision,
        r.patient_link ?? "",
        e.blocking.map((f) => FLAG_INFO[f].label).join("; "),
        other.map((f) => FLAG_INFO[f].label).join("; "),
        Object.keys(r.resolved).join(" "),
        r.decision_reason ?? "",
      ]);
    }
    await audit(c, "import.exception_report_downloaded", { rows: rows.rowCount }, { table: "import_batch", id: batchId });
    return { fileName: `puims-import-exceptions-${b.id.slice(0, 8)}.csv`, csv };
  });
}

export async function commitBatch(s: Session, batchId: string): Promise<DryRun> {
  requireReauth(s);
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    await c.query("LOCK TABLE import_row IN SHARE ROW EXCLUSIVE MODE");
    const d = await computeDryRun(c, batchId);
    if (!d.ready) throw new ClinicalError("CONFLICT", d.problems.join(" ") || "Nothing to import.");
    const rows = await c.query<{
      id: string;
      parsed: ParsedRow;
      flags: ImportFlag[];
      resolved: Resolution;
      patient_link: string;
      patient_id: string | null;
      same_as_row_id: string | null;
    }>(
      "SELECT id, parsed, flags, resolved, patient_link, patient_id, same_as_row_id FROM import_row WHERE batch_id = $1 AND decision = 'ACCEPT' ORDER BY sheet_name, row_number",
      [batchId],
    );
    const patientOf = new Map<string, string>();
    // 1. New patients (identity only as written; sex only when clearly M/F; no DOB inferred from age).
    for (const r of rows.rows.filter((x) => x.patient_link === "NEW")) {
      const e = effectiveRow(r.parsed, r.flags, r.resolved);
      const p = await c.query<{ id: string }>(
        `INSERT INTO patient (full_name, sex, category, provenance, created_by, updated_by) VALUES ($1, $2, $3, 'IMPORT', $4, $4) RETURNING id`,
        [e.name, e.sex, e.category, s.staffId],
      );
      patientOf.set(r.id, p.rows[0].id);
      await c.query("UPDATE import_row SET created_patient = true, patient_id = $2 WHERE id = $1", [r.id, p.rows[0].id]);
    }
    for (const r of rows.rows) if (r.patient_link === "EXISTING") patientOf.set(r.id, r.patient_id!);
    for (const r of rows.rows) if (r.patient_link === "SAME_AS_ROW") patientOf.set(r.id, patientOf.get(r.same_as_row_id!)!);
    // 2. Appointments, one per accepted row (repeat visits stay separate events).
    for (const r of rows.rows) {
      const e = effectiveRow(r.parsed, r.flags, r.resolved);
      const { year, month, day } = parseIsoDate(e.date!);
      const [hour, minute] = e.time!.split(":").map(Number);
      const at = zonedWallTimeToUtc({ year, month, day, hour, minute }, HOSPITAL_TZ);
      const remarks = [
        e.remarks,
        e.schedulerLabel ? `Source scheduler: ${e.schedulerLabel}` : null,
        e.performerLabel ? `Source performer: ${e.performerLabel}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 1000);
      const a = await c.query<{ id: string }>(
        `INSERT INTO diagnostic_appointment (patient_id, service, scheduled_at, status, raw_status, procedure_label, requesting_physician, category, payment_class,
                                             raw_age_sex, remarks, source, import_row_id, device_id, contact_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'IMPORT', $12, $13, $14) RETURNING id`,
        [
          patientOf.get(r.id),
          b.service,
          at,
          e.status,
          e.rawStatus,
          e.procedure,
          e.physician,
          e.category,
          e.payment,
          e.rawAgeSex || null,
          remarks || null,
          r.id,
          s.deviceId,
          e.contactNote,
        ],
      );
      await c.query("UPDATE import_row SET appointment_id = $2, patient_id = coalesce(patient_id, $3) WHERE id = $1", [
        r.id,
        a.rows[0].id,
        patientOf.get(r.id),
      ]);
    }
    const done = { ...d, atIso: new Date().toISOString() };
    await c.query("UPDATE import_batch SET status = 'COMMITTED', committed_at = now(), committed_by = $2, summary = $3 WHERE id = $1", [
      batchId,
      s.staffId,
      JSON.stringify(done),
    ]);
    await audit(c, "import.committed", { appointments: d.appointments, new_patients: d.newPatients }, { table: "import_batch", id: batchId });
    return done;
  });
}

/** Reverses a committed import as a unit: voids its appointments and the patients it created (if unused elsewhere). */
export async function voidBatch(s: Session, batchId: string, rawReason: string): Promise<{ appointments: number; patients: number }> {
  requireReauth(s);
  const why = rawReason.trim().replace(/\s+/g, " ");
  if (why.length < 5 || why.length > 300) throw new ClinicalError("INVALID", "Give a reason (5–300 characters).");
  return asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    if (b.status !== "COMMITTED") throw new ClinicalError("CONFLICT", "Only a committed import can be reversed.");
    const appts = await c.query<{ id: string }>(
      "SELECT a.id FROM diagnostic_appointment a JOIN import_row r ON r.id = a.import_row_id WHERE r.batch_id = $1 AND a.voided_at IS NULL",
      [batchId],
    );
    const ids = appts.rows.map((r) => r.id);
    const blockers = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM diagnostic_appointment a
        WHERE a.id = ANY($1::uuid[]) AND (a.status <> coalesce((SELECT (coalesce(r.resolved ->> 'status', r.parsed ->> 'status')) FROM import_row r WHERE r.id = a.import_row_id), a.status)
               OR EXISTS (SELECT 1 FROM pft_form f WHERE f.appointment_id = a.id AND f.voided_at IS NULL)
               OR EXISTS (SELECT 1 FROM diagnostic_appointment x WHERE x.reschedules_id = a.id AND x.voided_at IS NULL))`,
      [ids],
    );
    if (blockers.rows[0].n)
      throw new ClinicalError(
        "CONFLICT",
        `${blockers.rows[0].n} imported appointment(s) have since been updated, rescheduled or documented. Resolve those individually first.`,
      );
    await c.query("UPDATE diagnostic_appointment SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2 WHERE id = ANY($1::uuid[])", [
      ids,
      s.staffId,
      `Import reversed: ${why}`.slice(0, 300),
    ]);
    // Patients created by this batch are voided only if nothing else refers to them.
    const created = await c.query<{ id: string }>(
      `SELECT DISTINCT r.patient_id AS id FROM import_row r WHERE r.batch_id = $1 AND r.created_patient
          AND NOT EXISTS (SELECT 1 FROM diagnostic_appointment a WHERE a.patient_id = r.patient_id AND a.voided_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM neb_order o WHERE o.patient_id = r.patient_id)
          AND NOT EXISTS (SELECT 1 FROM vent_encounter v WHERE v.patient_id = r.patient_id)
          AND NOT EXISTS (SELECT 1 FROM pft_form f WHERE f.patient_id = r.patient_id)`,
      [batchId],
    );
    if (created.rowCount) {
      await c.query("SELECT set_config('app.change_reason', $1, true)", [`Import reversed: ${why}`.slice(0, 300)]);
      await c.query(
        "UPDATE patient SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2 WHERE id = ANY($1::uuid[]) AND voided_at IS NULL",
        [created.rows.map((r) => r.id), s.staffId, `Import reversed: ${why}`.slice(0, 300)],
      );
    }
    await c.query("UPDATE import_batch SET status = 'VOIDED', closed_at = now(), closed_by = $2, close_reason = $3 WHERE id = $1", [batchId, s.staffId, why]);
    await audit(c, "import.reversed", { appointments: ids.length, patients: created.rowCount }, { table: "import_batch", id: batchId });
    return { appointments: ids.length, patients: created.rowCount ?? 0 };
  });
}

/** Discards a staged (never committed) batch and erases its staged raw values. */
export async function discardBatch(s: Session, batchId: string, rawReason: string): Promise<void> {
  const why = rawReason.trim().replace(/\s+/g, " ");
  if (why.length < 5 || why.length > 300) throw new ClinicalError("INVALID", "Give a reason (5–300 characters).");
  await asChief(s, async (c) => {
    const b = await loadBatch(c, batchId, true);
    requireStaged(b);
    await c.query("UPDATE import_row SET raw = '{}', parsed = '{}', resolved = '{}', flags = '{}' WHERE batch_id = $1", [batchId]);
    await c.query("UPDATE import_batch SET original_enc = NULL, original_mime = NULL WHERE id = $1", [batchId]);
    await c.query("UPDATE import_batch SET status = 'DISCARDED', closed_at = now(), closed_by = $2, close_reason = $3 WHERE id = $1", [
      batchId,
      s.staffId,
      why,
    ]);
    await audit(c, "import.discarded", undefined, { table: "import_batch", id: batchId });
  });
}

export async function listBatches(s: Session) {
  return asChief(s, async (c) => {
    const r = await c.query<{
      id: string;
      file_name: string;
      status: string;
      created_at: Date;
      by: string;
      rows: number;
      accepted: number;
      appointments: number;
    }>(
      `SELECT b.id, b.file_name, b.status, b.created_at, s.display_name AS by,
              (SELECT count(*)::int FROM import_row r WHERE r.batch_id = b.id) AS rows,
              (SELECT count(*)::int FROM import_row r WHERE r.batch_id = b.id AND r.decision = 'ACCEPT') AS accepted,
              (SELECT count(*)::int FROM import_row r WHERE r.batch_id = b.id AND r.appointment_id IS NOT NULL) AS appointments
         FROM import_batch b JOIN staff s ON s.id = b.created_by ORDER BY b.created_at DESC LIMIT 50`,
    );
    return r.rows.map((x) => ({
      id: x.id,
      fileName: x.file_name,
      status: x.status,
      createdIso: new Date(x.created_at).toISOString(),
      by: x.by,
      rows: x.rows,
      accepted: x.accepted,
      appointments: x.appointments,
    }));
  });
}

/** The retained original workbook (Chief RT, step-up). Every download is audited. */
export async function originalWorkbook(s: Session, batchId: string): Promise<{ fileName: string; bytes: Buffer }> {
  requireReauth(s);
  return asChief(s, async (c) => {
    if (!UUID_RE.test(batchId)) throw new ClinicalError("NOT_FOUND", "Import batch not found.");
    const r = await c.query<{ file_name: string; original_enc: Buffer | null; file_sha256: string }>(
      "SELECT file_name, original_enc, file_sha256 FROM import_batch WHERE id = $1",
      [batchId],
    );
    const b = r.rows[0];
    if (!b) throw new ClinicalError("NOT_FOUND", "Import batch not found.");
    if (!b.original_enc) throw new ClinicalError("NOT_FOUND", "No original workbook is kept for this batch.");
    const bytes = decryptBytes(b.original_enc);
    if (createHash("sha256").update(bytes).digest("hex") !== b.file_sha256)
      throw new ClinicalError("CONFLICT", "The stored original does not match its checksum.");
    await audit(c, "import.original_downloaded", { bytes: bytes.length }, { table: "import_batch", id: batchId });
    return { fileName: b.file_name, bytes };
  });
}

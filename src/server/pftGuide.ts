import "server-only";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { hasRecentReauth } from "./auth/service";
import { ClinicalError } from "./clinical";
import { audit, tx } from "./db";
import { logoMime, MAX_LOGO_BYTES } from "./pft";
import type { Session } from "./session";

/**
 * Loads the hospital's PFT guide workbook (form AS-PUL-PFT-006) AS IS — product owner's rule:
 * "don't change anything in the Excel file". Nothing is retyped, corrected or reformatted:
 *  - header / address / trunkline: the exact lines of the header cell;
 *  - item 6 (bronchodilator statement) and the form code: exact cell text;
 *  - logo: the image at the top of the Patient Data sheet, byte for byte;
 *  - signatures: each image on the RT / Pulmo signature sheets, byte for byte, with the name written
 *    under it exactly as typed — staged as proposals that the Chief RT accepts one by one.
 * The workbook itself is parsed in memory and not stored.
 */

export interface GuideExtract {
  facilityHeader: string;
  facilityAddress: string | null;
  formCode: string | null;
  bronchodilatorNote: string | null;
  logo: { bytes: Buffer; mime: string } | null;
  signatures: Array<{ kind: "RESPIRATORY_THERAPIST" | "PULMONOLOGIST"; name: string | null; bytes: Buffer; mime: string; source: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cellString(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return null;
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r: { text?: string }) => r.text ?? "").join("");
    if (typeof v.text === "string") return v.text;
    if (v.result !== undefined) return cellString(v.result);
  }
  return null;
}

const colName = (c: number) => {
  let s = "";
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export async function extractGuide(bytes: Buffer): Promise<GuideExtract> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new ClinicalError("INVALID", "The file could not be read as an Excel workbook (.xlsx).");
  }
  const sheet = wb.worksheets.find((w) => /patient/i.test(w.name)) ?? wb.worksheets[0];
  if (!sheet) throw new ClinicalError("INVALID", "The workbook has no worksheets.");
  const cells: Array<{ r: number; c: number; t: string }> = [];
  sheet.eachRow({ includeEmpty: false }, (row, r) =>
    row.eachCell((cell, c) => {
      if (cell.isMerged && cell.master !== cell) return;
      const t = cellString(cell.value);
      if (t && t.trim()) cells.push({ r, c, t });
    }),
  );
  if (!cells.some((x) => /PULMONARY FUNCTION TEST/i.test(x.t)))
    throw new ClinicalError("INVALID", "This does not look like the PFT guide workbook (no “PULMONARY FUNCTION TEST” title found).");
  const head = cells.filter((x) => x.r <= 4 && !/PULMONARY FUNCTION TEST/i.test(x.t)).sort((a, b) => a.r - b.r || a.c - b.c)[0];
  if (!head) throw new ClinicalError("INVALID", "No facility header found at the top of the form.");
  const lines = head.t.split(/\r?\n/);
  const item6 = cells.find((x) => /^\s*6\.\s/.test(x.t));
  const code = cells.find((x) => /^\s*AS-[A-Z0-9-]+\s*$/.test(x.t));

  const imageOf = (id: string | number) => {
    const m = wb.getImage(Number(id)) as unknown as { buffer?: Buffer; extension?: string } | undefined;
    if (!m?.buffer) return null;
    const buf = Buffer.from(m.buffer);
    const mime = logoMime(buf);
    return mime && buf.length <= MAX_LOGO_BYTES ? { bytes: buf, mime } : null;
  };
  const pos = (im: { range: { tl: { nativeRow?: number; row?: number; nativeCol?: number; col?: number } } }) => ({
    r: Math.floor(im.range.tl.nativeRow ?? im.range.tl.row ?? 0) + 1,
    c: Math.floor(im.range.tl.nativeCol ?? im.range.tl.col ?? 0) + 1,
  });
  const top = sheet
    .getImages()
    .map((im) => ({ im, p: pos(im) }))
    .filter((x) => x.p.r <= 4)
    .sort((a, b) => a.p.r - b.p.r || a.p.c - b.p.c)[0];
  const logo = top ? imageOf(top.im.imageId) : null;

  const signatures: GuideExtract["signatures"] = [];
  for (const ws of wb.worksheets) {
    if (ws === sheet) continue;
    const kind = /pulmo|doctor|\bmd\b/i.test(ws.name) ? "PULMONOLOGIST" : /\brt\b|therap/i.test(ws.name) ? "RESPIRATORY_THERAPIST" : null;
    if (!kind) continue;
    const texts: Array<{ r: number; c: number; t: string }> = [];
    ws.eachRow({ includeEmpty: false }, (row, r) =>
      row.eachCell((cell, c) => {
        if (cell.isMerged && cell.master !== cell) return;
        const t = cellString(cell.value);
        if (t && t.trim()) texts.push({ r, c, t });
      }),
    );
    const seen = new Set<string>();
    for (const im of ws.getImages()) {
      const p = pos(im);
      const key = `${im.imageId}@${p.r}:${p.c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const img = imageOf(im.imageId);
      if (!img) continue;
      if (logo && img.bytes.equals(logo.bytes)) continue; // a copy of the hospital logo, not a signature
      // The name written under the signature: nearest text below the image, within a few columns.
      const near = texts
        .filter((x) => x.r > p.r && x.r <= p.r + 12 && x.c >= p.c - 1 && x.c <= p.c + 4)
        .sort((a, b) => (a.r - p.r) * 2 + Math.abs(a.c - p.c) - ((b.r - p.r) * 2 + Math.abs(b.c - p.c)))[0];
      signatures.push({
        kind,
        name: near ? near.t : null, // exactly as written
        bytes: img.bytes,
        mime: img.mime,
        source: `${ws.name}!${colName(p.c)}${p.r}${near ? ` (name in ${colName(near.c)}${near.r})` : ""}`.slice(0, 200),
      });
    }
  }
  return {
    facilityHeader: lines[0],
    facilityAddress: lines.length > 1 ? lines.slice(1).join("\n") : null,
    formCode: code ? code.t : null,
    bronchodilatorNote: item6 ? item6.t.replace(/^\s*6\.\s/, "") : null,
    logo,
    signatures,
  };
}

/** Chief RT, step-up: create a template version from the guide and stage its signatures for review. */
export async function importPftGuide(s: Session, bytes: Buffer): Promise<{ version: number; logo: boolean; proposals: number }> {
  if (s.role !== "CHIEF_RT_ADMIN") throw new ClinicalError("FORBIDDEN", "Only the Chief RT can load the PFT guide.");
  if (!hasRecentReauth(s)) throw new ClinicalError("REAUTH_REQUIRED", "Confirm your password to continue.");
  if (bytes.length > 10 * 1024 * 1024) throw new ClinicalError("INVALID", "The file is larger than 10 MB.");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ClinicalError("INVALID", "Only .xlsx workbooks are accepted.");
  const g = await extractGuide(bytes);
  if (g.facilityHeader.length > 200 || (g.facilityAddress?.length ?? 0) > 300 || (g.bronchodilatorNote?.length ?? 0) > 400 || (g.formCode?.length ?? 0) > 40)
    throw new ClinicalError("INVALID", "A header or statement in the workbook is longer than the form allows; nothing was changed.");
  const sha = createHash("sha256").update(bytes).digest("hex");
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, async (c) => {
    const ok = await c.query<{ ok: boolean }>("SELECT app_is_chief() AS ok");
    if (!ok.rows[0]?.ok) throw new ClinicalError("FORBIDDEN", "Only the Chief RT can load the PFT guide.");
    const prev = await c.query<{ v: number; form_revision: string; form_code: string }>(
      "SELECT version AS v, form_revision, form_code FROM pft_template ORDER BY version DESC LIMIT 1",
    );
    const version = (prev.rows[0]?.v ?? 0) + 1;
    await c.query(
      `INSERT INTO pft_template (version, form_code, facility_header, facility_address, form_revision, bronchodilator_note, hospital_confirmed, created_by, logo, logo_mime)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)`,
      [
        version,
        g.formCode ?? prev.rows[0]?.form_code ?? "AS-PUL-PFT-006",
        g.facilityHeader,
        g.facilityAddress,
        prev.rows[0]?.form_revision ?? "As printed on the hospital PFT guide",
        g.bronchodilatorNote,
        s.staffId,
        g.logo?.bytes ?? null,
        g.logo?.mime ?? null,
      ],
    );
    await c.query("UPDATE signatory_proposal SET decided_at = now(), decision = 'DISMISSED' WHERE decided_at IS NULL");
    for (const x of g.signatures) {
      await c.query(
        "INSERT INTO signatory_proposal (kind, display_name, signature_image, signature_mime, source, file_sha256, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [x.kind, x.name && x.name.length <= 200 ? x.name : null, x.bytes, x.mime, x.source, sha, s.staffId],
      );
    }
    await audit(c, "pft.guide_loaded", { version, logo: !!g.logo, proposals: g.signatures.length, sha256: sha });
    return { version, logo: !!g.logo, proposals: g.signatures.length };
  });
}

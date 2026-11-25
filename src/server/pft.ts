import "server-only";
import { roleHas } from "@/lib/authz/permissions";
import { calendarDateOf, parseIsoDate, type IsoDate } from "@/lib/time/zoned";
import { hasRecentReauth } from "./auth/service";
import { ClinicalError } from "./clinical";
import { getNow } from "./clock";
import { audit, tx, type Tx } from "./db";
import type { Session } from "./session";

/**
 * Milestone 5 — the PFT form (form AS-PUL-PFT-006 section structure) as the OFFICIAL clinical record
 * (decision 2026-11-22, U-10). Lifecycle, enforced again by triggers in migration 0007:
 *
 *   DRAFT ──(author RT signs: password)──▶ RT_SIGNED ──(RT records the pulmonologist's
 *   sign-off on the printed copy + types their interpretation; step-up)──▶ FINAL ──▶ amendments only
 *
 * Nothing is auto-filled into narrative sections, nothing is auto-signed, and interpretation is only
 * ever text a person typed. Header/revision/bronchodilator statement come from a Chief-maintained,
 * versioned template that starts as clearly-marked placeholders.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `stepUp` documents (at call sites) that the action required a fresh password check. */
function as<T>(s: Session, fn: (c: Tx) => Promise<T>, stepUp = false): Promise<T> {
  void stepUp;
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}
function requireRt(s: Session) {
  if (s.role !== "RESPIRATORY_THERAPIST") throw new ClinicalError("FORBIDDEN", "Only Respiratory Therapists document PFT forms.");
}
function requireChief(s: Session) {
  if (s.role !== "CHIEF_RT_ADMIN") throw new ClinicalError("FORBIDDEN", "Only the Chief RT can do this.");
}
function requireReauth(s: Session) {
  if (!hasRecentReauth(s)) throw new ClinicalError("REAUTH_REQUIRED", "Confirm your password to sign.");
}
const text = (v: unknown, max: number, label: string): string | null => {
  const t = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "";
  if (!t) return null;
  if (t.length > max) throw new ClinicalError("INVALID", `${label}: at most ${max} characters.`);
  return t;
};

// ================================================================= template + signatories

export interface PftTemplate {
  id: string;
  version: number;
  formCode: string;
  facilityHeader: string;
  facilityAddress: string | null;
  formRevision: string;
  bronchodilatorNote: string | null;
  hospitalConfirmed: boolean;
  createdIso: string;
  /** Hospital logo for this template version, served by /api/pft/logo/{id} (PNG or JPEG). */
  hasLogo: boolean;
}

/** Template columns without the logo bytes (those are served separately). */
const TEMPLATE_COLS =
  "id, version, form_code, facility_header, facility_address, form_revision, bronchodilator_note, hospital_confirmed, created_at, created_by, (logo IS NOT NULL) AS has_logo";
export const MAX_LOGO_BYTES = 512 * 1024;

/** Accepts only real PNG/JPEG files (checked by signature, not by name). SVG is refused: it can carry script. */
export function logoMime(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toTemplate = (r: any): PftTemplate => ({
  id: r.id,
  version: r.version,
  formCode: r.form_code,
  facilityHeader: r.facility_header,
  facilityAddress: r.facility_address,
  formRevision: r.form_revision,
  bronchodilatorNote: r.bronchodilator_note,
  hospitalConfirmed: r.hospital_confirmed,
  createdIso: new Date(r.created_at).toISOString(),
  hasLogo: !!r.has_logo,
});

export async function currentTemplate(c: Tx): Promise<PftTemplate> {
  const r = await c.query(`SELECT ${TEMPLATE_COLS} FROM pft_template ORDER BY version DESC LIMIT 1`);
  if (!r.rows[0]) throw new ClinicalError("CONFLICT", "No PFT template is configured. The Chief RT must create one in Settings.");
  return toTemplate(r.rows[0]);
}

export async function getPftAdmin(s: Session) {
  if (!roleHas(s.role, "settings:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const t = await c.query(`SELECT ${TEMPLATE_COLS} FROM pft_template ORDER BY version DESC`);
    const g = await c.query<{
      id: string;
      kind: string;
      display_name: string;
      credentials: string | null;
      staff_id: string | null;
      username: string | null;
      active: boolean;
      created_at: Date;
      has_signature: boolean;
      source: string | null;
    }>(
      `SELECT g.id, g.kind, g.display_name, g.credentials, g.staff_id, st.username, g.active, g.created_at,
              (g.signature_image IS NOT NULL) AS has_signature, g.source
         FROM signatory g LEFT JOIN staff st ON st.id = g.staff_id ORDER BY g.active DESC, g.kind, g.display_name`,
    );
    const rts = await c.query<{ id: string; display_name: string; username: string }>(
      "SELECT id, display_name, username FROM staff WHERE role = 'RESPIRATORY_THERAPIST' AND status = 'ACTIVE' ORDER BY display_name",
    );
    return {
      templates: t.rows.map(toTemplate),
      signatories: g.rows.map((x) => ({
        id: x.id,
        kind: x.kind as "RESPIRATORY_THERAPIST" | "PULMONOLOGIST",
        displayName: x.display_name,
        credentials: x.credentials,
        staffId: x.staff_id,
        username: x.username,
        active: x.active,
        createdIso: new Date(x.created_at).toISOString(),
        hasSignature: x.has_signature,
        source: x.source,
      })),
      proposals:
        s.role === "CHIEF_RT_ADMIN"
          ? (
              await c.query<{ id: string; kind: string; display_name: string | null; source: string }>(
                "SELECT id, kind, display_name, source FROM signatory_proposal WHERE decided_at IS NULL ORDER BY kind, source",
              )
            ).rows.map((x) => ({ id: x.id, kind: x.kind as "RESPIRATORY_THERAPIST" | "PULMONOLOGIST", displayName: x.display_name, source: x.source }))
          : [],
      activeRts: rts.rows.map((r) => ({ id: r.id, displayName: r.display_name, username: r.username })),
    };
  });
}

export async function createTemplateVersion(
  s: Session,
  input: {
    facilityHeader: string;
    facilityAddress: string;
    formRevision: string;
    bronchodilatorNote: string;
    hospitalConfirmed: boolean;
    /** "keep" the current version's logo, "remove" it, or a new PNG/JPEG file. */
    logo?: "keep" | "remove" | Buffer;
  },
): Promise<void> {
  requireChief(s);
  requireReauth(s);
  let newLogo: { bytes: Buffer; mime: string } | null = null;
  if (Buffer.isBuffer(input.logo)) {
    if (input.logo.length > MAX_LOGO_BYTES) throw new ClinicalError("INVALID", "Logo: at most 512 KB.");
    const mime = logoMime(input.logo);
    if (!mime) throw new ClinicalError("INVALID", "Logo: upload a PNG or JPEG image.");
    newLogo = { bytes: input.logo, mime };
  }
  const header = text(input.facilityHeader, 200, "Facility header");
  const revision = text(input.formRevision, 60, "Form revision");
  if (!header || !revision) throw new ClinicalError("INVALID", "Facility header and form revision are required.");
  await as(
    s,
    async (c) => {
      const v = await c.query<{ v: number }>("SELECT coalesce(max(version), 0) + 1 AS v FROM pft_template");
      if (!newLogo && (input.logo ?? "keep") === "keep") {
        const prev = await c.query<{ logo: Buffer | null; logo_mime: string | null }>("SELECT logo, logo_mime FROM pft_template ORDER BY version DESC LIMIT 1");
        if (prev.rows[0]?.logo) newLogo = { bytes: prev.rows[0].logo, mime: prev.rows[0].logo_mime! };
      }
      await c.query(
        `INSERT INTO pft_template (version, facility_header, facility_address, form_revision, bronchodilator_note, hospital_confirmed, created_by, logo, logo_mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          v.rows[0].v,
          header,
          text(input.facilityAddress, 300, "Address"),
          revision,
          text(input.bronchodilatorNote, 400, "Bronchodilator statement"),
          !!input.hospitalConfirmed,
          s.staffId,
          newLogo?.bytes ?? null,
          newLogo?.mime ?? null,
        ],
      );
      await audit(c, "pft.template_version_created", {
        version: v.rows[0].v,
        hospital_confirmed: !!input.hospitalConfirmed,
        logo_bytes: newLogo?.bytes.length ?? 0,
      });
    },
    true,
  );
}

function signatureFile(b: Buffer | null | undefined): { bytes: Buffer; mime: string } | null {
  if (!b || !b.length) return null;
  if (b.length > MAX_LOGO_BYTES) throw new ClinicalError("INVALID", "Signature image: at most 512 KB.");
  const mime = logoMime(b);
  if (!mime) throw new ClinicalError("INVALID", "Signature image: upload a PNG or JPEG.");
  return { bytes: b, mime };
}

export async function addSignatory(
  s: Session,
  input: { kind: string; displayName: string; credentials: string; staffId: string; signature?: Buffer | null; source?: string | null },
): Promise<string> {
  requireChief(s);
  requireReauth(s);
  const sig = signatureFile(input.signature);
  if (input.kind !== "RESPIRATORY_THERAPIST" && input.kind !== "PULMONOLOGIST") throw new ClinicalError("INVALID", "Choose RT or Pulmonologist.");
  // Name kept exactly as entered / as written in the source workbook (no reformatting).
  const name = typeof input.displayName === "string" && input.displayName.trim() ? input.displayName : null;
  if (!name || name.trim().length < 2 || name.length > 120) throw new ClinicalError("INVALID", "Name is required (at most 120 characters).");
  const staffId = input.kind === "RESPIRATORY_THERAPIST" ? input.staffId : "";
  if (staffId && !UUID_RE.test(staffId)) throw new ClinicalError("INVALID", "Choose an RT account.");
  return as(
    s,
    async (c) => {
      if (staffId) {
        const st = await c.query("SELECT 1 FROM staff WHERE id = $1 AND role = 'RESPIRATORY_THERAPIST' AND status = 'ACTIVE'", [staffId]);
        if (!st.rowCount) throw new ClinicalError("INVALID", "Choose an active RT account.");
        const dup = await c.query("SELECT 1 FROM signatory WHERE staff_id = $1 AND active", [staffId]);
        if (dup.rowCount) throw new ClinicalError("CONFLICT", "That RT already has an active signatory entry. Deactivate it first.");
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO signatory (kind, display_name, credentials, staff_id, created_by, signature_image, signature_mime, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          input.kind,
          name,
          text(input.credentials, 120, "Credentials"),
          staffId || null,
          s.staffId,
          sig?.bytes ?? null,
          sig?.mime ?? null,
          input.source ?? null,
        ],
      );
      await audit(c, "pft.signatory_added", { kind: input.kind, with_signature: !!sig });
      return r.rows[0].id;
    },
    true,
  );
}

/** Adds the e-signature image to an entry that has none (once), or links an RT entry to its account (once). */
export async function completeSignatory(s: Session, id: string, input: { signature?: Buffer | null; staffId?: string }): Promise<void> {
  requireChief(s);
  requireReauth(s);
  const sig = signatureFile(input.signature);
  if (!sig && !input.staffId) throw new ClinicalError("INVALID", "Choose a signature image or an account.");
  await as(s, async (c) => {
    const r = await c.query<{ kind: string; staff_id: string | null; has_sig: boolean; active: boolean }>(
      "SELECT kind, staff_id, signature_image IS NOT NULL AS has_sig, active FROM signatory WHERE id = $1 FOR UPDATE",
      [id],
    );
    const g = r.rows[0];
    if (!g || !g.active) throw new ClinicalError("NOT_FOUND", "Active signatory not found.");
    if (sig) {
      if (g.has_sig) throw new ClinicalError("CONFLICT", "This entry already has a signature. Deactivate it and add a new entry to change it.");
      await c.query("UPDATE signatory SET signature_image = $2, signature_mime = $3 WHERE id = $1", [id, sig.bytes, sig.mime]);
    }
    if (input.staffId) {
      if (g.kind !== "RESPIRATORY_THERAPIST" || g.staff_id) throw new ClinicalError("CONFLICT", "Only an RT entry without an account can be linked.");
      const st = await c.query("SELECT 1 FROM staff WHERE id = $1 AND role = 'RESPIRATORY_THERAPIST' AND status = 'ACTIVE'", [input.staffId]);
      if (!st.rowCount) throw new ClinicalError("INVALID", "Choose an active RT account.");
      const dup = await c.query("SELECT 1 FROM signatory WHERE staff_id = $1 AND active", [input.staffId]);
      if (dup.rowCount) throw new ClinicalError("CONFLICT", "That RT already has an active signatory entry.");
      await c.query("UPDATE signatory SET staff_id = $2 WHERE id = $1", [id, input.staffId]);
    }
    await audit(c, "pft.signatory_completed", { signature: !!sig, linked: !!input.staffId }, { table: "signatory", id });
  });
}

/** E-signature image of a signatory (signed-in users only; used on PFT forms). */
export async function signatureImage(s: Session, id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!UUID_RE.test(id)) return null;
  return as(s, async (c) => {
    const r = await c.query<{ signature_image: Buffer | null; signature_mime: string | null }>(
      "SELECT signature_image, signature_mime FROM signatory WHERE id = $1",
      [id],
    );
    return r.rows[0]?.signature_image ? { bytes: r.rows[0].signature_image, mime: r.rows[0].signature_mime! } : null;
  });
}

/** Proposal image (Chief only, for reviewing a staged signature from the guide workbook). */
export async function proposalImage(s: Session, id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  requireChief(s);
  if (!UUID_RE.test(id)) return null;
  return as(s, async (c) => {
    const r = await c.query<{ signature_image: Buffer; signature_mime: string }>(
      "SELECT signature_image, signature_mime FROM signatory_proposal WHERE id = $1",
      [id],
    );
    return r.rows[0] ? { bytes: r.rows[0].signature_image, mime: r.rows[0].signature_mime } : null;
  });
}

export async function decideProposal(
  s: Session,
  id: string,
  input: { accept: boolean; displayName?: string; credentials?: string; staffId?: string },
): Promise<void> {
  requireChief(s);
  requireReauth(s);
  const p = await as(s, async (c) => {
    const r = await c.query<{ kind: string; display_name: string | null; signature_image: Buffer; source: string; decided_at: Date | null }>(
      "SELECT kind, display_name, signature_image, source, decided_at FROM signatory_proposal WHERE id = $1",
      [id],
    );
    return r.rows[0];
  });
  if (!p || p.decided_at) throw new ClinicalError("NOT_FOUND", "Open proposal not found.");
  let signatoryId: string | null = null;
  if (input.accept) {
    signatoryId = await addSignatory(s, {
      kind: p.kind,
      // exactly as written in the workbook; a name is typed only when the workbook had none
      displayName: p.display_name ?? input.displayName ?? "",
      credentials: input.credentials ?? "",
      staffId: input.staffId ?? "",
      signature: p.signature_image,
      source: `PFT guide workbook · ${p.source}`,
    });
  }
  await as(s, async (c) => {
    await c.query("UPDATE signatory_proposal SET decided_at = now(), decision = $2, signatory_id = $3 WHERE id = $1", [
      id,
      input.accept ? "ACCEPTED" : "DISMISSED",
      signatoryId,
    ]);
  });
}

export async function deactivateSignatory(s: Session, id: string): Promise<void> {
  requireChief(s);
  requireReauth(s);
  await as(
    s,
    async (c) => {
      const r = await c.query("UPDATE signatory SET active = false, deactivated_at = now(), deactivated_by = $2 WHERE id = $1 AND active", [id, s.staffId]);
      if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "Active signatory not found.");
      await audit(c, "pft.signatory_deactivated", undefined, { table: "signatory", id });
    },
    true,
  );
}

// ================================================================= forms

export const PFT_FIELDS = [
  "testDate",
  "patientName",
  "sex",
  "ageText",
  "birthdate",
  "hospitalNumber",
  "weightKg",
  "heightCm",
  "roomOrOpd",
  "requestingPhysician",
  "hmo",
  "testType",
  "technicianComments",
  "spirometryHistory",
  "purposeOfTest",
  "smokingHistory",
  "medication",
  "observation",
] as const;
export type PftField = (typeof PFT_FIELDS)[number];
export type PftDraft = Record<PftField, string>;

export const AMENDMENT_SECTIONS = [
  "PATIENT_INFORMATION",
  "TECHNICIAN_COMMENTS",
  "SPIROMETRY_HISTORY",
  "PURPOSE_OF_TEST",
  "SMOKING_HISTORY",
  "MEDICATION",
  "OBSERVATION",
  "INTERPRETATION",
  "SIGNATURES",
  "OTHER",
] as const;

export interface PftFormView {
  id: string;
  appointmentId: string;
  patientId: string;
  status: "DRAFT" | "RT_SIGNED" | "FINAL";
  draft: PftDraft;
  interpretation: string | null;
  template: PftTemplate;
  createdBy: string;
  createdById: string;
  createdIso: string;
  updatedIso: string;
  rtSignature: { signatoryId: string; hasImage: boolean; name: string; credentials: string | null; signedIso: string; signedBy: string } | null;
  pulmoSignoff: {
    signatoryId: string;
    hasImage: boolean;
    name: string;
    credentials: string | null;
    recordedIso: string;
    recordedBy: string;
    method: string;
  } | null;
  amendments: Array<{ id: string; section: string; text: string; reason: string; createdIso: string; createdBy: string }>;
  appointment: { scheduledIso: string; status: string; procedureLabel: string };
  mySignatory: { id: string; name: string; credentials: string | null } | null;
  pulmonologists: Array<{ id: string; name: string; credentials: string | null; hasSignature: boolean }>;
  canEdit: boolean;
  canSign: boolean;
  canFinalize: boolean;
  canAmend: boolean;
}

function ageOn(birth: string | null, on: IsoDate): string {
  if (!birth) return "";
  const b = parseIsoDate(birth);
  const d = parseIsoDate(on);
  let age = d.year - b.year;
  if (d.month < b.month || (d.month === b.month && d.day < b.day)) age--;
  return age >= 0 && age <= 130 ? String(age) : "";
}

export async function createPftForm(s: Session, input: { clientId: string; appointmentId: string }): Promise<{ id: string; duplicate: boolean }> {
  requireRt(s);
  if (!UUID_RE.test(input.clientId)) throw new ClinicalError("INVALID", "Missing or invalid client id.");
  return as(s, async (c) => {
    const ex = await c.query<{ created_by: string; appointment_id: string }>("SELECT created_by, appointment_id FROM pft_form WHERE id = $1", [input.clientId]);
    if (ex.rowCount) {
      if (ex.rows[0].created_by !== s.staffId || ex.rows[0].appointment_id !== input.appointmentId)
        throw new ClinicalError("CONFLICT", "This entry id is already in use.");
      return { id: input.clientId, duplicate: true };
    }
    const live = await c.query<{ id: string }>("SELECT id FROM pft_form WHERE appointment_id = $1 AND voided_at IS NULL", [input.appointmentId]);
    if (live.rows[0]) throw new ClinicalError("CONFLICT", "This appointment already has a PFT form.", { id: live.rows[0].id });
    const a = await c.query<{
      patient_id: string;
      service: string;
      scheduled_at: Date;
      status: string;
      procedure_label: string;
      requesting_physician: string | null;
      category: string;
      voided_at: Date | null;
      full_name: string;
      sex: string | null;
      date_of_birth: string | null;
      hospital_patient_id: string | null;
      ward_room: string | null;
      weight_kg: string | null;
      height_cm: string | null;
      attending_physician: string | null;
    }>(
      `SELECT d.patient_id, d.service, d.scheduled_at, d.status, d.procedure_label, d.requesting_physician, d.category, d.voided_at,
              p.full_name, p.sex, p.date_of_birth, p.hospital_patient_id, p.ward_room, p.weight_kg::text, p.height_cm::text, p.attending_physician
         FROM diagnostic_appointment d JOIN patient p ON p.id = d.patient_id WHERE d.id = $1`,
      [input.appointmentId],
    );
    const row = a.rows[0];
    if (!row || row.voided_at) throw new ClinicalError("NOT_FOUND", "Appointment not found.");
    if (row.service !== "PFT") throw new ClinicalError("INVALID", "PFT forms belong to PFT appointments.");
    if (["CANCELLED", "NO_SHOW", "RESCHEDULED"].includes(row.status))
      throw new ClinicalError("CONFLICT", "This appointment did not take place; no PFT form can be made for it.");
    if (new Date(row.scheduled_at).getTime() > getNow().getTime() + 12 * 3_600_000)
      throw new ClinicalError("INVALID", "A PFT form is started on the day of the test.");
    const template = await currentTemplate(c);
    const testDate = calendarDateOf(new Date(row.scheduled_at));
    // Administrative fields are pre-filled from the record (and remain editable until signing).
    // Narrative / clinical sections always start empty.
    await c.query(
      `INSERT INTO pft_form (id, appointment_id, patient_id, template_id, test_date, patient_name, sex, age_text, birthdate, hospital_number,
                             room_or_opd, requesting_physician, test_type, created_by, device_id, weight_kg, height_cm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        input.clientId,
        input.appointmentId,
        row.patient_id,
        template.id,
        testDate,
        row.full_name,
        row.sex,
        ageOn(row.date_of_birth, testDate) || null,
        row.date_of_birth,
        row.hospital_patient_id,
        row.category === "OPD" ? "OUTPATIENT" : (row.ward_room ?? null),
        row.requesting_physician ?? row.attending_physician,
        row.procedure_label,
        s.staffId,
        s.deviceId,
        // Weight and height from the Patient Master profile (editable on the form until signing).
        row.weight_kg,
        row.height_cm,
      ],
    );
    await audit(c, "pft.form_created", { template_version: template.version }, { table: "pft_form", id: input.clientId });
    return { id: input.clientId, duplicate: false };
  });
}

export async function getPftForm(s: Session, id: string): Promise<PftFormView | null> {
  if (!UUID_RE.test(id)) return null;
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const r = await c.query(
      `SELECT f.*, cb.display_name AS created_by_name,
              rs.display_name AS rt_name, rs.credentials AS rt_cred, (rs.signature_image IS NOT NULL) AS rt_has_img, rsb.display_name AS rt_signed_by_name,
              ps.display_name AS pulmo_name, ps.credentials AS pulmo_cred, (ps.signature_image IS NOT NULL) AS pulmo_has_img, fb.display_name AS finalized_by_name,
              d.scheduled_at, d.status AS appt_status, d.procedure_label
         FROM pft_form f
         JOIN staff cb ON cb.id = f.created_by
         JOIN diagnostic_appointment d ON d.id = f.appointment_id
         LEFT JOIN signatory rs ON rs.id = f.rt_signatory_id LEFT JOIN staff rsb ON rsb.id = f.rt_signed_by
         LEFT JOIN signatory ps ON ps.id = f.pulmo_signatory_id LEFT JOIN staff fb ON fb.id = f.finalized_by
        WHERE f.id = $1`,
      [id],
    );
    const f = r.rows[0];
    if (!f || f.voided_at) return null;
    const t = await c.query(`SELECT ${TEMPLATE_COLS} FROM pft_template WHERE id = $1`, [f.template_id]);
    const am = await c.query<{ id: string; section: string; text: string; reason: string; created_at: Date; by: string }>(
      "SELECT a.id, a.section, a.text, a.reason, a.created_at, s.display_name AS by FROM pft_form_amendment a JOIN staff s ON s.id = a.created_by WHERE a.form_id = $1 ORDER BY a.created_at",
      [id],
    );
    const mine = await c.query<{ id: string; display_name: string; credentials: string | null }>(
      "SELECT id, display_name, credentials FROM signatory WHERE staff_id = $1 AND active AND kind = 'RESPIRATORY_THERAPIST'",
      [s.staffId],
    );
    const pulmo = await c.query<{ id: string; display_name: string; credentials: string | null; has_sig: boolean }>(
      "SELECT id, display_name, credentials, signature_image IS NOT NULL AS has_sig FROM signatory WHERE kind = 'PULMONOLOGIST' AND active ORDER BY display_name",
    );
    await audit(c, "pft.form_viewed", undefined, { table: "pft_form", id });
    const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    const dateStr = (v: unknown) => (v ? String(v).slice(0, 10) : "");
    const isRt = s.role === "RESPIRATORY_THERAPIST";
    return {
      id: f.id,
      appointmentId: f.appointment_id,
      patientId: f.patient_id,
      status: f.status,
      draft: {
        testDate: dateStr(f.test_date),
        patientName: str(f.patient_name),
        sex: str(f.sex),
        ageText: str(f.age_text),
        birthdate: dateStr(f.birthdate),
        hospitalNumber: str(f.hospital_number),
        weightKg: str(f.weight_kg),
        heightCm: str(f.height_cm),
        roomOrOpd: str(f.room_or_opd),
        requestingPhysician: str(f.requesting_physician),
        hmo: str(f.hmo),
        testType: str(f.test_type),
        technicianComments: str(f.technician_comments),
        spirometryHistory: str(f.spirometry_history),
        purposeOfTest: str(f.purpose_of_test),
        smokingHistory: str(f.smoking_history),
        medication: str(f.medication),
        observation: str(f.observation),
      },
      interpretation: f.interpretation,
      template: toTemplate(t.rows[0]),
      createdBy: f.created_by_name,
      createdById: f.created_by,
      createdIso: new Date(f.created_at).toISOString(),
      updatedIso: new Date(f.updated_at).toISOString(),
      rtSignature: f.rt_signed_at
        ? {
            signatoryId: f.rt_signatory_id,
            hasImage: !!f.rt_has_img,
            name: f.rt_name,
            credentials: f.rt_cred,
            signedIso: new Date(f.rt_signed_at).toISOString(),
            signedBy: f.rt_signed_by_name,
          }
        : null,
      pulmoSignoff: f.finalized_at
        ? {
            signatoryId: f.pulmo_signatory_id,
            hasImage: !!f.pulmo_has_img,
            name: f.pulmo_name,
            credentials: f.pulmo_cred,
            recordedIso: new Date(f.finalized_at).toISOString(),
            recordedBy: f.finalized_by_name,
            method: f.pulmo_signoff_method,
          }
        : null,
      amendments: am.rows.map((a) => ({
        id: a.id,
        section: a.section,
        text: a.text,
        reason: a.reason,
        createdIso: new Date(a.created_at).toISOString(),
        createdBy: a.by,
      })),
      appointment: { scheduledIso: new Date(f.scheduled_at).toISOString(), status: f.appt_status, procedureLabel: f.procedure_label },
      mySignatory: mine.rows[0] ? { id: mine.rows[0].id, name: mine.rows[0].display_name, credentials: mine.rows[0].credentials } : null,
      pulmonologists: pulmo.rows.map((p) => ({ id: p.id, name: p.display_name, credentials: p.credentials, hasSignature: p.has_sig })),
      canEdit: isRt && f.status === "DRAFT" && f.created_by === s.staffId,
      canSign: isRt && f.status === "DRAFT" && f.created_by === s.staffId && !!mine.rows[0],
      canFinalize: isRt && f.status === "RT_SIGNED",
      canAmend: isRt && f.status === "FINAL",
    };
  });
}

function validateDraft(d: Partial<PftDraft>) {
  const date = (v: string | undefined, label: string, required = false) => {
    const t = (v ?? "").trim();
    if (!t) {
      if (required) throw new ClinicalError("INVALID", `${label} is required.`);
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ClinicalError("INVALID", `${label}: use YYYY-MM-DD.`);
    try {
      parseIsoDate(t);
    } catch {
      throw new ClinicalError("INVALID", `${label}: not a real date.`);
    }
    return t;
  };
  const num = (v: string | undefined, label: string, max: number) => {
    const t = (v ?? "").trim();
    if (!t) return null;
    const n = Number(t);
    if (!/^\d{1,3}(\.\d)?$/.test(t) || !(n > 0) || n >= max) throw new ClinicalError("INVALID", `${label}: enter a number (one decimal place at most).`);
    return n;
  };
  const sex = (d.sex ?? "").trim();
  if (sex && sex !== "M" && sex !== "F") throw new ClinicalError("INVALID", "Sex: Male or Female (or leave blank if not recorded).");
  const testDate = date(d.testDate, "Date", true)!;
  if (testDate > calendarDateOf(getNow())) throw new ClinicalError("INVALID", "Test date cannot be in the future.");
  const name = text(d.patientName, 160, "Patient name");
  if (!name) throw new ClinicalError("INVALID", "Patient name is required.");
  return [
    testDate,
    name,
    sex || null,
    text(d.ageText, 20, "Age"),
    date(d.birthdate, "Birthdate"),
    text(d.hospitalNumber, 40, "Hospital number"),
    num(d.weightKg, "Weight (kg)", 500),
    num(d.heightCm, "Height (cm)", 260),
    text(d.roomOrOpd, 60, "Room / outpatient"),
    text(d.requestingPhysician, 120, "Requesting physician"),
    text(d.hmo, 80, "HMO"),
    text(d.testType, 160, "Test type"),
    text(d.technicianComments, 2000, "Technician's comments"),
    text(d.spirometryHistory, 1000, "Spirometry history"),
    text(d.purposeOfTest, 1000, "Purpose of test"),
    text(d.smokingHistory, 1000, "Smoking history"),
    text(d.medication, 1000, "Medication"),
    text(d.observation, 2000, "Patient observation"),
  ];
}

/** Saves a draft. Optimistic concurrency: a save never overwrites a newer save from another tab/device. */
export async function savePftDraft(s: Session, id: string, expectedUpdatedIso: string, d: Partial<PftDraft>): Promise<{ updatedIso: string }> {
  requireRt(s);
  const vals = validateDraft(d);
  return as(s, async (c) => {
    const peek = await c.query<{ created_by: string }>("SELECT created_by FROM pft_form WHERE id = $1 AND voided_at IS NULL", [id]);
    if (!peek.rows[0]) throw new ClinicalError("NOT_FOUND", "Form not found.");
    if (peek.rows[0].created_by !== s.staffId) throw new ClinicalError("FORBIDDEN", "Only the RT who started this form can edit the draft.");
    const r = await c.query<{ status: string; created_by: string; updated_at: Date; voided_at: Date | null }>(
      "SELECT status, created_by, updated_at, voided_at FROM pft_form WHERE id = $1 FOR UPDATE",
      [id],
    );
    const f = r.rows[0];
    if (!f || f.voided_at) throw new ClinicalError("NOT_FOUND", "Form not found.");
    if (f.status !== "DRAFT")
      throw new ClinicalError("CONFLICT", "This form is signed; its content can no longer be edited. Add an amendment once it is final.");
    if (new Date(f.updated_at).toISOString() !== new Date(expectedUpdatedIso).toISOString())
      throw new ClinicalError("CONFLICT", "This draft was saved elsewhere after you opened it. Reload to see the latest version, then re-apply your changes.");
    const u = await c.query<{ updated_at: Date }>(
      `UPDATE pft_form SET test_date = $2, patient_name = $3, sex = $4, age_text = $5, birthdate = $6, hospital_number = $7, weight_kg = $8, height_cm = $9,
              room_or_opd = $10, requesting_physician = $11, hmo = $12, test_type = $13, technician_comments = $14, spirometry_history = $15,
              purpose_of_test = $16, smoking_history = $17, medication = $18, observation = $19
        WHERE id = $1 RETURNING updated_at`,
      [id, ...vals],
    );
    return { updatedIso: new Date(u.rows[0].updated_at).toISOString() };
  });
}

export async function signPftAsRt(s: Session, id: string, expectedUpdatedIso: string): Promise<void> {
  requireRt(s);
  requireReauth(s);
  await as(
    s,
    async (c) => {
      const r = await c.query<{ status: string; created_by: string; updated_at: Date; voided_at: Date | null; test_type: string | null; patient_name: string }>(
        "SELECT status, created_by, updated_at, voided_at, test_type, patient_name FROM pft_form WHERE id = $1 FOR UPDATE",
        [id],
      );
      const f = r.rows[0];
      if (!f || f.voided_at) throw new ClinicalError("NOT_FOUND", "Form not found.");
      if (f.created_by !== s.staffId) throw new ClinicalError("FORBIDDEN", "Only the RT who performed the test signs the form.");
      if (f.status !== "DRAFT") throw new ClinicalError("CONFLICT", "This form is already signed.");
      if (new Date(f.updated_at).toISOString() !== new Date(expectedUpdatedIso).toISOString())
        throw new ClinicalError("CONFLICT", "The draft changed after you opened it. Reload and review it before signing.");
      if (!f.test_type) throw new ClinicalError("INVALID", "Enter the test type before signing.");
      const sig = await c.query<{ id: string }>("SELECT id FROM signatory WHERE staff_id = $1 AND active AND kind = 'RESPIRATORY_THERAPIST'", [s.staffId]);
      if (!sig.rows[0]) throw new ClinicalError("FORBIDDEN", "You are not in the approved signatory directory. Ask the Chief RT to add you.");
      await c.query("UPDATE pft_form SET status = 'RT_SIGNED', rt_signatory_id = $2, rt_signed_by = $3, rt_signed_at = now() WHERE id = $1", [
        id,
        sig.rows[0].id,
        s.staffId,
      ]);
      await audit(c, "pft.rt_signed", undefined, { table: "pft_form", id });
    },
    true,
  );
}

export type PulmoSignoffMethod = "WET_SIGNATURE_ON_PRINTED_COPY" | "E_SIGNATURE_APPLIED_BY_RT";

export async function finalizePft(
  s: Session,
  id: string,
  input: { pulmoSignatoryId: string; interpretation: string; attestWetSignature: boolean; method?: PulmoSignoffMethod },
): Promise<void> {
  requireRt(s);
  requireReauth(s);
  const method: PulmoSignoffMethod = input.method ?? "WET_SIGNATURE_ON_PRINTED_COPY";
  if (method !== "WET_SIGNATURE_ON_PRINTED_COPY" && method !== "E_SIGNATURE_APPLIED_BY_RT")
    throw new ClinicalError("INVALID", "Choose how the pulmonologist signed.");
  const interp = text(input.interpretation, 4000, "Interpretation");
  if (!interp || interp.length < 3) throw new ClinicalError("INVALID", "Type the interpretation exactly as given by the pulmonologist.");
  if (!input.attestWetSignature)
    throw new ClinicalError(
      "INVALID",
      method === "E_SIGNATURE_APPLIED_BY_RT"
        ? "Confirm that the pulmonologist gave this interpretation and authorized their e-signature on this result."
        : "Confirm that the pulmonologist signed the printed form.",
    );
  if (!UUID_RE.test(input.pulmoSignatoryId)) throw new ClinicalError("INVALID", "Choose the pulmonologist from the approved directory.");
  await as(
    s,
    async (c) => {
      const r = await c.query<{ status: string; voided_at: Date | null }>("SELECT status, voided_at FROM pft_form WHERE id = $1 FOR UPDATE", [id]);
      const f = r.rows[0];
      if (!f || f.voided_at) throw new ClinicalError("NOT_FOUND", "Form not found.");
      if (f.status !== "RT_SIGNED")
        throw new ClinicalError("CONFLICT", f.status === "FINAL" ? "This record is already final." : "The RT must sign before finalizing.");
      const p = await c.query<{ has_sig: boolean }>(
        "SELECT signature_image IS NOT NULL AS has_sig FROM signatory WHERE id = $1 AND kind = 'PULMONOLOGIST' AND active",
        [input.pulmoSignatoryId],
      );
      if (!p.rowCount) throw new ClinicalError("INVALID", "Choose an active pulmonologist from the approved directory.");
      if (method === "E_SIGNATURE_APPLIED_BY_RT" && !p.rows[0].has_sig)
        throw new ClinicalError(
          "INVALID",
          "This pulmonologist has no approved e-signature in the directory. Ask the Chief RT, or use the printed-copy method.",
        );
      await c.query(
        `UPDATE pft_form SET status = 'FINAL', pulmo_signatory_id = $2, interpretation = $3, finalized_by = $4, finalized_at = now(),
                pulmo_signoff_method = $5 WHERE id = $1`,
        [id, input.pulmoSignatoryId, interp, s.staffId, method],
      );
      await audit(c, "pft.finalized", { method }, { table: "pft_form", id });
    },
    true,
  );
}

export async function amendPft(s: Session, id: string, input: { clientId: string; section: string; text: string; reason: string }): Promise<void> {
  requireRt(s);
  requireReauth(s);
  if (!UUID_RE.test(input.clientId)) throw new ClinicalError("INVALID", "Missing or invalid client id.");
  if (!(AMENDMENT_SECTIONS as readonly string[]).includes(input.section)) throw new ClinicalError("INVALID", "Choose the section being amended.");
  const body = text(input.text, 2000, "Amendment");
  const why = text(input.reason, 300, "Reason");
  if (!body || body.length < 3) throw new ClinicalError("INVALID", "Write the amendment.");
  if (!why || why.length < 5) throw new ClinicalError("INVALID", "Give a reason for the amendment (at least 5 characters).");
  await as(
    s,
    async (c) => {
      const ex = await c.query<{ form_id: string; created_by: string }>("SELECT form_id, created_by FROM pft_form_amendment WHERE id = $1", [input.clientId]);
      if (ex.rowCount) {
        if (ex.rows[0].form_id === id && ex.rows[0].created_by === s.staffId) return;
        throw new ClinicalError("CONFLICT", "This entry id is already in use.");
      }
      const f = await c.query<{ status: string; voided_at: Date | null }>("SELECT status, voided_at FROM pft_form WHERE id = $1", [id]);
      if (!f.rows[0] || f.rows[0].voided_at) throw new ClinicalError("NOT_FOUND", "Form not found.");
      if (f.rows[0].status !== "FINAL") throw new ClinicalError("CONFLICT", "Amendments are added to final records only.");
      await c.query("INSERT INTO pft_form_amendment (id, form_id, section, text, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [
        input.clientId,
        id,
        input.section,
        body,
        why,
        s.staffId,
      ]);
      await audit(c, "pft.amended", { section: input.section }, { table: "pft_form", id });
    },
    true,
  );
}

export async function voidPftForm(s: Session, id: string, rawReason: string): Promise<void> {
  requireRt(s);
  const why = text(rawReason, 300, "Reason");
  if (!why || why.length < 5) throw new ClinicalError("INVALID", "Give a reason (at least 5 characters).");
  await as(s, async (c) => {
    const r = await c.query<{ status: string; created_by: string; voided_at: Date | null }>(
      "SELECT status, created_by, voided_at FROM pft_form WHERE id = $1",
      [id],
    );
    const f = r.rows[0];
    if (!f || f.voided_at) throw new ClinicalError("NOT_FOUND", "Form not found.");
    if (f.created_by !== s.staffId) throw new ClinicalError("FORBIDDEN", "Only the RT who started this form can void it.");
    if (f.status === "FINAL") throw new ClinicalError("CONFLICT", "A final record cannot be voided. Add an amendment instead.");
    await c.query("UPDATE pft_form SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [id, s.staffId, why]);
    await audit(c, "pft.form_voided", undefined, { table: "pft_form", id });
  });
}

/** Logo image of a template version (any signed-in user; not patient data). */
export async function templateLogo(s: Session, templateId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!UUID_RE.test(templateId)) return null;
  return as(s, async (c) => {
    const r = await c.query<{ logo: Buffer | null; logo_mime: string | null }>("SELECT logo, logo_mime FROM pft_template WHERE id = $1", [templateId]);
    return r.rows[0]?.logo ? { bytes: r.rows[0].logo, mime: r.rows[0].logo_mime! } : null;
  });
}

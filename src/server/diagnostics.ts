import "server-only";
import { roleHas } from "@/lib/authz/permissions";
import type { DiagnosticService, DiagnosticStatus, PatientCategory } from "@/lib/clinical/vocabulary";
import { addDays, calendarDayWindow, parseIsoDate, type IsoDate } from "@/lib/time/zoned";
import { ClinicalError } from "./clinical";
import { getNow } from "./clock";
import { audit, tx, type Tx } from "./db";
import { parseManilaWall } from "./documentation";
import type { Session } from "./session";

/**
 * Milestone 5 — PFT / ABG / sputum-induction scheduling (PRODUCT_REQUIREMENTS §8).
 *  - Booking is in the scheduler's own name, idempotent by client id.
 *  - Status follows a fixed workflow (DB function diag_status_allowed); closed statuses never change.
 *  - Rescheduling closes the original as RESCHEDULED and books a linked follow-up — both rows kept.
 *  - Mistakes are voided with a reason (by the scheduler or the Chief RT), never edited or deleted.
 */

export const DIAG_SERVICES: readonly DiagnosticService[] = ["PFT", "ABG", "SPUTUM_INDUCTION"];
export const DIAG_STATUSES: readonly DiagnosticStatus[] = ["SCHEDULED", "PENDING", "COMPLETED", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE", "RESCHEDULED"];
export const CLOSED_STATUSES: readonly DiagnosticStatus[] = ["COMPLETED", "NO_SHOW", "CANCELLED", "RESCHEDULED"];
const REASON_STATUSES: readonly DiagnosticStatus[] = ["CANCELLED", "NO_SHOW", "FOR_RESCHEDULE"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mirrors diag_status_allowed() in migration 0007 (kept in sync by tests). */
export function statusTransitionAllowed(from: DiagnosticStatus, to: DiagnosticStatus): boolean {
  if (from === to) return true;
  switch (from) {
    case "SCHEDULED":
      return ["PENDING", "COMPLETED", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE", "RESCHEDULED"].includes(to);
    case "PENDING":
      return ["SCHEDULED", "COMPLETED", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE", "RESCHEDULED"].includes(to);
    case "FOR_RESCHEDULE":
      return ["RESCHEDULED", "CANCELLED"].includes(to);
    default:
      return false;
  }
}

function as<T>(s: Session, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}

const clean = (v: string | null | undefined, max: number, label: string, required = false): string | null => {
  const t = (v ?? "").trim().replace(/\s+/g, " ");
  if (!t) {
    if (required) throw new ClinicalError("INVALID", `${label} is required.`);
    return null;
  }
  if (t.length > max) throw new ClinicalError("INVALID", `${label}: at most ${max} characters.`);
  return t;
};

function reason(raw: string | null | undefined, label = "Reason"): string {
  const r = (raw ?? "").trim().replace(/\s+/g, " ");
  if (r.length < 5) throw new ClinicalError("INVALID", `${label} is required (at least 5 characters).`);
  if (r.length > 300) throw new ClinicalError("INVALID", `${label}: at most 300 characters.`);
  return r;
}

function bookingTime(value: string, now: Date): Date {
  const t = parseManilaWall(value);
  if (!t) throw new ClinicalError("INVALID", "Enter the appointment date and time.");
  if (t.getTime() < now.getTime() - 72 * 3_600_000) throw new ClinicalError("INVALID", "Appointments can be booked at most 72 hours in the past (late entry).");
  if (t.getTime() > now.getTime() + 366 * 86_400_000) throw new ClinicalError("INVALID", "Appointments can be booked at most one year ahead.");
  return t;
}

// ================================================================= reads

export interface AppointmentFilter {
  service: DiagnosticService;
  from: IsoDate;
  to: IsoDate; // inclusive
  status?: DiagnosticStatus | "OPEN" | "";
  category?: PatientCategory | "";
  staffId?: string; // scheduler OR performer
}

export interface AppointmentRow {
  id: string;
  service: DiagnosticService;
  patient: { id: string; name: string; hospitalId: string | null; category: PatientCategory; wardRoom: string | null; sex: "M" | "F" | null };
  scheduledIso: string;
  status: DiagnosticStatus;
  rawStatus: string | null;
  procedureLabel: string;
  requestingPhysician: string | null;
  category: PatientCategory;
  paymentClass: string | null;
  scheduler: string | null;
  schedulerId: string | null;
  performedBy: string | null;
  reschedulesId: string | null;
  rescheduledToId: string | null;
  remarks: string | null;
  statusReason: string | null;
  source: string;
  pftFormId: string | null;
  pftFormStatus: string | null;
}

export function parseFilter(sp: Record<string, string | string[] | undefined>, service: DiagnosticService, today: IsoDate): AppointmentFilter {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" ? v : "";
  };
  const okDate = (v: string) => {
    try {
      parseIsoDate(v);
      return /^\d{4}-\d{2}-\d{2}$/.test(v);
    } catch {
      return false;
    }
  };
  let from = okDate(one("from")) ? one("from") : addDays(today, -7);
  let to = okDate(one("to")) ? one("to") : addDays(today, 21);
  if (to < from) [from, to] = [to, from];
  // At most ~3 months per view keeps pages fast and printable.
  if (addDays(from, 93) < to) to = addDays(from, 93);
  const st = one("status");
  const status = (DIAG_STATUSES as readonly string[]).includes(st) || st === "OPEN" ? (st as AppointmentFilter["status"]) : "";
  const cat = one("category");
  const category = ["OPD", "INP", "OTHER"].includes(cat) ? (cat as PatientCategory) : "";
  const staff = one("staff");
  return { service, from, to, status, category, staffId: UUID_RE.test(staff) ? staff : undefined };
}

const APPT_SELECT = `
  SELECT d.id, d.service, d.scheduled_at, d.status, d.raw_status, d.procedure_label, d.requesting_physician, d.category, d.payment_class,
         d.scheduler_id, sc.display_name AS scheduler, pb.display_name AS performed_by, d.reschedules_id, d.remarks, d.status_reason, d.source,
         (SELECT x.id FROM diagnostic_appointment x WHERE x.reschedules_id = d.id AND x.voided_at IS NULL LIMIT 1) AS rescheduled_to,
         f.id AS pft_id, f.status AS pft_status,
         p.id AS p_id, p.full_name AS p_name, p.hospital_patient_id AS p_hid, p.category AS p_cat, p.ward_room AS p_ward, p.sex AS p_sex
    FROM diagnostic_appointment d
    JOIN patient p ON p.id = d.patient_id
    LEFT JOIN staff sc ON sc.id = d.scheduler_id
    LEFT JOIN staff pb ON pb.id = d.performed_by
    LEFT JOIN pft_form f ON f.appointment_id = d.id AND f.voided_at IS NULL`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(r: any): AppointmentRow {
  return {
    id: r.id,
    service: r.service,
    patient: { id: r.p_id, name: r.p_name, hospitalId: r.p_hid, category: r.p_cat, wardRoom: r.p_ward, sex: r.p_sex },
    scheduledIso: new Date(r.scheduled_at).toISOString(),
    status: r.status,
    rawStatus: r.raw_status,
    procedureLabel: r.procedure_label,
    requestingPhysician: r.requesting_physician,
    category: r.category,
    paymentClass: r.payment_class,
    scheduler: r.scheduler,
    schedulerId: r.scheduler_id,
    performedBy: r.performed_by,
    reschedulesId: r.reschedules_id,
    rescheduledToId: r.rescheduled_to,
    remarks: r.remarks,
    statusReason: r.status_reason,
    source: r.source,
    pftFormId: r.pft_id,
    pftFormStatus: r.pft_status,
  };
}

export async function listAppointments(s: Session, f: AppointmentFilter): Promise<AppointmentRow[]> {
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const args: unknown[] = [f.service, calendarDayWindow(f.from).start, calendarDayWindow(f.to).end];
    let where = "d.service = $1 AND d.scheduled_at >= $2 AND d.scheduled_at < $3 AND d.voided_at IS NULL";
    if (f.status === "OPEN") where += " AND d.status IN ('SCHEDULED', 'PENDING', 'FOR_RESCHEDULE')";
    else if (f.status) {
      args.push(f.status);
      where += ` AND d.status = $${args.length}`;
    }
    if (f.category) {
      args.push(f.category);
      where += ` AND d.category = $${args.length}`;
    }
    if (f.staffId) {
      args.push(f.staffId);
      where += ` AND (d.scheduler_id = $${args.length} OR d.performed_by = $${args.length})`;
    }
    const r = await c.query(`${APPT_SELECT} WHERE ${where} ORDER BY d.scheduled_at, p.full_name LIMIT 2000`, args);
    return r.rows.map(toRow);
  });
}

export interface AppointmentDetail extends AppointmentRow {
  rawAgeSex: string | null;
  /** Shown on the appointment page only; viewing it is audited. */
  contactNote: string | null;
  receivedIso: string;
  importRef: { batchId: string; sheet: string; row: number; fileName: string } | null;
  lineage: Array<{ id: string; scheduledIso: string; status: DiagnosticStatus; current: boolean }>;
  history: Array<{
    atIso: string;
    actor: string | null;
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    changed: string[];
  }>;
  updatedIso: string | null;
  canCorrect: boolean;
  canVoid: boolean;
}

export async function getAppointment(s: Session, id: string): Promise<AppointmentDetail | null> {
  if (!UUID_RE.test(id)) return null;
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const r = await c.query(
      `${APPT_SELECT.replace("SELECT d.id,", "SELECT d.raw_age_sex, d.contact_note, d.received_at_server, d.import_row_id, d.voided_at, d.updated_at, d.id,")} WHERE d.id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row || row.voided_at) return null;
    // Walk the reschedule chain both ways (bounded).
    const lineage = await c.query<{ id: string; scheduled_at: Date; status: DiagnosticStatus }>(
      `WITH RECURSIVE up AS (
         SELECT id, reschedules_id, scheduled_at, status, 0 AS depth FROM diagnostic_appointment WHERE id = $1
         UNION ALL SELECT d.id, d.reschedules_id, d.scheduled_at, d.status, up.depth + 1 FROM diagnostic_appointment d JOIN up ON d.id = up.reschedules_id WHERE up.depth < 20
       ), down AS (
         SELECT id, scheduled_at, status, 0 AS depth FROM diagnostic_appointment WHERE id = $1
         UNION ALL SELECT d.id, d.scheduled_at, d.status, down.depth + 1 FROM diagnostic_appointment d JOIN down ON d.reschedules_id = down.id WHERE d.voided_at IS NULL AND down.depth < 20
       )
       SELECT DISTINCT id, scheduled_at, status FROM (SELECT id, scheduled_at, status FROM up UNION SELECT id, scheduled_at, status FROM down) x ORDER BY scheduled_at`,
      [id],
    );
    const hist = await c.query<{
      at: Date;
      actor: string | null;
      action: string;
      from_status: string | null;
      to_status: string | null;
      reason: string | null;
      changed: string[];
    }>("SELECT * FROM diag_history($1)", [id]);
    if (row.contact_note) await audit(c, "diagnostic.contact_viewed", undefined, { table: "diagnostic_appointment", id });
    let importRef: AppointmentDetail["importRef"] = null;
    if (row.import_row_id && s.role === "CHIEF_RT_ADMIN") {
      const ir = await c.query<{ batch_id: string; sheet_name: string; row_number: number; file_name: string }>(
        "SELECT r.batch_id, r.sheet_name, r.row_number, b.file_name FROM import_row r JOIN import_batch b ON b.id = r.batch_id WHERE r.id = $1",
        [row.import_row_id],
      );
      if (ir.rows[0]) importRef = { batchId: ir.rows[0].batch_id, sheet: ir.rows[0].sheet_name, row: ir.rows[0].row_number, fileName: ir.rows[0].file_name };
    }
    const base = toRow(row);
    return {
      ...base,
      rawAgeSex: row.raw_age_sex,
      contactNote: row.contact_note,
      receivedIso: new Date(row.received_at_server).toISOString(),
      importRef,
      lineage: lineage.rows.map((l) => ({ id: l.id, scheduledIso: new Date(l.scheduled_at).toISOString(), status: l.status, current: l.id === id })),
      history: hist.rows.map((h) => ({
        atIso: new Date(h.at).toISOString(),
        actor: h.actor,
        action: h.action,
        fromStatus: h.from_status,
        toStatus: h.to_status,
        reason: h.reason,
        changed: h.changed ?? [],
      })),
      updatedIso: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      canCorrect:
        roleHas(s.role, "diagnostics:schedule") &&
        ["SCHEDULED", "PENDING", "FOR_RESCHEDULE"].includes(base.status) &&
        (!base.pftFormId || base.pftFormStatus === "DRAFT"),
      canVoid: (base.schedulerId === s.staffId || s.role === "CHIEF_RT_ADMIN") && !base.pftFormId && !base.rescheduledToId,
    };
  });
}

/** Patient appointment sheet (printable): every live appointment for one patient, past 90 days onward. */
export async function patientSchedule(s: Session, patientId: string) {
  if (!UUID_RE.test(patientId)) return null;
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const p = await c.query<{
      id: string;
      full_name: string;
      hospital_patient_id: string | null;
      category: PatientCategory;
      sex: string | null;
      date_of_birth: string | null;
    }>("SELECT id, full_name, hospital_patient_id, category, sex, date_of_birth FROM patient WHERE id = $1 AND voided_at IS NULL", [patientId]);
    if (!p.rows[0]) return null;
    const r = await c.query(`${APPT_SELECT} WHERE d.patient_id = $1 AND d.voided_at IS NULL AND d.scheduled_at >= $2 ORDER BY d.scheduled_at`, [
      patientId,
      new Date(getNow().getTime() - 90 * 86_400_000),
    ]);
    await audit(c, "patient.schedule_printed", undefined, { table: "patient", id: patientId });
    return { patient: p.rows[0], appointments: r.rows.map(toRow) };
  });
}

// ================================================================= writes

export interface BookingInput {
  clientId: string;
  patientId: string;
  service: DiagnosticService;
  scheduledAt: string; // Manila wall "YYYY-MM-DDTHH:MM"
  procedureLabel: string;
  category: PatientCategory;
  requestingPhysician: string;
  paymentClass: string;
  /** Contact info as given (kept as written; not validated as a phone number). Optional. */
  contactNote?: string;
  remarks: string;
  recordedAtDevice?: string | null;
}

export async function bookAppointment(s: Session, input: BookingInput): Promise<{ id: string; duplicate: boolean }> {
  if (!roleHas(s.role, "diagnostics:schedule")) throw new ClinicalError("FORBIDDEN", "You cannot book diagnostics.");
  if (!UUID_RE.test(input.clientId)) throw new ClinicalError("INVALID", "Missing or invalid client id.");
  if (!DIAG_SERVICES.includes(input.service)) throw new ClinicalError("INVALID", "Choose a service.");
  if (!["OPD", "INP", "OTHER"].includes(input.category)) throw new ClinicalError("INVALID", "Choose OPD, INP or Other.");
  const now = getNow();
  const at = bookingTime(input.scheduledAt, now);
  const procedure = clean(input.procedureLabel, 160, "Procedure / test", true)!;
  const physician = clean(input.requestingPhysician, 120, "Requesting physician");
  // U-08 / U-09 approved by the privacy officer (2026-11-23): optional payment class and contact note.
  const payment = clean(input.paymentClass, 60, "Payment");
  const contact = clean(input.contactNote, 300, "Contact");
  const remarks = clean(input.remarks, 1000, "Remarks");
  const device = input.recordedAtDevice ? new Date(input.recordedAtDevice) : null;
  return as(s, async (c) => {
    const ex = await c.query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM diagnostic_appointment WHERE id = $1", [input.clientId]);
    if (ex.rowCount) {
      if (ex.rows[0].scheduler_id !== s.staffId) throw new ClinicalError("CONFLICT", "This entry id is already in use.");
      return { id: input.clientId, duplicate: true };
    }
    const p = await c.query("SELECT 1 FROM patient WHERE id = $1 AND voided_at IS NULL", [input.patientId]);
    if (!p.rowCount) throw new ClinicalError("NOT_FOUND", "Patient not found.");
    await c.query(
      `INSERT INTO diagnostic_appointment (id, patient_id, service, scheduled_at, status, procedure_label, requesting_physician, category, payment_class,
                                           scheduler_id, remarks, recorded_at_device, source, device_id, contact_note)
       VALUES ($1, $2, $3, $4, 'SCHEDULED', $5, $6, $7, $8, $9, $10, $11, 'ONLINE', $12, $13)`,
      [
        input.clientId,
        input.patientId,
        input.service,
        at,
        procedure,
        physician,
        input.category,
        payment,
        s.staffId,
        remarks,
        device && !Number.isNaN(device.getTime()) ? device : null,
        s.deviceId,
        contact,
      ],
    );
    await audit(c, "diagnostic.booked", { service: input.service }, { table: "diagnostic_appointment", id: input.clientId });
    return { id: input.clientId, duplicate: false };
  });
}

export async function updateAppointmentStatus(
  s: Session,
  id: string,
  input: { status: DiagnosticStatus; reason?: string; remarks?: string; /** COMPLETED only: the RT who performed it (default: you). */ performedBy?: string },
): Promise<void> {
  if (!roleHas(s.role, "diagnostics:schedule")) throw new ClinicalError("FORBIDDEN", "You cannot update diagnostics.");
  if (!DIAG_STATUSES.includes(input.status) || input.status === "RESCHEDULED")
    throw new ClinicalError("INVALID", "Choose a status (use Reschedule to move an appointment).");
  const why = REASON_STATUSES.includes(input.status) ? reason(input.reason) : clean(input.reason, 300, "Reason");
  const remarks = input.remarks === undefined ? undefined : clean(input.remarks, 1000, "Remarks");
  if (input.performedBy !== undefined && (input.status !== "COMPLETED" || !UUID_RE.test(input.performedBy)))
    throw new ClinicalError("INVALID", "Performed by can only be chosen when marking the appointment done.");
  const now = getNow();
  await as(s, async (c) => {
    let performer = s.staffId;
    if (input.performedBy && input.performedBy !== s.staffId) {
      const p = await c.query("SELECT 1 FROM staff WHERE id = $1 AND status = 'ACTIVE'", [input.performedBy]);
      if (!p.rowCount) throw new ClinicalError("INVALID", "Choose an active RT as the performer.");
      performer = input.performedBy;
    }
    const r = await c.query<{ status: DiagnosticStatus; scheduled_at: Date; voided_at: Date | null; remarks: string | null }>(
      "SELECT status, scheduled_at, voided_at, remarks FROM diagnostic_appointment WHERE id = $1 FOR UPDATE",
      [id],
    );
    const a = r.rows[0];
    if (!a || a.voided_at) throw new ClinicalError("NOT_FOUND", "Appointment not found.");
    if (a.status === input.status) throw new ClinicalError("CONFLICT", "The appointment already has this status.");
    if (!statusTransitionAllowed(a.status, input.status))
      throw new ClinicalError(
        "CONFLICT",
        `A ${a.status.toLowerCase().replace("_", " ")} appointment cannot become ${input.status.toLowerCase().replace("_", " ")}.`,
      );
    if ((input.status === "COMPLETED" || input.status === "NO_SHOW") && new Date(a.scheduled_at).getTime() > now.getTime() + 60 * 60_000) {
      throw new ClinicalError("INVALID", "A future appointment cannot be marked done or no-show.");
    }
    await c.query(
      `UPDATE diagnostic_appointment SET status = $2, status_reason = $3, performed_by = CASE WHEN $2 = 'COMPLETED' THEN $6::uuid ELSE performed_by END,
              remarks = coalesce($5, remarks), updated_by = $4 WHERE id = $1`,
      [id, input.status, why, s.staffId, remarks === undefined ? null : remarks, performer],
    );
    await audit(
      c,
      "diagnostic.status_changed",
      { from: a.status, to: input.status, ...(input.status === "COMPLETED" ? { performed_by: performer } : {}) },
      { table: "diagnostic_appointment", id },
    );
  });
}

export async function rescheduleAppointment(s: Session, id: string, input: { clientId: string; scheduledAt: string; reason: string }): Promise<{ id: string }> {
  if (!roleHas(s.role, "diagnostics:schedule")) throw new ClinicalError("FORBIDDEN", "You cannot reschedule diagnostics.");
  if (!UUID_RE.test(input.clientId)) throw new ClinicalError("INVALID", "Missing or invalid client id.");
  const why = reason(input.reason, "Reason for rescheduling");
  const at = bookingTime(input.scheduledAt, getNow());
  return as(s, async (c) => {
    const dup = await c.query<{ reschedules_id: string | null; scheduler_id: string | null }>(
      "SELECT reschedules_id, scheduler_id FROM diagnostic_appointment WHERE id = $1",
      [input.clientId],
    );
    if (dup.rowCount) {
      if (dup.rows[0].reschedules_id === id && dup.rows[0].scheduler_id === s.staffId) return { id: input.clientId };
      throw new ClinicalError("CONFLICT", "This entry id is already in use.");
    }
    const r = await c.query<{
      status: DiagnosticStatus;
      voided_at: Date | null;
      patient_id: string;
      service: string;
      procedure_label: string;
      requesting_physician: string | null;
      category: string;
      payment_class: string | null;
      scheduled_at: Date;
    }>("SELECT * FROM diagnostic_appointment WHERE id = $1 FOR UPDATE", [id]);
    const a = r.rows[0];
    if (!a || a.voided_at) throw new ClinicalError("NOT_FOUND", "Appointment not found.");
    if (!statusTransitionAllowed(a.status, "RESCHEDULED") || a.status === "RESCHEDULED")
      throw new ClinicalError("CONFLICT", "Only open appointments can be rescheduled.");
    if (at.getTime() === new Date(a.scheduled_at).getTime()) throw new ClinicalError("INVALID", "Choose a different date or time.");
    await c.query("UPDATE diagnostic_appointment SET status = 'RESCHEDULED', status_reason = $2, updated_by = $3 WHERE id = $1", [id, why, s.staffId]);
    await c.query(
      `INSERT INTO diagnostic_appointment (id, patient_id, service, scheduled_at, status, procedure_label, requesting_physician, category, payment_class,
                                           scheduler_id, reschedules_id, remarks, source, device_id)
       VALUES ($1, $2, $3, $4, 'SCHEDULED', $5, $6, $7, $8, $9, $10, $11, 'ONLINE', $12)`,
      [
        input.clientId,
        a.patient_id,
        a.service,
        at,
        a.procedure_label,
        a.requesting_physician,
        a.category,
        a.payment_class,
        s.staffId,
        id,
        `Rescheduled: ${why}`.slice(0, 1000),
        s.deviceId,
      ],
    );
    await audit(c, "diagnostic.rescheduled", { from_id: id }, { table: "diagnostic_appointment", id: input.clientId });
    return { id: input.clientId };
  });
}

export interface CorrectionInput {
  expectedUpdatedIso: string | null;
  scheduledAt: string; // Manila wall
  procedureLabel: string;
  requestingPhysician: string;
  category: PatientCategory;
  remarks: string;
  reason: string;
}

/**
 * Corrects the details of an OPEN appointment (time, procedure, physician, OPD/INP, remarks).
 * A reason is required; previous values stay in the audit trail and the appointment history.
 * Patient and service cannot change (void and book again). Closed appointments cannot be edited.
 */
export async function correctAppointment(s: Session, id: string, input: CorrectionInput): Promise<void> {
  if (!roleHas(s.role, "diagnostics:schedule")) throw new ClinicalError("FORBIDDEN", "You cannot edit appointments.");
  const why = reason(input.reason, "Reason for the correction");
  if (!["OPD", "INP", "OTHER"].includes(input.category)) throw new ClinicalError("INVALID", "Choose OPD, INP or Other.");
  const procedure = clean(input.procedureLabel, 160, "Procedure / test", true)!;
  const physician = clean(input.requestingPhysician, 120, "Requesting physician");
  const remarks = clean(input.remarks, 1000, "Remarks");
  await tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, async (c) => {
    const r = await c.query<{
      status: DiagnosticStatus;
      voided_at: Date | null;
      updated_at: Date | null;
      scheduled_at: Date;
      procedure_label: string;
      requesting_physician: string | null;
      category: string;
      remarks: string | null;
    }>(
      "SELECT status, voided_at, updated_at, scheduled_at, procedure_label, requesting_physician, category, remarks FROM diagnostic_appointment WHERE id = $1 FOR UPDATE",
      [id],
    );
    const a = r.rows[0];
    if (!a || a.voided_at) throw new ClinicalError("NOT_FOUND", "Appointment not found.");
    if (!["SCHEDULED", "PENDING", "FOR_RESCHEDULE"].includes(a.status))
      throw new ClinicalError("CONFLICT", "Only open appointments can be edited. Void an entry made in error.");
    const cur = a.updated_at ? new Date(a.updated_at).toISOString() : null;
    if (cur !== input.expectedUpdatedIso)
      throw new ClinicalError("CONFLICT", "This appointment was changed after you opened it. Reload and re-apply your edit.");
    const t = new Date(a.scheduled_at);
    const at = input.scheduledAt.trim() ? bookingTime(input.scheduledAt, getNow()) : t;
    const same =
      at.getTime() === t.getTime() &&
      procedure === a.procedure_label &&
      physician === a.requesting_physician &&
      input.category === a.category &&
      remarks === a.remarks;
    if (same) throw new ClinicalError("INVALID", "Nothing was changed.");
    await c.query("SELECT set_config('app.change_reason', $1, true)", [why]);
    await c.query(
      "UPDATE diagnostic_appointment SET scheduled_at = $2, procedure_label = $3, requesting_physician = $4, category = $5, remarks = $6, updated_by = $7 WHERE id = $1",
      [id, at, procedure, physician, input.category, remarks, s.staffId],
    );
    await audit(c, "diagnostic.corrected", { reason: why }, { table: "diagnostic_appointment", id });
  });
}

export async function voidAppointment(s: Session, id: string, rawReason: string): Promise<void> {
  if (!roleHas(s.role, "diagnostics:schedule")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  const why = reason(rawReason, "Reason for voiding");
  await as(s, async (c) => {
    const r = await c.query<{ scheduler_id: string | null; voided_at: Date | null; source: string }>(
      "SELECT scheduler_id, voided_at, source FROM diagnostic_appointment WHERE id = $1 FOR UPDATE",
      [id],
    );
    const a = r.rows[0];
    if (!a || a.voided_at) throw new ClinicalError("NOT_FOUND", "Appointment not found.");
    if (a.scheduler_id !== s.staffId && s.role !== "CHIEF_RT_ADMIN")
      throw new ClinicalError("FORBIDDEN", "Only the RT who booked it or the Chief RT can void an appointment.");
    const form = await c.query("SELECT 1 FROM pft_form WHERE appointment_id = $1 AND voided_at IS NULL", [id]);
    if (form.rowCount) throw new ClinicalError("CONFLICT", "This appointment has a PFT form. Void the draft form first; a signed record cannot be removed.");
    const child = await c.query("SELECT 1 FROM diagnostic_appointment WHERE reschedules_id = $1 AND voided_at IS NULL", [id]);
    if (child.rowCount) throw new ClinicalError("CONFLICT", "This appointment was rescheduled. Void the follow-up appointment first.");
    await c.query("UPDATE diagnostic_appointment SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2 WHERE id = $1", [id, s.staffId, why]);
    await audit(c, "diagnostic.voided", undefined, { table: "diagnostic_appointment", id });
  });
}

/** Active staff (RTs and the Chief RT) for the "Performed by" dropdown. */
export async function listActiveStaff(s: Session): Promise<Array<{ id: string; name: string }>> {
  return as(s, async (c) => {
    const r = await c.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM staff WHERE status = 'ACTIVE' ORDER BY role = 'CHIEF_RT_ADMIN', display_name",
    );
    return r.rows.map((x) => ({ id: x.id, name: x.display_name }));
  });
}

/** RT accounts for the "RT" filter (names only). */
export async function listRtNames(s: Session): Promise<Array<{ id: string; name: string }>> {
  return as(s, async (c) => {
    const r = await c.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM staff WHERE role = 'RESPIRATORY_THERAPIST' ORDER BY display_name",
    );
    return r.rows.map((x) => ({ id: x.id, name: x.display_name }));
  });
}

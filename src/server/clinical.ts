import "server-only";
import { roleHas } from "@/lib/authz/permissions";
import { assessFromDue, DEFAULT_TUBING_POLICY } from "@/lib/clinical/tubing";
import type { PatientCategory } from "@/lib/clinical/vocabulary";
import { handoverableShifts, isHandoverable, receivingShift, type ShiftRef } from "@/lib/time/handover";
import { classifyInstant, shiftWindow, SHIFT_ORDER, type ShiftCode } from "@/lib/time/shifts";
import { addDays, formatTime, parseIsoDate, type IsoDate } from "@/lib/time/zoned";
import { getNow } from "./clock";
import { nebRows } from "./nebulization";
import { audit, DbError, getSettingNumber, tx, type Tx } from "./db";
import { AuthenticationError, getSession, type Session } from "./session";

/**
 * Milestone 3 write workflows. Same layering as reads: the app checks permission
 * and business rules here, PostgreSQL RLS + triggers enforce them again.
 */

export class ClinicalError extends Error {
  constructor(
    public readonly kind: "FORBIDDEN" | "INVALID" | "CONFLICT" | "NOT_FOUND" | "REAUTH_REQUIRED",
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** Resolve the request's session (for server actions/pages); core functions take it explicitly so they are testable. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new AuthenticationError();
  return s;
}

function as<T>(s: Session, fn: (c: Tx) => Promise<T>, changeReason?: string): Promise<T> {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, async (c) => {
    if (changeReason !== undefined) await c.query("SELECT set_config('app.change_reason', $1, true)", [changeReason]);
    return fn(c);
  });
}

// Inside a transaction the raw driver error is seen (sanitized to DbError only after rollback).
const isUniqueViolation = (e: unknown) => (e instanceof DbError || (typeof e === "object" && e !== null)) && (e as { code?: unknown }).code === "23505";

// ================================================================= patients

export interface PatientInput {
  fullName: string;
  sex: string;
  category: string;
  dateOfBirth: string;
  hospitalPatientId: string;
  wardRoom: string;
  contactInfo?: string;
  attendingPhysician?: string;
  heightCm?: string;
  weightKg?: string;
}

export interface CleanPatient {
  fullName: string;
  sex: "M" | "F";
  category: PatientCategory;
  dateOfBirth: IsoDate | null;
  hospitalPatientId: string | null;
  wardRoom: string | null;
  contactInfo: string | null;
  attendingPhysician: string | null;
  heightCm: number | null;
  weightKg: number | null;
}

export function validatePatient(input: PatientInput, now: Date): { ok: true; value: CleanPatient } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const fullName = input.fullName.trim().replace(/\s+/g, " ");
  if (fullName.length < 2 || fullName.length > 160) errors.fullName = "Enter the patient's full name (2–160 characters).";
  // Decision U-07: only male or female.
  if (input.sex !== "M" && input.sex !== "F") errors.sex = "Select Male or Female.";
  if (!["OPD", "INP", "OTHER"].includes(input.category)) errors.category = "Select OPD, INP or Other.";
  let dob: IsoDate | null = null;
  if (input.dateOfBirth.trim()) {
    try {
      parseIsoDate(input.dateOfBirth.trim());
      dob = input.dateOfBirth.trim();
      const today = classifyInstant(now).calendarDate;
      if (dob > today) errors.dateOfBirth = "Date of birth cannot be in the future.";
      else if (dob < "1890-01-02") errors.dateOfBirth = "Check the year of birth.";
    } catch {
      errors.dateOfBirth = "Enter a valid date (or leave blank if unknown).";
    }
  }
  // Decision U-13: hospital number is optional.
  const hid = input.hospitalPatientId.trim();
  if (hid && (hid.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/.test(hid)))
    errors.hospitalPatientId = "Use letters, digits, space, dot, slash or dash (max 40).";
  const ward = input.wardRoom.trim().replace(/\s+/g, " ");
  if (ward.length > 60) errors.wardRoom = "Max 60 characters.";
  const contact = (input.contactInfo ?? "").trim().replace(/\s+/g, " ");
  if (contact.length > 120) errors.contactInfo = "Max 120 characters.";
  const md = (input.attendingPhysician ?? "").trim().replace(/\s+/g, " ");
  if (md.length > 120) errors.attendingPhysician = "Max 120 characters.";
  const num = (raw: string | undefined, min: number, max: number, key: string, label: string) => {
    const t = (raw ?? "").trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < min || n > max) {
      errors[key] = `${label}: enter a number from ${min} to ${max}.`;
      return null;
    }
    return Math.round(n * 10) / 10;
  };
  const heightCm = num(input.heightCm, 20, 250, "heightCm", "Height (cm)");
  const weightKg = num(input.weightKg, 0.3, 400, "weightKg", "Weight (kg)");
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      fullName,
      sex: input.sex as "M" | "F",
      category: input.category as PatientCategory,
      dateOfBirth: dob,
      hospitalPatientId: hid || null,
      wardRoom: ward || null,
      contactInfo: contact || null,
      attendingPhysician: md || null,
      heightCm,
      weightKg,
    },
  };
}

export interface DuplicateCandidate {
  id: string;
  fullName: string;
  hospitalPatientId: string | null;
  dateOfBirth: IsoDate | null;
  sex: string | null;
  category: string;
  wardRoom: string | null;
  match: "SAME_HOSPITAL_NUMBER" | "SAME_NAME" | "SAME_DOB_SHARED_NAME";
}

/** Possible duplicates for HUMAN review. Never used to merge or auto-reject (except an identical hospital number). */
async function findCandidates(
  c: Tx,
  p: { fullName: string; dateOfBirth: IsoDate | null; hospitalPatientId: string | null },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const r = await c.query<{
    id: string;
    full_name: string;
    hospital_patient_id: string | null;
    date_of_birth: string | null;
    sex: string | null;
    category: string;
    ward_room: string | null;
    match: DuplicateCandidate["match"];
  }>(
    `SELECT id, full_name, hospital_patient_id, date_of_birth, sex, category, ward_room,
            CASE WHEN $3::text IS NOT NULL AND upper(btrim(hospital_patient_id)) = upper(btrim($3)) THEN 'SAME_HOSPITAL_NUMBER'
                 WHEN name_key(full_name) = name_key($1) THEN 'SAME_NAME'
                 ELSE 'SAME_DOB_SHARED_NAME' END AS match
       FROM patient
      WHERE voided_at IS NULL AND ($4::uuid IS NULL OR id <> $4)
        AND (($3::text IS NOT NULL AND upper(btrim(hospital_patient_id)) = upper(btrim($3)))
          OR name_key(full_name) = name_key($1)
          OR ($2::date IS NOT NULL AND date_of_birth = $2 AND string_to_array(name_key(full_name), ' ') && string_to_array(name_key($1), ' ')))
      ORDER BY 8, full_name LIMIT 10`,
    [p.fullName, p.dateOfBirth, p.hospitalPatientId, excludeId ?? null],
  );
  return r.rows.map((x) => ({
    id: x.id,
    fullName: x.full_name,
    hospitalPatientId: x.hospital_patient_id,
    dateOfBirth: x.date_of_birth,
    sex: x.sex,
    category: x.category,
    wardRoom: x.ward_room,
    match: x.match,
  }));
}

export type RegisterResult =
  | { status: "created"; id: string }
  | { status: "review"; candidates: DuplicateCandidate[] }
  | { status: "invalid"; errors: Record<string, string> }
  | { status: "exists"; existingId: string };

/**
 * Registers a patient. If possible duplicates exist, returns them for review; the user must
 * explicitly confirm each one is a DIFFERENT person (recorded in the audit log) before the
 * patient is created. An identical hospital number is always refused.
 */
export async function registerPatient(s: Session, input: PatientInput, confirmedDistinctFrom: string[]): Promise<RegisterResult> {
  if (!roleHas(s.role, "patients:write")) throw new ClinicalError("FORBIDDEN", "You cannot register patients.");
  const v = validatePatient(input, getNow());
  if (!v.ok) return { status: "invalid", errors: v.errors };
  const p = v.value;
  return as(s, async (c) => {
    const candidates = await findCandidates(c, p);
    const sameNumber = candidates.find((x) => x.match === "SAME_HOSPITAL_NUMBER");
    if (sameNumber) return { status: "exists" as const, existingId: sameNumber.id };
    const confirmed = new Set(confirmedDistinctFrom);
    if (candidates.some((x) => !confirmed.has(x.id))) return { status: "review" as const, candidates };
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO patient (hospital_patient_id, full_name, date_of_birth, sex, category, ward_room, contact_info, attending_physician, height_cm, weight_kg,
                              provenance, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $8, $9, $10, $11, 'MANUAL', $7, $7) RETURNING id`,
        [p.hospitalPatientId, p.fullName, p.dateOfBirth, p.sex, p.category, p.wardRoom, s.staffId, p.contactInfo, p.attendingPhysician, p.heightCm, p.weightKg],
      );
      await audit(c, "patient.registered", { reviewed_distinct_from: candidates.map((x) => x.id) }, { table: "patient", id: r.rows[0].id });
      return { status: "created" as const, id: r.rows[0].id };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ClinicalError("CONFLICT", "A patient with this hospital number already exists.");
      throw e;
    }
  });
}

export type CorrectResult = { status: "saved" } | { status: "invalid"; errors: Record<string, string> };

/**
 * Corrects a patient record. Optimistic concurrency: `expectedUpdatedAt` must match, so a
 * correction never silently overwrites someone else's newer change. Identity changes need a reason;
 * every change is kept in patient_revision.
 */
export async function correctPatient(s: Session, id: string, expectedUpdatedAt: string, input: PatientInput, reason: string): Promise<CorrectResult> {
  if (!roleHas(s.role, "patients:write")) throw new ClinicalError("FORBIDDEN", "You cannot correct patient records.");
  const v = validatePatient(input, getNow());
  if (!v.ok) return { status: "invalid", errors: v.errors };
  const p = v.value;
  const why = reason.trim().replace(/\s+/g, " ");
  return as<CorrectResult>(
    s,
    async (c): Promise<CorrectResult> => {
      const cur = await c.query<{ updated_at: Date; full_name: string; date_of_birth: string | null; sex: string | null; hospital_patient_id: string | null }>(
        "SELECT updated_at, full_name, date_of_birth, sex, hospital_patient_id FROM patient WHERE id = $1 AND voided_at IS NULL FOR UPDATE",
        [id],
      );
      const row = cur.rows[0];
      if (!row) throw new ClinicalError("NOT_FOUND", "Patient not found.");
      if (new Date(row.updated_at).toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
        throw new ClinicalError("CONFLICT", "This record was changed by someone else after you opened it. Reload and re-apply your correction.");
      }
      const identityChanged =
        row.full_name !== p.fullName || row.date_of_birth !== p.dateOfBirth || row.sex !== p.sex || (row.hospital_patient_id ?? null) !== p.hospitalPatientId;
      if (identityChanged && why.length < 5)
        return { status: "invalid", errors: { reason: "Give a reason for correcting identity details (at least 5 characters)." } };
      try {
        await c.query(
          `UPDATE patient SET hospital_patient_id = $2, full_name = $3, date_of_birth = $4, sex = $5, category = $6, ward_room = $7, updated_by = $8,
                  contact_info = $9, attending_physician = $10, height_cm = $11, weight_kg = $12 WHERE id = $1`,
          [
            id,
            p.hospitalPatientId,
            p.fullName,
            p.dateOfBirth,
            p.sex,
            p.category,
            p.wardRoom,
            s.staffId,
            p.contactInfo,
            p.attendingPhysician,
            p.heightCm,
            p.weightKg,
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) return { status: "invalid", errors: { hospitalPatientId: "Another patient already has this hospital number." } };
        throw e;
      }
      return { status: "saved" };
    },
    why,
  );
}

export async function getPatientRevisions(s: Session, id: string) {
  if (!roleHas(s.role, "patients:read")) throw new ClinicalError("FORBIDDEN", "Forbidden");
  return as(s, async (c) => {
    const r = await c.query<{
      id: number;
      changed_at: Date;
      by: string | null;
      reason: string | null;
      before_data: Record<string, unknown>;
      after_data: Record<string, unknown>;
    }>(
      `SELECT r.id, r.changed_at, st.display_name AS by, r.reason, r.before_data, r.after_data
         FROM patient_revision r LEFT JOIN staff st ON st.id = r.changed_by WHERE r.patient_id = $1 ORDER BY r.changed_at DESC`,
      [id],
    );
    return r.rows.map((x) => ({
      id: x.id,
      changedIso: new Date(x.changed_at).toISOString(),
      by: x.by ?? "System",
      reason: x.reason,
      changes: Object.keys(x.after_data)
        .filter((k) => JSON.stringify(x.before_data[k]) !== JSON.stringify(x.after_data[k]))
        .map((k) => ({ field: k, from: x.before_data[k] as string | null, to: x.after_data[k] as string | null })),
    }));
  });
}

export async function getPatientForEdit(s: Session, id: string) {
  if (!roleHas(s.role, "patients:write")) throw new ClinicalError("FORBIDDEN", "Forbidden");
  return as(s, async (c) => {
    const r = await c.query<{
      id: string;
      full_name: string;
      sex: string | null;
      category: string;
      date_of_birth: string | null;
      hospital_patient_id: string | null;
      ward_room: string | null;
      contact_info: string | null;
      attending_physician: string | null;
      height_cm: string | null;
      weight_kg: string | null;
      updated_at: Date;
    }>(
      `SELECT id, full_name, sex, category, date_of_birth, hospital_patient_id, ward_room, contact_info, attending_physician, height_cm::text, weight_kg::text, updated_at
         FROM patient WHERE id = $1 AND voided_at IS NULL`,
      [id],
    );
    const p = r.rows[0];
    if (!p) return null;
    return {
      id: p.id,
      fullName: p.full_name,
      sex: p.sex ?? "",
      category: p.category,
      dateOfBirth: p.date_of_birth ?? "",
      hospitalPatientId: p.hospital_patient_id ?? "",
      wardRoom: p.ward_room ?? "",
      contactInfo: p.contact_info ?? "",
      attendingPhysician: p.attending_physician ?? "",
      heightCm: p.height_cm ? String(Number(p.height_cm)) : "",
      weightKg: p.weight_kg ? String(Number(p.weight_kg)) : "",
      updatedAt: new Date(p.updated_at).toISOString(),
    };
  });
}

// ================================================================= roster

function requireChief(s: Session) {
  if (!roleHas(s.role, "shifts:manage")) throw new ClinicalError("FORBIDDEN", "Only the Chief RT can change shift assignments.");
}

export async function assignShift(s: Session, operationalDate: string, shift: string, staffId: string): Promise<void> {
  requireChief(s);
  if (!SHIFT_ORDER.includes(shift as ShiftCode)) throw new ClinicalError("INVALID", "Unknown shift.");
  try {
    parseIsoDate(operationalDate);
  } catch {
    throw new ClinicalError("INVALID", "Invalid date.");
  }
  const today = classifyInstant(getNow()).operationalDate;
  if (operationalDate < addDays(today, -7) || operationalDate > addDays(today, 60))
    throw new ClinicalError("INVALID", "Assignments can be edited from 7 days ago to 60 days ahead.");
  await as(s, async (c) => {
    const st = await c.query("SELECT 1 FROM staff WHERE id = $1 AND status = 'ACTIVE'", [staffId]);
    if (!st.rowCount) throw new ClinicalError("INVALID", "Only active staff can be rostered.");
    try {
      await c.query("INSERT INTO shift_assignment (operational_date, shift, staff_id, created_by) VALUES ($1, $2, $3, $4)", [
        operationalDate,
        shift,
        staffId,
        s.staffId,
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ClinicalError("CONFLICT", "Already assigned to this shift.");
      throw e;
    }
  });
}

export async function removeAssignment(s: Session, assignmentId: string, reason: string): Promise<void> {
  requireChief(s);
  await as(s, async (c) => {
    const r = await c.query(
      "UPDATE shift_assignment SET removed_at = now(), removed_by = $2, removal_reason = $3 WHERE id = $1 AND removed_at IS NULL AND operational_date >= $4",
      [assignmentId, s.staffId, reason.trim().slice(0, 200) || null, addDays(classifyInstant(getNow()).operationalDate, -7)],
    );
    if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "Assignment not found (or too old to change).");
  });
}

export async function getEditableRoster(s: Session, days = 14) {
  requireChief(s);
  return as(s, async (c) => {
    const today = classifyInstant(getNow()).operationalDate;
    const from = addDays(today, -1);
    const to = addDays(today, days - 2);
    const a = await c.query<{ id: string; operational_date: string; shift: ShiftCode; staff_id: string; name: string }>(
      `SELECT a.id, a.operational_date, a.shift, a.staff_id, s.display_name AS name FROM shift_assignment a JOIN staff s ON s.id = a.staff_id
        WHERE a.removed_at IS NULL AND a.operational_date BETWEEN $1 AND $2 ORDER BY s.display_name`,
      [from, to],
    );
    const staff = await c.query<{ id: string; name: string }>("SELECT id, display_name AS name FROM staff WHERE status = 'ACTIVE' ORDER BY display_name");
    const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
    return {
      today,
      staff: staff.rows,
      dates: dates.map((date) => ({
        date,
        shifts: SHIFT_ORDER.map((shift) => ({
          shift,
          assignments: a.rows.filter((x) => x.operational_date === date && x.shift === shift).map((x) => ({ id: x.id, staffId: x.staff_id, name: x.name })),
        })),
      })),
    };
  });
}

// ================================================================= handover

export interface HandoverCandidate {
  kind: "VENTILATOR_ENCOUNTER" | "NEBULIZATION_ADMIN" | "NEBULIZATION_ORDER" | "TUBING" | "DIAGNOSTIC";
  refId: string;
  /** Expected-dose slot (ISO) for NEBULIZATION_ORDER items; null otherwise. */
  slotAt: string | null;
  summary: string;
  patient: string;
  /** Needs the incoming RT's attention (late/missed, overdue, new this shift); ticked by default. */
  problem: boolean;
}

/**
 * Open items to carry forward, gathered from LIVE records (so unresolved items naturally
 * re-appear in the next handover without copying the clinical event).
 */
async function gatherCandidates(c: Tx, ref: ShiftRef, now: Date): Promise<HandoverCandidate[]> {
  const out: HandoverCandidate[] = [];
  const recv = shiftWindow(receivingShift(ref).operationalDate, receivingShift(ref).shift);
  const pat = (name: string, hid: string | null) => `${name}${hid ? ` · ${hid}` : ""}`;

  const handed = shiftWindow(ref.operationalDate, ref.shift);
  const vent = await c.query<{
    id: string;
    ventilator_ref: string;
    ward_room: string;
    name: string;
    hid: string | null;
    next_due: Date | null;
    hooked_at: Date;
  }>(
    `SELECT e.id, e.ventilator_ref, e.ward_room, p.full_name AS name, p.hospital_patient_id AS hid, e.hooked_at,
            (SELECT t.next_due_at FROM tubing_event t WHERE t.encounter_id = e.id AND t.voided_at IS NULL ORDER BY t.installed_at DESC LIMIT 1) AS next_due
       FROM vent_encounter e JOIN patient p ON p.id = e.patient_id
      WHERE e.disconnected_at IS NULL AND e.hooked_at <= $1 ORDER BY e.ward_room`,
    [now],
  );
  const policy = {
    intervalDays: await getSettingNumber(c, "tubing.interval_days", 7),
    upcomingWindowHours: await getSettingNumber(c, "tubing.upcoming_window_hours", DEFAULT_TUBING_POLICY.upcomingWindowHours),
  };
  for (const e of vent.rows) {
    out.push({
      kind: "VENTILATOR_ENCOUNTER",
      refId: e.id,
      slotAt: null,
      summary: `${new Date(e.hooked_at) >= handed.start ? "New hook-in this shift" : "Active ventilator"} ${e.ventilator_ref} · ${e.ward_room}`,
      patient: pat(e.name, e.hid),
      problem: new Date(e.hooked_at) >= handed.start,
    });
    const t = assessFromDue(e.next_due ? new Date(e.next_due) : null, now, policy);
    if (t.status !== "CURRENT") {
      const label = { OVERDUE: "overdue", DUE: "due this operational day", UPCOMING: "upcoming", NO_RECORD: "no documented installation" }[t.status];
      out.push({
        kind: "TUBING",
        refId: e.id,
        slotAt: null,
        summary: `Tubing ${label} · ${e.ventilator_ref}`,
        patient: pat(e.name, e.hid),
        problem: t.status !== "UPCOMING",
      });
    }
  }

  // Doses still open: expected slots not yet documented (by ORDER + slot, since they are not stored)
  // from the handed-over shift through the receiving shift, plus documented DELAYED doses.
  const doses = await nebRows(c, { start: shiftWindow(ref.operationalDate, ref.shift).start, end: recv.end }, now);
  for (const n of doses) {
    const at = n.scheduledIso ?? n.actualIso!;
    const label = `Nebulization ${n.status.toLowerCase().replace("_", " ")} · ${n.orderReference} · ${formatTime(new Date(at))}`;
    if (!n.documented && (n.status === "PENDING" || n.status === "SCHEDULED")) {
      out.push({
        kind: "NEBULIZATION_ORDER",
        refId: n.orderId,
        slotAt: n.scheduledIso,
        summary: label,
        patient: pat(n.patient.name, n.patient.hospitalId),
        problem: n.status === "PENDING",
      });
    } else if (n.documented && (n.status === "DELAYED" || n.status === "IN_PROGRESS")) {
      out.push({ kind: "NEBULIZATION_ADMIN", refId: n.id!, slotAt: null, summary: label, patient: pat(n.patient.name, n.patient.hospitalId), problem: true });
    }
  }

  const dx = await c.query<{ id: string; service: string; status: string; scheduled_at: Date; name: string; hid: string | null }>(
    `SELECT d.id, d.service, d.status, d.scheduled_at, p.full_name AS name, p.hospital_patient_id AS hid
       FROM diagnostic_appointment d JOIN patient p ON p.id = d.patient_id
      WHERE d.status IN ('SCHEDULED', 'PENDING', 'FOR_RESCHEDULE') AND d.voided_at IS NULL AND d.scheduled_at >= $1 AND d.scheduled_at < $2
      ORDER BY d.scheduled_at`,
    [shiftWindow(ref.operationalDate, ref.shift).start, recv.end],
  );
  for (const d of dx.rows) {
    const svc = d.service === "SPUTUM_INDUCTION" ? "Sputum induction" : d.service;
    out.push({
      kind: "DIAGNOSTIC",
      refId: d.id,
      slotAt: null,
      summary: `${svc} ${d.status.toLowerCase().replace("_", " ")} · ${formatTime(new Date(d.scheduled_at))}`,
      patient: pat(d.name, d.hid),
      problem: d.status !== "SCHEDULED" || new Date(d.scheduled_at) < now,
    });
  }
  return out;
}

export interface HandoverDraft {
  shift: ShiftRef;
  alreadyWritten: boolean;
  rostered: boolean;
  candidates: HandoverCandidate[];
  incomingOptions: Array<{ id: string; name: string }>;
}

/** What the signed-in user may hand over now (current and just-ended shift). */
export async function getHandoverDrafts(s: Session): Promise<HandoverDraft[]> {
  if (!roleHas(s.role, "handover:write")) return [];
  const now = getNow();
  return as(s, async (c) => {
    const drafts: HandoverDraft[] = [];
    for (const ref of handoverableShifts(now)) {
      const exists = await c.query("SELECT 1 FROM shift_handover WHERE operational_date = $1 AND shift = $2", [ref.operationalDate, ref.shift]);
      const rostered = await c.query("SELECT 1 FROM shift_assignment WHERE operational_date = $1 AND shift = $2 AND staff_id = $3 AND removed_at IS NULL", [
        ref.operationalDate,
        ref.shift,
        s.staffId,
      ]);
      const recv = receivingShift(ref);
      const incoming = await c.query<{ id: string; name: string }>(
        `SELECT s.id, s.display_name AS name FROM shift_assignment a JOIN staff s ON s.id = a.staff_id
          WHERE a.operational_date = $1 AND a.shift = $2 AND a.removed_at IS NULL AND s.status = 'ACTIVE' AND s.id <> $3 ORDER BY s.display_name`,
        [recv.operationalDate, recv.shift, s.staffId],
      );
      drafts.push({
        shift: ref,
        alreadyWritten: !!exists.rowCount,
        rostered: !!rostered.rowCount,
        candidates: exists.rowCount ? [] : await gatherCandidates(c, ref, now),
        incomingOptions: incoming.rows,
      });
    }
    return drafts;
  });
}

export interface HandoverInput {
  operationalDate: string;
  shift: string;
  incomingStaffId: string | null;
  equipmentConcerns: string;
  notes: string;
  items: Array<{ kind: string; refId: string; slotAt?: string | null }>;
}

/**
 * Writes the ONE handover for a shift (decision U-11). The author must have been rostered on
 * that shift (or be the Chief RT, who writes as themself). Items must be among the live
 * open items gathered by the server — arbitrary references are rejected.
 */
export async function createHandover(s: Session, input: HandoverInput): Promise<{ id: string }> {
  if (!roleHas(s.role, "handover:write")) throw new ClinicalError("FORBIDDEN", "You cannot write handovers.");
  const now = getNow();
  const ref = { operationalDate: input.operationalDate, shift: input.shift as ShiftCode };
  if (!SHIFT_ORDER.includes(ref.shift) || !isHandoverable(ref, now))
    throw new ClinicalError("INVALID", "A handover can be written only for the current shift or the one that just ended.");
  const notes = input.notes.trim();
  const equipment = input.equipmentConcerns.trim();
  if (notes.length > 4000 || equipment.length > 2000) throw new ClinicalError("INVALID", "Notes are too long.");
  if (!notes && input.items.length === 0) throw new ClinicalError("INVALID", "Add handover notes or select at least one open item.");
  return as(s, async (c) => {
    const rostered = await c.query("SELECT 1 FROM shift_assignment WHERE operational_date = $1 AND shift = $2 AND staff_id = $3 AND removed_at IS NULL", [
      ref.operationalDate,
      ref.shift,
      s.staffId,
    ]);
    if (!rostered.rowCount && s.role !== "CHIEF_RT_ADMIN")
      throw new ClinicalError("FORBIDDEN", "Only an RT rostered on this shift (or the Chief RT) can write its handover.");
    if (input.incomingStaffId) {
      const recv = receivingShift(ref);
      const ok = await c.query("SELECT 1 FROM shift_assignment WHERE operational_date = $1 AND shift = $2 AND staff_id = $3 AND removed_at IS NULL", [
        recv.operationalDate,
        recv.shift,
        input.incomingStaffId,
      ]);
      if (!ok.rowCount || input.incomingStaffId === s.staffId) throw new ClinicalError("INVALID", "The incoming RT must be rostered on the next shift.");
    }
    const key = (k: string, id: string, slot: string | null | undefined) => `${k}:${id}:${slot ?? ""}`;
    const allowed = new Map((await gatherCandidates(c, ref, now)).map((x) => [key(x.kind, x.refId, x.slotAt), x]));
    const items = [...new Set(input.items.map((i) => key(i.kind, i.refId, i.slotAt)))].map((k) => {
      const cand = allowed.get(k);
      if (!cand) throw new ClinicalError("INVALID", "One of the selected items is no longer open. Reload and try again.");
      return cand;
    });
    let id: string;
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO shift_handover (operational_date, shift, outgoing_staff_id, incoming_staff_id, equipment_concerns, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ref.operationalDate, ref.shift, s.staffId, input.incomingStaffId, equipment || null, notes],
      );
      id = r.rows[0].id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ClinicalError("CONFLICT", "A handover has already been written for this shift.");
      throw e;
    }
    for (const it of items) {
      await c.query("INSERT INTO handover_item (handover_id, kind, ref_id, slot_at, summary) VALUES ($1, $2, $3, $4, $5)", [
        id,
        it.kind,
        it.refId,
        it.slotAt,
        it.summary,
      ]);
    }
    await audit(c, "handover.created", { items: items.length }, { table: "shift_handover", id });
    return { id };
  });
}

/** Acknowledgment by anyone other than the author; recorded with who and when. Frozen afterwards. */
export async function acknowledgeHandover(s: Session, id: string): Promise<void> {
  if (!roleHas(s.role, "handover:write")) throw new ClinicalError("FORBIDDEN", "You cannot acknowledge handovers.");
  await as(s, async (c) => {
    const r = await c.query<{ outgoing_staff_id: string; acknowledged_at: Date | null }>(
      "SELECT outgoing_staff_id, acknowledged_at FROM shift_handover WHERE id = $1 FOR UPDATE",
      [id],
    );
    const h = r.rows[0];
    if (!h) throw new ClinicalError("NOT_FOUND", "Handover not found.");
    if (h.acknowledged_at) throw new ClinicalError("CONFLICT", "This handover has already been acknowledged.");
    if (h.outgoing_staff_id === s.staffId) throw new ClinicalError("FORBIDDEN", "You wrote this handover; the incoming RT must acknowledge it.");
    await c.query("UPDATE shift_handover SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1", [id, s.staffId]);
    await audit(c, "handover.acknowledged", undefined, { table: "shift_handover", id });
  });
}

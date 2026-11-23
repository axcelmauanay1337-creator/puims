import "server-only";
import { roleHas } from "@/lib/authz/permissions";
import { expectedSlots, parsePrescribedTimes } from "@/lib/clinical/nebSlots";
import { FREQUENCY_PRESETS, REASON_REQUIRED_STATUSES, type NebulizationStatus } from "@/lib/clinical/vocabulary";
import { AIRWAY_TYPES, DISCONNECT_REASONS, REQUIRED_VENT_NUMBERS, VENT_MODES, VENT_NUMBERS, type VentNumberKey } from "@/lib/clinical/vent";
import { HOSPITAL_TZ, parseIsoDate, zonedWallTimeToUtc } from "@/lib/time/zoned";
import { ClinicalError } from "./clinical";
import { getNow } from "./clock";
import { audit, getSettingNumber, tx, type Tx } from "./db";
import type { Session } from "./session";

/**
 * Milestone 4 documentation. Rules (handoff §5–7, decisions 2026-11-22):
 *  - Only RTs enter / discontinue nebulization orders. Orders are never edited.
 *  - Every documented event is in the signed-in user's own name, carries the clinical time
 *    (entered in Asia/Manila wall time), the device's capture time, and a client-generated id.
 *  - Re-submitting the same client id is idempotent (returns the original, never duplicates).
 *  - Nothing is ever documented automatically. Mistakes are voided with a reason, never edited.
 */

/** Clinical times may be documented late (up to this many hours) but not in the future. */
export const LATE_ENTRY_HOURS = 72;
export const FUTURE_TOLERANCE_MS = 5 * 60_000; // device clock tolerance

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function as<T>(s: Session, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}

function requireClientId(id: string): string {
  if (!UUID_RE.test(id)) throw new ClinicalError("INVALID", "Missing or invalid client id.");
  return id;
}

/** "2026-11-22T14:05" interpreted as Asia/Manila wall time → UTC instant. */
export function parseManilaWall(value: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  try {
    const { year, month, day } = parseIsoDate(m[1]);
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) return null;
    return zonedWallTimeToUtc({ year, month, day, hour, minute }, HOSPITAL_TZ);
  } catch {
    return null;
  }
}

function clinicalTime(value: string, label: string, now: Date): Date {
  const t = parseManilaWall(value);
  if (!t) throw new ClinicalError("INVALID", `${label}: enter a date and time.`);
  if (t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new ClinicalError("INVALID", `${label} cannot be in the future.`);
  if (t.getTime() < now.getTime() - LATE_ENTRY_HOURS * 3_600_000)
    throw new ClinicalError("INVALID", `${label} is more than ${LATE_ENTRY_HOURS} hours ago; contact the Chief RT for late documentation.`);
  return t;
}

function deviceTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t;
}

function reasonText(raw: string, min: number, label = "Reason"): string {
  const r = raw.trim().replace(/\s+/g, " ");
  if (r.length < min) throw new ClinicalError("INVALID", `${label} is required (at least ${min} characters).`);
  if (r.length > 300) throw new ClinicalError("INVALID", `${label}: at most 300 characters.`);
  return r;
}

/** If a row with this client id already exists, return it when it is the same author's; otherwise conflict. */
async function existingById(c: Tx, table: string, authorCol: string, id: string, s: Session): Promise<string | null> {
  const r = await c.query(`SELECT ${authorCol} AS author FROM ${table} WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  if (r.rows[0].author !== s.staffId) throw new ClinicalError("CONFLICT", "This entry id is already in use.");
  return id;
}

export interface WriteResult {
  id: string;
  duplicate: boolean;
}

// ================================================================= nebulization orders

export interface NebOrderInput {
  clientId: string;
  patientId: string;
  orderReference: string;
  prescriber: string;
  medicationAsOrdered: string;
  frequency: string;
  prescribedTimes: string;
  startAt: string; // Manila wall
  endAt: string; // Manila wall or ""
}

export async function enterNebOrder(s: Session, input: NebOrderInput): Promise<WriteResult> {
  // Decision 2026-11-22: only Respiratory Therapists enter orders.
  if (!roleHas(s.role, "orders:enter")) throw new ClinicalError("FORBIDDEN", "Only Respiratory Therapists enter nebulization orders.");
  const id = requireClientId(input.clientId);
  const now = getNow();
  const orderReference = input.orderReference.trim();
  const prescriber = input.prescriber.trim();
  const medication = input.medicationAsOrdered.trim();
  if (!orderReference || orderReference.length > 60) throw new ClinicalError("INVALID", "Order reference is required (max 60 characters).");
  if (!prescriber || prescriber.length > 120) throw new ClinicalError("INVALID", "Prescriber is required (max 120 characters).");
  if (!medication || medication.length > 300) throw new ClinicalError("INVALID", "Medication as ordered is required (max 300 characters).");
  if (!(FREQUENCY_PRESETS as readonly string[]).includes(input.frequency)) throw new ClinicalError("INVALID", "Select a frequency.");
  const times = parsePrescribedTimes(input.prescribedTimes);
  if (!times.ok) throw new ClinicalError("INVALID", times.error);
  if (input.frequency === "PRN" && times.times.length) throw new ClinicalError("INVALID", "PRN orders have no scheduled times; document each dose when given.");
  const start = parseManilaWall(input.startAt);
  if (!start) throw new ClinicalError("INVALID", "Order start: enter a date and time.");
  if (start.getTime() > now.getTime() + 7 * 24 * 3_600_000 || start.getTime() < now.getTime() - 14 * 24 * 3_600_000) {
    throw new ClinicalError("INVALID", "Order start must be within the last 14 days or the next 7 days.");
  }
  let end: Date | null = null;
  if (input.endAt.trim()) {
    end = parseManilaWall(input.endAt);
    if (!end || end <= start) throw new ClinicalError("INVALID", "Order end must be after the start.");
  }
  return as(s, async (c) => {
    if (await existingById(c, "neb_order", "entered_by", id, s)) return { id, duplicate: true };
    const p = await c.query("SELECT 1 FROM patient WHERE id = $1 AND voided_at IS NULL", [input.patientId]);
    if (!p.rowCount) throw new ClinicalError("INVALID", "Select a patient.");
    await c.query(
      `INSERT INTO neb_order (id, patient_id, order_reference, prescriber, medication_as_ordered, frequency, prescribed_times, start_at, end_at, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::time[], $8, $9, $10)`,
      [id, input.patientId, orderReference, prescriber, medication, input.frequency, times.times, start, end, s.staffId],
    );
    await audit(c, "neb_order.entered", { frequency: input.frequency, times: times.times.length }, { table: "neb_order", id });
    return { id, duplicate: false };
  });
}

export async function discontinueNebOrder(s: Session, orderId: string, reason: string): Promise<void> {
  if (!roleHas(s.role, "orders:enter")) throw new ClinicalError("FORBIDDEN", "Only Respiratory Therapists discontinue nebulization orders.");
  const why = reasonText(reason, 5);
  await as(s, async (c) => {
    const r = await c.query(
      "UPDATE neb_order SET discontinued_at = now(), discontinued_by = $2, discontinue_reason = $3 WHERE id = $1 AND discontinued_at IS NULL AND (end_at IS NULL OR end_at > now())",
      [orderId, s.staffId, why],
    );
    if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "Order not found or no longer active.");
  });
}

// ================================================================= nebulization administrations

export interface NebDocInput {
  clientId: string;
  orderId: string;
  /** ISO instant of the expected slot being documented, or null for an unscheduled/PRN dose. */
  scheduledAt: string | null;
  status: string;
  /** Asia/Manila wall time of what actually happened ("" when not given/cancelled). */
  actualAt: string;
  reason: string;
  recordedAtDevice: string | null;
}

const DOCUMENTABLE: NebulizationStatus[] = ["COMPLETED", "NOT_GIVEN", "REFUSED", "DELAYED", "CANCELLED"];

export type CaptureSource = "ONLINE" | "OFFLINE_SYNC";

export async function documentNebulization(s: Session, input: NebDocInput, source: CaptureSource = "ONLINE"): Promise<WriteResult> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document treatments.");
  const id = requireClientId(input.clientId);
  const now = getNow();
  const status = input.status as NebulizationStatus;
  if (!DOCUMENTABLE.includes(status)) throw new ClinicalError("INVALID", "Select what happened.");
  const needsReason = REASON_REQUIRED_STATUSES.includes(status);
  const reason = needsReason ? reasonText(input.reason, 3, "Reason") : null;
  const actual =
    status === "COMPLETED" ? clinicalTime(input.actualAt, "Time given", now) : input.actualAt.trim() ? clinicalTime(input.actualAt, "Time", now) : null;
  return as(s, async (c) => {
    if (await existingById(c, "neb_administration", "performed_by", id, s)) return { id, duplicate: true };
    const o = await c.query<{
      patient_id: string;
      frequency: string;
      prescribed_times: string[];
      start_at: Date;
      end_at: Date | null;
      discontinued_at: Date | null;
    }>("SELECT patient_id, frequency, prescribed_times::text[] AS prescribed_times, start_at, end_at, discontinued_at FROM neb_order WHERE id = $1", [
      input.orderId,
    ]);
    const order = o.rows[0];
    if (!order) throw new ClinicalError("NOT_FOUND", "Order not found.");
    let scheduled: Date | null = null;
    if (input.scheduledAt) {
      // The slot must be one actually written on the order (no invented schedules).
      scheduled = new Date(input.scheduledAt);
      const day = { start: new Date(scheduled.getTime() - 1), end: new Date(scheduled.getTime() + 1) };
      const valid = expectedSlots(
        {
          prescribedTimes: order.prescribed_times,
          startAt: new Date(order.start_at),
          endAt: order.end_at ? new Date(order.end_at) : null,
          discontinuedAt: order.discontinued_at ? new Date(order.discontinued_at) : null,
        },
        day,
      ).some((t) => t.getTime() === scheduled!.getTime());
      if (!valid) throw new ClinicalError("INVALID", "That time is not on the order.");
    } else {
      // Unscheduled / PRN dose: the order must be in effect at the time given.
      if (!actual) throw new ClinicalError("INVALID", "An unscheduled dose needs the time it was given.");
      const end = order.discontinued_at ?? order.end_at;
      if (actual < new Date(order.start_at) || (end && actual >= new Date(end)))
        throw new ClinicalError("INVALID", "The order was not in effect at that time.");
    }
    try {
      await c.query(
        `INSERT INTO neb_administration (id, order_id, patient_id, scheduled_at, actual_at, status, performed_by, reason, recorded_at_device, source, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $10)`,
        [id, input.orderId, order.patient_id, scheduled, actual, status, s.staffId, reason, deviceTime(input.recordedAtDevice), s.deviceId, source],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new ClinicalError("CONFLICT", "This dose has already been documented (possibly by another RT). Reload the worklist.");
      throw e;
    }
    return { id, duplicate: false };
  });
}

export async function voidNebulization(s: Session, id: string, reason: string): Promise<void> {
  const why = reasonText(reason, 5);
  await as(s, async (c) => {
    const r = await c.query<{ performed_by: string; voided_at: Date | null }>(
      "SELECT performed_by, voided_at FROM neb_administration WHERE id = $1 FOR UPDATE",
      [id],
    );
    const row = r.rows[0];
    if (!row || row.voided_at) throw new ClinicalError("NOT_FOUND", "Entry not found or already voided.");
    if (row.performed_by !== s.staffId && s.role !== "CHIEF_RT_ADMIN")
      throw new ClinicalError("FORBIDDEN", "Only the RT who documented it, or the Chief RT, can void this entry.");
    await c.query("UPDATE neb_administration SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [id, s.staffId, why]);
  });
}

// ================================================================= ventilation

export interface HookInInput {
  clientId: string;
  patientId: string;
  ventilatorRef: string;
  wardRoom: string;
  hookedAt: string;
  newCircuitInstalled: boolean;
  recordedAtDevice: string | null;
  airwayType?: string;
  airwaySize?: string;
  airwayPosition?: string;
}


function optText(v: string | undefined, max: number, label: string): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (t.length > max) throw new ClinicalError("INVALID", `${label}: max ${max} characters.`);
  return t;
}

export async function hookIn(s: Session, input: HookInInput): Promise<WriteResult> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document ventilation.");
  const id = requireClientId(input.clientId);
  const now = getNow();
  const vent = input.ventilatorRef.trim();
  const ward = input.wardRoom.trim();
  if (!vent || vent.length > 60) throw new ClinicalError("INVALID", "Ventilator identifier is required (max 60 characters).");
  if (!ward || ward.length > 60) throw new ClinicalError("INVALID", "Ward / room is required (max 60 characters).");
  const hooked = clinicalTime(input.hookedAt, "Hook-in time", now);
  const airwayType = input.airwayType ? input.airwayType : null;
  if (airwayType && !(AIRWAY_TYPES as readonly string[]).includes(airwayType)) throw new ClinicalError("INVALID", "Choose an airway type.");
  const airwaySize = optText(input.airwaySize, 20, "Airway size");
  const airwayPosition = optText(input.airwayPosition, 40, "Airway position");
  return as(s, async (c) => {
    if (await existingById(c, "vent_encounter", "responsible_staff_id", id, s)) return { id, duplicate: true };
    const p = await c.query("SELECT 1 FROM patient WHERE id = $1 AND voided_at IS NULL", [input.patientId]);
    if (!p.rowCount) throw new ClinicalError("INVALID", "Select a patient.");
    try {
      await c.query(
        `INSERT INTO vent_encounter (id, patient_id, hooked_at, ventilator_ref, ward_room, responsible_staff_id, recorded_at_device, device_id,
                                     airway_type, airway_size, airway_position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, input.patientId, hooked, vent, ward, s.staffId, deviceTime(input.recordedAtDevice), s.deviceId, airwayType, airwaySize, airwayPosition],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23P01")
        throw new ClinicalError("CONFLICT", "This patient already has a ventilator encounter at that time. Disconnect it first.");
      throw e;
    }
    if (input.newCircuitInstalled) {
      // Only because the RT explicitly ticked it: a circuit installed at hook-in is itself a documented event.
      const interval = await getSettingNumber(c, "tubing.interval_days", 7);
      await c.query(
        `INSERT INTO tubing_event (encounter_id, installed_at, interval_days, next_due_at, performed_by, reason, recorded_at_device, device_id)
         VALUES ($1, $2, $3, $2, $4, 'New circuit installed at hook-in', $5, $6)`,
        [id, hooked, interval, s.staffId, deviceTime(input.recordedAtDevice), s.deviceId],
      );
    }
    return { id, duplicate: false };
  });
}

export async function disconnect(s: Session, encounterId: string, disconnectedAt: string, reason?: string, note?: string): Promise<void> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document ventilation.");
  const now = getNow();
  const when = clinicalTime(disconnectedAt, "Disconnection time", now);
  const why = reason ? reason : null;
  if (why && !(DISCONNECT_REASONS as readonly string[]).includes(why)) throw new ClinicalError("INVALID", "Choose a reason for disconnection.");
  const whyNote = optText(note, 300, "Note");
  if (why === "OTHER" && !whyNote) throw new ClinicalError("INVALID", "Describe the reason for disconnection.");
  await as(s, async (c) => {
    const r = await c.query<{ hooked_at: Date; disconnected_at: Date | null }>(
      "SELECT hooked_at, disconnected_at FROM vent_encounter WHERE id = $1 FOR UPDATE",
      [encounterId],
    );
    const e = r.rows[0];
    if (!e || e.disconnected_at) throw new ClinicalError("NOT_FOUND", "Encounter not found or already disconnected.");
    if (when < new Date(e.hooked_at)) throw new ClinicalError("INVALID", "Disconnection cannot be before hook-in.");
    await c.query("UPDATE vent_encounter SET disconnected_at = $2, disconnect_reason = $3, disconnect_note = $4 WHERE id = $1", [encounterId, when, why, whyNote]);
    await audit(c, "vent.disconnected", undefined, { table: "vent_encounter", id: encounterId });
  });
}

// ================================================================= ventilator settings (flowsheet)

export interface VentSettingInput {
  clientId: string;
  encounterId: string;
  recordedAt: string;
  mode: string;
  modeOther?: string;
  values: Partial<Record<VentNumberKey, string>>;
  note?: string;
  recordedAtDevice: string | null;
}

function ventNumber(key: VentNumberKey, raw: string | undefined, required: boolean): number | null {
  const [label, min, max, integer] = VENT_NUMBERS[key];
  const t = (raw ?? "").trim();
  if (!t) {
    if (required) throw new ClinicalError("INVALID", `${label} is required.`);
    return null;
  }
  if (!/^\d+(\.\d+)?$/.test(t)) throw new ClinicalError("INVALID", `${label}: enter a number.`);
  const n = Number(t);
  if (integer && !Number.isInteger(n)) throw new ClinicalError("INVALID", `${label}: enter a whole number.`);
  if (n < min || n > max) throw new ClinicalError("INVALID", `${label} must be between ${min} and ${max} — check for a typing error.`);
  return n;
}

export async function recordVentSetting(s: Session, input: VentSettingInput): Promise<WriteResult> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document ventilation.");
  const id = requireClientId(input.clientId);
  const now = getNow();
  const at = clinicalTime(input.recordedAt, "Time", now);
  if (!(VENT_MODES as readonly string[]).includes(input.mode)) throw new ClinicalError("INVALID", "Choose the ventilator mode.");
  const modeOther = input.mode === "OTHER" ? optText(input.modeOther, 40, "Mode") : null;
  if (input.mode === "OTHER" && !modeOther) throw new ClinicalError("INVALID", "Type the mode.");
  const v = Object.fromEntries(
    (Object.keys(VENT_NUMBERS) as VentNumberKey[]).map((k) => [k, ventNumber(k, input.values[k], REQUIRED_VENT_NUMBERS.includes(k))]),
  ) as Record<VentNumberKey, number | null>;
  const note = optText(input.note, 300, "Note");
  return as(s, async (c) => {
    if (await existingById(c, "vent_setting", "recorded_by", id, s)) return { id, duplicate: true };
    const e = await c.query<{ hooked_at: Date; disconnected_at: Date | null }>("SELECT hooked_at, disconnected_at FROM vent_encounter WHERE id = $1", [
      input.encounterId,
    ]);
    const enc = e.rows[0];
    if (!enc) throw new ClinicalError("NOT_FOUND", "Ventilator encounter not found.");
    if (at < new Date(enc.hooked_at)) throw new ClinicalError("INVALID", "Time cannot be before hook-in.");
    if (enc.disconnected_at && at > new Date(enc.disconnected_at)) throw new ClinicalError("INVALID", "Time cannot be after disconnection.");
    await c.query(
      `INSERT INTO vent_setting (id, encounter_id, recorded_at, mode, mode_other, fio2, peep, tidal_volume, set_rate, pressure_support,
         inspiratory_pressure, inspiratory_time, peak_pressure, plateau_pressure, total_rate, exhaled_vt, minute_ventilation, spo2, cuff_pressure,
         note, recorded_by, recorded_at_device, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        id, input.encounterId, at, input.mode, modeOther, v.fio2, v.peep, v.tidalVolume, v.setRate, v.pressureSupport,
        v.inspiratoryPressure, v.inspiratoryTime, v.peakPressure, v.plateauPressure, v.totalRate, v.exhaledVt, v.minuteVentilation, v.spo2, v.cuffPressure,
        note, s.staffId, deviceTime(input.recordedAtDevice), s.deviceId,
      ],
    );
    return { id, duplicate: false };
  });
}

export async function voidVentSetting(s: Session, id: string, reason: string): Promise<void> {
  const why = reasonText(reason, 5);
  await as(s, async (c) => {
    const r = await c.query<{ recorded_by: string; voided_at: Date | null }>("SELECT recorded_by, voided_at FROM vent_setting WHERE id = $1 FOR UPDATE", [id]);
    const row = r.rows[0];
    if (!row || row.voided_at) throw new ClinicalError("NOT_FOUND", "Entry not found or already voided.");
    if (row.recorded_by !== s.staffId && s.role !== "CHIEF_RT_ADMIN")
      throw new ClinicalError("FORBIDDEN", "Only the RT who documented it, or the Chief RT, can void this entry.");
    await c.query("UPDATE vent_setting SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [id, s.staffId, why]);
  });
}

// ================================================================= tubing

export interface TubingInput {
  clientId: string;
  encounterId: string;
  installedAt: string;
  reason: string;
  recordedAtDevice: string | null;
}

export async function documentTubing(s: Session, input: TubingInput, source: CaptureSource = "ONLINE"): Promise<WriteResult> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document tubing replacements.");
  const id = requireClientId(input.clientId);
  const now = getNow();
  const why = reasonText(input.reason, 3);
  const installed = clinicalTime(input.installedAt, "Replacement time", now);
  return as(s, async (c) => {
    if (await existingById(c, "tubing_event", "performed_by", id, s)) return { id, duplicate: true };
    const e = await c.query<{ hooked_at: Date; disconnected_at: Date | null; last: Date | null }>(
      `SELECT e.hooked_at, e.disconnected_at,
              (SELECT max(installed_at) FROM tubing_event t WHERE t.encounter_id = e.id AND t.voided_at IS NULL) AS last
         FROM vent_encounter e WHERE e.id = $1`,
      [input.encounterId],
    );
    const enc = e.rows[0];
    if (!enc || enc.disconnected_at) throw new ClinicalError("INVALID", "Tubing can be documented only on an active ventilator encounter.");
    if (installed < new Date(enc.hooked_at)) throw new ClinicalError("INVALID", "Replacement cannot be before hook-in.");
    if (enc.last && installed <= new Date(enc.last)) throw new ClinicalError("INVALID", "Replacement must be after the last documented replacement.");
    const interval = await getSettingNumber(c, "tubing.interval_days", 7);
    await c.query(
      `INSERT INTO tubing_event (id, encounter_id, installed_at, interval_days, next_due_at, performed_by, reason, recorded_at_device, device_id, source)
       VALUES ($1, $2, $3, $4, $3, $5, $6, $7, $8, $9)`,
      [id, input.encounterId, installed, interval, s.staffId, why, deviceTime(input.recordedAtDevice), s.deviceId, source],
    );
    return { id, duplicate: false };
  });
}

export async function voidTubing(s: Session, id: string, reason: string): Promise<void> {
  const why = reasonText(reason, 5);
  await as(s, async (c) => {
    const r = await c.query<{ performed_by: string; voided_at: Date | null }>("SELECT performed_by, voided_at FROM tubing_event WHERE id = $1 FOR UPDATE", [
      id,
    ]);
    const row = r.rows[0];
    if (!row || row.voided_at) throw new ClinicalError("NOT_FOUND", "Entry not found or already voided.");
    if (row.performed_by !== s.staffId && s.role !== "CHIEF_RT_ADMIN")
      throw new ClinicalError("FORBIDDEN", "Only the RT who documented it, or the Chief RT, can void this entry.");
    await c.query("UPDATE tubing_event SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [id, s.staffId, why]);
  });
}

/** Workflows that may be captured offline (Milestone 7, interim policy U-03). Hook-in/disconnection stay online-only. */
export const OFFLINE_ELIGIBLE_WORKFLOWS = ["documentNebulization", "documentTubing"] as const;

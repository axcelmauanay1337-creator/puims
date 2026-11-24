import "server-only";
import { roleHas } from "@/lib/authz/permissions";
import { assessFromDue, DEFAULT_TUBING_POLICY, type TubingPolicy } from "@/lib/clinical/tubing";
import {
  NIV_DEVICES,
  OWN_SUPPLIES,
  PRECAUTIONS,
  EQUIPMENT_KINDS,
  type EquipmentKind,
  type NivDevice,
  type OwnSupply,
  type Precaution,
} from "@/lib/clinical/flags";
import type { DiagnosticService, DiagnosticStatus } from "@/lib/clinical/vocabulary";
import { classifyInstant, nextShift, operationalDayWindow, shiftWindow, type ShiftCode } from "@/lib/time/shifts";
import { HOSPITAL_TZ, calendarDateOf, formatTime, parseIsoDate, toLocalParts, zonedWallTimeToUtc, type IsoDate } from "@/lib/time/zoned";
import { ClinicalError } from "./clinical";
import { getNow } from "./clock";
import { audit, getSettingNumber, tx, type Tx } from "./db";
import { nebRows } from "./nebulization";
import type { Session } from "./session";

/**
 * The redesigned workspace (2026-11-23): Today's task list, patient flags (precautions,
 * own supplies, special endorsement), HFNC/NIV, the equipment board, machine charges,
 * alerts and census trends. Every function takes the session explicitly, checks the
 * permission in code and runs under RLS with the session's identity.
 */

function as<T>(s: Session, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PatientFlags {
  precautions: Precaution[];
  ownSupplies: OwnSupply[];
  endorsement: string | null;
}
export interface FlaggedPatient extends PatientFlags {
  id: string;
  name: string;
  hospitalId: string;
  wardRoom: string | null;
}

async function patientsById(c: Tx, ids: string[]): Promise<Map<string, FlaggedPatient>> {
  if (!ids.length) return new Map();
  const r = await c.query<{
    id: string;
    full_name: string;
    hospital_patient_id: string | null;
    ward_room: string | null;
    precautions: Precaution[];
    own_supplies: OwnSupply[];
    special_endorsement: string | null;
  }>("SELECT id, full_name, hospital_patient_id, ward_room, precautions, own_supplies, special_endorsement FROM patient WHERE id = ANY($1::uuid[])", [
    [...new Set(ids)],
  ]);
  return new Map(
    r.rows.map((p) => [
      p.id,
      {
        id: p.id,
        name: p.full_name,
        hospitalId: p.hospital_patient_id ?? "No hospital no.",
        wardRoom: p.ward_room,
        precautions: p.precautions,
        ownSupplies: p.own_supplies,
        endorsement: p.special_endorsement,
      },
    ]),
  );
}

// ================================================================= patient flags

export async function getPatientFlags(s: Session, patientId: string): Promise<PatientFlags | null> {
  if (!roleHas(s.role, "patients:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const p = (await patientsById(c, [patientId])).get(patientId);
    return p ? { precautions: p.precautions, ownSupplies: p.ownSupplies, endorsement: p.endorsement } : null;
  });
}

// ================================================================= MGH and stopping nebulization

/**
 * Marks a patient MGH ("may go home"). The database then discontinues all of the patient's active neb orders
 * (trigger patient_mgh_stop_nebs), so their doses leave the worklist, Today and alerts. Undo clears MGH only.
 */
export async function setPatientMgh(s: Session, patientId: string, mgh: boolean): Promise<{ stopped: number }> {
  if (!roleHas(s.role, "patients:write")) throw new ClinicalError("FORBIDDEN", "You cannot update patients.");
  if (!UUID_RE.test(patientId)) throw new ClinicalError("NOT_FOUND", "Patient not found.");
  return as(s, async (c) => {
    const before = await activeNebCount(c, patientId);
    const r = await c.query(
      mgh
        ? "UPDATE patient SET mgh_at = now(), mgh_by = $2, updated_by = $2 WHERE id = $1 AND voided_at IS NULL AND mgh_at IS NULL"
        : "UPDATE patient SET mgh_at = NULL, mgh_by = NULL, updated_by = $2 WHERE id = $1 AND voided_at IS NULL AND mgh_at IS NOT NULL",
      [patientId, s.staffId],
    );
    if (!r.rowCount) throw new ClinicalError("CONFLICT", mgh ? "This patient is already marked MGH." : "This patient is not marked MGH.");
    const stopped = mgh ? before - (await activeNebCount(c, patientId)) : 0;
    await audit(c, mgh ? "patient.mgh_set" : "patient.mgh_cleared", { neb_orders_discontinued: stopped }, { table: "patient", id: patientId });
    return { stopped };
  });
}

async function activeNebCount(c: Tx, patientId: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM neb_order WHERE patient_id = $1 AND discontinued_at IS NULL AND (end_at IS NULL OR end_at > now())",
    [patientId],
  );
  return r.rows[0].n;
}

/** Discontinues every active neb order of one patient at once, with one reason (RTs only, like single orders). */
export async function discontinueAllNebs(s: Session, patientId: string, reason: string): Promise<{ stopped: number }> {
  if (!roleHas(s.role, "orders:enter")) throw new ClinicalError("FORBIDDEN", "Only Respiratory Therapists discontinue nebulization orders.");
  if (!UUID_RE.test(patientId)) throw new ClinicalError("NOT_FOUND", "Patient not found.");
  const why = reason.trim().replace(/\s+/g, " ");
  if (why.length < 3 || why.length > 300) throw new ClinicalError("INVALID", "Give a reason (3–300 characters).");
  return as(s, async (c) => {
    const r = await c.query(
      `UPDATE neb_order SET discontinued_at = now(), discontinued_by = $2, discontinue_reason = $3
        WHERE patient_id = $1 AND discontinued_at IS NULL AND (end_at IS NULL OR end_at > now())`,
      [patientId, s.staffId, why],
    );
    if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "This patient has no active nebulization orders.");
    await audit(c, "neb_order.discontinued_all", { count: r.rowCount, reason: why }, { table: "patient", id: patientId });
    return { stopped: r.rowCount ?? 0 };
  });
}

export async function updatePatientFlags(s: Session, patientId: string, input: PatientFlags): Promise<void> {
  if (!roleHas(s.role, "patients:write")) throw new ClinicalError("FORBIDDEN", "You cannot update patients.");
  if (!UUID_RE.test(patientId)) throw new ClinicalError("NOT_FOUND", "Patient not found.");
  const precautions = [...new Set(input.precautions)];
  const own = [...new Set(input.ownSupplies)];
  if (precautions.some((x) => !(PRECAUTIONS as readonly string[]).includes(x))) throw new ClinicalError("INVALID", "Unknown precaution.");
  if (own.some((x) => !(OWN_SUPPLIES as readonly string[]).includes(x))) throw new ClinicalError("INVALID", "Unknown supply.");
  const endorsement = (input.endorsement ?? "").trim().replace(/[ \t]+/g, " ");
  if (endorsement.length > 1000) throw new ClinicalError("INVALID", "Special endorsement: at most 1,000 characters.");
  await as(s, async (c) => {
    const r = await c.query(
      `UPDATE patient SET precautions = $2, own_supplies = $3, special_endorsement = $4, updated_by = $5
        WHERE id = $1 AND voided_at IS NULL`,
      [patientId, precautions, own, endorsement || null, s.staffId],
    );
    if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "Patient not found.");
    await audit(c, "patient.flags_updated", { precautions, own_supplies: own, endorsement: !!endorsement }, { table: "patient", id: patientId });
  });
}

/** For forms opened from a patient's page: the patient already chosen. */
export async function patientBrief(s: Session, id: string | undefined) {
  if (!id || !UUID_RE.test(id) || !roleHas(s.role, "patients:read")) return null;
  return as(s, async (c) => {
    const p = (await patientsById(c, [id])).get(id);
    return p ? { id: p.id, title: p.name, subtitle: `${p.hospitalId}${p.wardRoom ? ` · ${p.wardRoom}` : ""}`, wardRoom: p.wardRoom } : null;
  });
}

// ================================================================= equipment

export interface EquipmentRow {
  id: string;
  code: string;
  kind: EquipmentKind;
  model: string;
  pmDueOn: IsoDate | null;
  pmDue: boolean;
  outOfService: boolean;
  rentedFrom: string | null;
  rentedSince: IsoDate | null;
  rentalRate: number | null;
  rentalDays: number | null;
  status: "IN_USE" | "AVAILABLE" | "PM_DUE" | "OUT_OF_SERVICE";
  assignedTo: { patientId: string; name: string; wardRoom: string | null; use: "VENTILATOR" | NivDevice } | null;
}

async function equipmentRows(c: Tx, now: Date): Promise<EquipmentRow[]> {
  const r = await c.query<{
    id: string;
    code: string;
    kind: EquipmentKind;
    model: string;
    pm_due_on: string | null;
    out_of_service: boolean;
    rented_from: string | null;
    rented_since: string | null;
    rental_rate: string | null;
    v_patient: string | null;
    n_patient: string | null;
    n_device: NivDevice | null;
    v_ward: string | null;
    n_ward: string | null;
  }>(
    `SELECT e.id, e.code, e.kind, e.model, e.pm_due_on::text, e.out_of_service, e.rented_from, e.rented_since::text, e.rental_rate::text,
            v.patient_id AS v_patient, v.ward_room AS v_ward, n.patient_id AS n_patient, n.device AS n_device, n.ward_room AS n_ward
       FROM equipment e
       LEFT JOIN vent_encounter v ON v.equipment_id = e.id AND v.disconnected_at IS NULL
       LEFT JOIN niv_encounter n ON n.equipment_id = e.id AND n.ended_at IS NULL
      WHERE e.retired_at IS NULL
      ORDER BY array_position(ARRAY['VENTILATOR','HFNC','BIPAP'], e.kind), e.code`,
  );
  const pats = await patientsById(
    c,
    r.rows.flatMap((x) => [x.v_patient, x.n_patient].filter(Boolean) as string[]),
  );
  const today = calendarDateOf(now);
  return r.rows.map((e) => {
    const pid = e.v_patient ?? e.n_patient;
    const p = pid ? pats.get(pid) : undefined;
    const pmDue = !!e.pm_due_on && e.pm_due_on <= today;
    const status: EquipmentRow["status"] = pid ? "IN_USE" : e.out_of_service ? "OUT_OF_SERVICE" : pmDue ? "PM_DUE" : "AVAILABLE";
    const since = e.rented_since;
    const days = since ? Math.max(1, Math.round((Date.parse(today) - Date.parse(since)) / 86_400_000) + 1) : null;
    return {
      id: e.id,
      code: e.code,
      kind: e.kind,
      model: e.model,
      pmDueOn: e.pm_due_on,
      pmDue,
      outOfService: e.out_of_service,
      rentedFrom: e.rented_from,
      rentedSince: since,
      rentalRate: e.rental_rate === null ? null : Number(e.rental_rate),
      rentalDays: e.rented_from ? days : null,
      status,
      assignedTo: p ? { patientId: p.id, name: p.name, wardRoom: e.v_ward ?? e.n_ward ?? p.wardRoom, use: e.v_patient ? "VENTILATOR" : e.n_device! } : null,
    };
  });
}

export async function listEquipment(s: Session): Promise<EquipmentRow[]> {
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, (c) => equipmentRows(c, getNow()));
}

export interface EquipmentInput {
  id?: string;
  code: string;
  kind: EquipmentKind;
  model: string;
  pmDueOn: string;
  outOfService: boolean;
  rentedFrom: string;
  rentedSince: string;
  rentalRate: string;
}

export async function saveEquipment(s: Session, input: EquipmentInput): Promise<{ id: string }> {
  if (!roleHas(s.role, "settings:manage")) throw new ClinicalError("FORBIDDEN", "Only the Chief RT can manage equipment.");
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) throw new ClinicalError("INVALID", "Code: 2–20 letters, digits or dashes (e.g. VENT-01).");
  if (!(EQUIPMENT_KINDS as readonly string[]).includes(input.kind)) throw new ClinicalError("INVALID", "Choose ventilator, HFNC or BiPAP.");
  const model = input.model.trim();
  if (!model || model.length > 60) throw new ClinicalError("INVALID", "Model is required (max 60 characters).");
  const date = (v: string, label: string) => {
    const t = v.trim();
    if (!t) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ClinicalError("INVALID", `${label}: use a date.`);
    return t;
  };
  const pm = date(input.pmDueOn, "PM due date");
  const rentedFrom = input.rentedFrom.trim() || null;
  if (rentedFrom && rentedFrom.length > 80) throw new ClinicalError("INVALID", "Vendor: max 80 characters.");
  const rate = rentedFrom && input.rentalRate.trim() ? Number(input.rentalRate) : null;
  if (rentedFrom && (rate === null || !Number.isFinite(rate) || rate < 0))
    throw new ClinicalError("INVALID", "Rental rate per day is required for a rented unit.");
  const since = rentedFrom ? date(input.rentedSince, "Rented since") : null;
  return as(s, async (c) => {
    try {
      if (input.id) {
        if (!UUID_RE.test(input.id)) throw new ClinicalError("NOT_FOUND", "Unit not found.");
        const r = await c.query(
          `UPDATE equipment SET code = $2, kind = $3, model = $4, pm_due_on = $5, out_of_service = $6, rented_from = $7, rented_since = $8,
                  rental_rate = $9, updated_at = now(), updated_by = $10 WHERE id = $1 AND retired_at IS NULL`,
          [input.id, code, input.kind, model, pm, !!input.outOfService, rentedFrom, since, rate, s.staffId],
        );
        if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "Unit not found.");
        return { id: input.id };
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO equipment (code, kind, model, pm_due_on, out_of_service, rented_from, rented_since, rental_rate, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [code, input.kind, model, pm, !!input.outOfService, rentedFrom, since, rate, s.staffId],
      );
      return { id: r.rows[0].id };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ClinicalError("CONFLICT", "That code is already used by another unit.");
      throw e;
    }
  });
}

/** Units of a kind that can be assigned now (not in use, not out of service, PM not due). */
export async function availableUnits(s: Session, kind: EquipmentKind) {
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) =>
    (await equipmentRows(c, getNow()))
      .filter((e) => e.kind === kind && e.status === "AVAILABLE")
      .map((e) => ({ id: e.id, code: e.code, model: e.model, rented: !!e.rentedFrom })),
  );
}

/** How many units of a kind are on the board (not retired). Once there is one, hook-in must pick from the board. */
export async function boardCount(c: Tx, kind: EquipmentKind): Promise<number> {
  const r = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM equipment WHERE kind = $1 AND retired_at IS NULL", [kind]);
  return r.rows[0].n;
}
export async function boardUnitCount(s: Session, kind: EquipmentKind): Promise<number> {
  if (!roleHas(s.role, "clinical:read")) return 0;
  return as(s, (c) => boardCount(c, kind));
}

/** Validates that a unit can be put on a patient now. Called inside the hook-in / NIV transaction. */
export async function assertUnitAssignable(c: Tx, equipmentId: string, kinds: EquipmentKind[]): Promise<{ code: string }> {
  if (!UUID_RE.test(equipmentId)) throw new ClinicalError("INVALID", "Choose a machine.");
  const r = await c.query<{ code: string; kind: EquipmentKind; out_of_service: boolean; pm_due: boolean; retired: boolean; busy: boolean }>(
    `SELECT e.code, e.kind, e.out_of_service, coalesce(e.pm_due_on <= (now() AT TIME ZONE '${HOSPITAL_TZ}')::date, false) AS pm_due, e.retired_at IS NOT NULL AS retired,
            EXISTS (SELECT 1 FROM vent_encounter v WHERE v.equipment_id = e.id AND v.disconnected_at IS NULL)
            OR EXISTS (SELECT 1 FROM niv_encounter n WHERE n.equipment_id = e.id AND n.ended_at IS NULL) AS busy
       FROM equipment e WHERE e.id = $1`,
    [equipmentId],
  );
  const e = r.rows[0];
  if (!e || e.retired) throw new ClinicalError("INVALID", "That machine is not on the equipment board.");
  if (!kinds.includes(e.kind)) throw new ClinicalError("INVALID", "That machine is the wrong type for this support.");
  if (e.busy) throw new ClinicalError("CONFLICT", `${e.code} is already on another patient.`);
  if (e.out_of_service) throw new ClinicalError("CONFLICT", `${e.code} is out of service.`);
  if (e.pm_due) throw new ClinicalError("CONFLICT", `${e.code} is due for preventive maintenance and cannot be assigned.`);
  return { code: e.code };
}

// ================================================================= HFNC / NIV

export interface NivRow {
  id: string;
  patient: FlaggedPatient;
  device: NivDevice;
  setting: string;
  spo2Target: string | null;
  equipment: { id: string; code: string; model: string } | null;
  wardRoom: string | null;
  startedIso: string;
  startedBy: string;
}

export async function listNiv(s: Session): Promise<NivRow[]> {
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const r = await c.query<{
      id: string;
      patient_id: string;
      device: NivDevice;
      setting: string;
      spo2_target: string | null;
      e_id: string | null;
      e_code: string | null;
      e_model: string | null;
      ward_room: string | null;
      started_at: Date;
      by: string | null;
    }>(
      `SELECT n.id, n.patient_id, n.device, n.setting, n.spo2_target, e.id AS e_id, e.code AS e_code, e.model AS e_model, n.ward_room, n.started_at,
              st.display_name AS by
         FROM niv_encounter n JOIN patient p ON p.id = n.patient_id LEFT JOIN equipment e ON e.id = n.equipment_id LEFT JOIN staff st ON st.id = n.started_by
        WHERE n.ended_at IS NULL AND p.voided_at IS NULL ORDER BY n.started_at`,
    );
    const pats = await patientsById(
      c,
      r.rows.map((x) => x.patient_id),
    );
    return r.rows.map((n) => ({
      id: n.id,
      patient: pats.get(n.patient_id)!,
      device: n.device,
      setting: n.setting,
      spo2Target: n.spo2_target,
      equipment: n.e_id ? { id: n.e_id, code: n.e_code!, model: n.e_model! } : null,
      wardRoom: n.ward_room ?? pats.get(n.patient_id)!.wardRoom,
      startedIso: iso(n.started_at)!,
      startedBy: n.by ?? "—",
    }));
  });
}

export interface NivInput {
  clientId: string;
  patientId: string;
  device: NivDevice;
  setting: string;
  spo2Target: string;
  equipmentId: string;
  wardRoom: string;
}

export async function startNiv(s: Session, input: NivInput): Promise<{ id: string; duplicate: boolean }> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document respiratory support.");
  if (!UUID_RE.test(input.clientId)) throw new ClinicalError("INVALID", "Missing or invalid client id.");
  if (!(NIV_DEVICES as readonly string[]).includes(input.device)) throw new ClinicalError("INVALID", "Choose HFNC, BiPAP or CPAP.");
  const setting = input.setting.trim();
  if (!setting || setting.length > 120) throw new ClinicalError("INVALID", "Setting is required (max 120 characters).");
  const spo2 = input.spo2Target.trim().slice(0, 20) || null;
  const ward = input.wardRoom.trim().slice(0, 60) || null;
  return as(s, async (c) => {
    const ex = await c.query<{ started_by: string }>("SELECT started_by FROM niv_encounter WHERE id = $1", [input.clientId]);
    if (ex.rowCount) {
      if (ex.rows[0].started_by !== s.staffId) throw new ClinicalError("CONFLICT", "This entry id is already in use.");
      return { id: input.clientId, duplicate: true };
    }
    const p = await c.query("SELECT 1 FROM patient WHERE id = $1 AND voided_at IS NULL", [input.patientId]);
    if (!p.rowCount) throw new ClinicalError("INVALID", "Select a patient.");
    let equipmentId: string | null = null;
    if (input.equipmentId) {
      await assertUnitAssignable(c, input.equipmentId, input.device === "HFNC" ? ["HFNC"] : ["BIPAP"]);
      equipmentId = input.equipmentId;
    }
    try {
      await c.query(
        `INSERT INTO niv_encounter (id, patient_id, device, setting, spo2_target, equipment_id, ward_room, started_at, started_by, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)`,
        [input.clientId, input.patientId, input.device, setting, spo2, equipmentId, ward, s.staffId, s.deviceId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") throw new ClinicalError("CONFLICT", "This patient is already on HFNC/NIV. End that first.");
      if ((e as { code?: string }).code === "23505") throw new ClinicalError("CONFLICT", "That machine is already on another patient.");
      throw e;
    }
    return { id: input.clientId, duplicate: false };
  });
}

export async function endNiv(s: Session, id: string, reason: string): Promise<void> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "You cannot document respiratory support.");
  if (!UUID_RE.test(id)) throw new ClinicalError("NOT_FOUND", "Not found.");
  const why = reason.trim().replace(/\s+/g, " ");
  if (why.length < 3 || why.length > 200) throw new ClinicalError("INVALID", "Give a reason (3–200 characters), e.g. weaned to nasal cannula.");
  await as(s, async (c) => {
    const r = await c.query("UPDATE niv_encounter SET ended_at = now(), ended_by = $2, end_reason = $3 WHERE id = $1 AND ended_at IS NULL", [
      id,
      s.staffId,
      why,
    ]);
    if (!r.rowCount) throw new ClinicalError("NOT_FOUND", "This HFNC/NIV is not running.");
  });
}

// ================================================================= charges (machines only)

export interface ChargeLine {
  description: string;
  qty: number;
  price: number;
  amount: number;
}
export interface ChargeGroup {
  patient: FlaggedPatient;
  lines: ChargeLine[];
  total: number;
  posted: { atIso: string; total: number } | null;
}

async function chargeGroups(c: Tx, date: IsoDate): Promise<ChargeGroup[]> {
  const { year, month, day } = parseIsoDate(date);
  const start = zonedWallTimeToUtc({ year, month, day });
  const end = new Date(start.getTime() + 86_400_000);
  const prices = {
    vent: await getSettingNumber(c, "charges.ventilator_per_day", 0),
    hfnc: await getSettingNumber(c, "charges.hfnc_per_day", 0),
    niv: await getSettingNumber(c, "charges.niv_per_day", 0),
  };
  const vents = await c.query<{ patient_id: string; code: string | null; ref: string; rented: boolean; rate: string | null }>(
    `SELECT v.patient_id, e.code, v.ventilator_ref AS ref, e.rented_from IS NOT NULL AS rented, e.rental_rate::text AS rate
       FROM vent_encounter v LEFT JOIN equipment e ON e.id = v.equipment_id
      WHERE v.hooked_at < $2 AND (v.disconnected_at IS NULL OR v.disconnected_at >= $1)`,
    [start, end],
  );
  const nivs = await c.query<{ patient_id: string; device: NivDevice; code: string | null }>(
    `SELECT n.patient_id, n.device, e.code FROM niv_encounter n LEFT JOIN equipment e ON e.id = n.equipment_id
      WHERE n.started_at < $2 AND (n.ended_at IS NULL OR n.ended_at >= $1)`,
    [start, end],
  );
  const lines = new Map<string, ChargeLine[]>();
  const add = (pid: string, l: Omit<ChargeLine, "amount">) => lines.set(pid, [...(lines.get(pid) ?? []), { ...l, amount: l.qty * l.price }]);
  for (const v of vents.rows) {
    if (v.rented) add(v.patient_id, { description: `Rented ventilator (${v.code}) · per day`, qty: 1, price: Number(v.rate) });
    else add(v.patient_id, { description: `Ventilator (${v.code ?? v.ref}) · per day`, qty: 1, price: prices.vent });
  }
  for (const n of nivs.rows) {
    const label = n.device === "HFNC" ? "HFNC" : n.device === "BIPAP" ? "BiPAP" : "CPAP";
    add(n.patient_id, {
      description: `${label} machine${n.code ? ` (${n.code})` : ""} · per day`,
      qty: 1,
      price: n.device === "HFNC" ? prices.hfnc : prices.niv,
    });
  }
  const posted = await c.query<{ patient_id: string; posted_at: Date; total: string }>(
    "SELECT patient_id, posted_at, total::text FROM charge_post WHERE charge_date = $1",
    [date],
  );
  const postedBy = new Map(posted.rows.map((p) => [p.patient_id, { atIso: iso(p.posted_at)!, total: Number(p.total) }]));
  const pats = await patientsById(c, [...lines.keys(), ...postedBy.keys()]);
  const ids = [...new Set([...lines.keys(), ...postedBy.keys()])];
  return ids
    .map((pid) => {
      const ls = lines.get(pid) ?? [];
      return { patient: pats.get(pid)!, lines: ls, total: ls.reduce((a, l) => a + l.amount, 0), posted: postedBy.get(pid) ?? null };
    })
    .filter((g) => g.patient)
    .sort((a, b) => a.patient.name.localeCompare(b.patient.name));
}

export async function getCharges(s: Session, date?: IsoDate) {
  if (!roleHas(s.role, "reports:unit")) throw new ClinicalError("FORBIDDEN", "Only the Chief RT can see charges.");
  const d = date ?? calendarDateOf(getNow());
  return as(s, async (c) => ({
    date: d,
    groups: await chargeGroups(c, d),
    prices: {
      ventilator: await getSettingNumber(c, "charges.ventilator_per_day", 0),
      hfnc: await getSettingNumber(c, "charges.hfnc_per_day", 0),
      niv: await getSettingNumber(c, "charges.niv_per_day", 0),
    },
  }));
}

export async function postCharges(s: Session, date: IsoDate, patientIds: string[]): Promise<{ posted: number }> {
  if (!roleHas(s.role, "reports:unit")) throw new ClinicalError("FORBIDDEN", "Only the Chief RT can post charges.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ClinicalError("INVALID", "Invalid date.");
  return as(s, async (c) => {
    const groups = await chargeGroups(c, date);
    let posted = 0;
    for (const g of groups) {
      if (g.posted || !g.lines.length || !patientIds.includes(g.patient.id)) continue;
      await c.query("INSERT INTO charge_post (patient_id, charge_date, lines, total, posted_by) VALUES ($1, $2, $3, $4, $5)", [
        g.patient.id,
        date,
        JSON.stringify(g.lines),
        g.total,
        s.staffId,
      ]);
      posted++;
    }
    await audit(c, "charges.posted", { date, patients: posted });
    return { posted };
  });
}

// ================================================================= Today (task list) and alerts

export interface TodayTask {
  key: string;
  kind: "NEB" | "TUBE" | "TEST";
  title: string;
  patient: FlaggedPatient;
  dueIso: string;
  whenLabel: string;
  tone: "danger" | "warning" | "info";
  href: string;
  /** For a neb dose: the order + slot the documentation dialog needs. */
  neb?: { orderId: string; orderReference: string; scheduledIso: string; medication: string };
  encounterId?: string;
  ventilatorRef?: string;
}

function minutesLate(due: Date, now: Date): number {
  return Math.round((now.getTime() - due.getTime()) / 60_000);
}
function lateLabel(due: Date, now: Date): string {
  const m = minutesLate(due, now);
  if (m < 60) return `${formatTime(due)} · ${m} min late`;
  const h = Math.floor(m / 60);
  return `${formatTime(due)} · ${h} h late`;
}

async function tubingPolicy(c: Tx): Promise<TubingPolicy> {
  return {
    intervalDays: await getSettingNumber(c, "tubing.interval_days", DEFAULT_TUBING_POLICY.intervalDays),
    upcomingWindowHours: await getSettingNumber(c, "tubing.upcoming_window_hours", DEFAULT_TUBING_POLICY.upcomingWindowHours),
  };
}

async function buildToday(c: Tx, now: Date) {
  const k = classifyInstant(now);
  const shift = shiftWindow(k.operationalDate, k.shift);
  const day = operationalDayWindow(k.operationalDate);
  // Doses from the start of the operational day (so earlier misses stay visible) to the end of this shift.
  const neb = await nebRows(c, { start: day.start, end: shift.end }, now);
  const tub = await c.query<{ encounter_id: string; patient_id: string; ref: string; ward: string; next_due_at: Date | null }>(
    `SELECT e.id AS encounter_id, e.patient_id, e.ventilator_ref AS ref, e.ward_room AS ward,
            (SELECT t.next_due_at FROM tubing_event t WHERE t.encounter_id = e.id AND t.voided_at IS NULL ORDER BY t.installed_at DESC LIMIT 1) AS next_due_at
       FROM vent_encounter e JOIN patient p ON p.id = e.patient_id WHERE e.disconnected_at IS NULL AND p.voided_at IS NULL`,
  );
  const dx = await c.query<{
    id: string;
    patient_id: string;
    service: DiagnosticService;
    scheduled_at: Date;
    status: DiagnosticStatus;
    procedure_label: string;
  }>(
    `SELECT id, patient_id, service, scheduled_at, status, procedure_label FROM diagnostic_appointment
      WHERE voided_at IS NULL AND status IN ('SCHEDULED','PENDING') AND scheduled_at >= $1 AND scheduled_at < $2 ORDER BY scheduled_at`,
    [day.start, shift.end],
  );
  const pats = await patientsById(c, [...neb.map((n) => n.patient.id), ...tub.rows.map((t) => t.patient_id), ...dx.rows.map((d) => d.patient_id)]);
  const policy = await tubingPolicy(c);
  const open: TodayTask[] = [];
  const done: Array<{ key: string; title: string; patient: FlaggedPatient; status: string; atIso: string; by: string | null }> = [];
  for (const n of neb) {
    const p = pats.get(n.patient.id);
    if (!p) continue;
    if (n.documented) {
      if (n.performedById && (n.actualIso ?? n.scheduledIso)! >= shift.start.toISOString())
        done.push({ key: n.key, title: n.medication, patient: p, status: n.status, atIso: (n.actualIso ?? n.scheduledIso)!, by: n.performedBy });
      continue;
    }
    const due = new Date(n.scheduledIso!);
    const late = due.getTime() <= now.getTime();
    open.push({
      key: `neb:${n.key}`,
      kind: "NEB",
      title: n.medication,
      patient: p,
      dueIso: n.scheduledIso!,
      whenLabel: late ? lateLabel(due, now) : formatTime(due),
      tone: late ? "danger" : due.getTime() - now.getTime() < 60 * 60_000 ? "warning" : "info",
      href: "/nebulization",
      neb: { orderId: n.orderId, orderReference: n.orderReference, scheduledIso: n.scheduledIso!, medication: n.medication },
    });
  }
  for (const t of tub.rows) {
    const p = pats.get(t.patient_id);
    if (!p) continue;
    const a = assessFromDue(t.next_due_at ? new Date(t.next_due_at) : null, now, policy);
    if (a.status === "CURRENT" || a.status === "UPCOMING") continue;
    if (a.status !== "NO_RECORD" && a.nextDueAt && a.nextDueAt.getTime() > shift.end.getTime()) continue;
    open.push({
      key: `tube:${t.encounter_id}`,
      kind: "TUBE",
      title: a.status === "NO_RECORD" ? "Change of tubing (no record)" : "Change of tubing",
      patient: p,
      dueIso: (a.nextDueAt ?? now).toISOString(),
      whenLabel:
        a.status === "NO_RECORD"
          ? "No record"
          : a.status === "OVERDUE"
            ? `Overdue ${Math.max(1, Math.round(-(a.msUntilDue ?? 0) / 3_600_000))} h`
            : `Due ${formatTime(a.nextDueAt!)}`,
      tone: a.status === "DUE" ? "warning" : "danger",
      href: "/tubing",
      encounterId: t.encounter_id,
      ventilatorRef: t.ref,
    });
  }
  for (const d of dx.rows) {
    const p = pats.get(d.patient_id);
    if (!p) continue;
    const due = new Date(d.scheduled_at);
    const late = due.getTime() <= now.getTime();
    open.push({
      key: `test:${d.id}`,
      kind: "TEST",
      title: d.service === "SPUTUM_INDUCTION" ? "Sputum induction" : d.service === "ABG" ? "ABG" : d.procedure_label,
      patient: p,
      dueIso: due.toISOString(),
      whenLabel: late ? lateLabel(due, now) : formatTime(due),
      tone: late ? "danger" : "info",
      href: `/diagnostics/appointments/${d.id}`,
    });
  }
  open.sort((a, b) => a.dueIso.localeCompare(b.dueIso));
  const soon = now.getTime() + 30 * 60_000;
  return {
    k,
    shiftEndIso: shift.end.toISOString(),
    nextShift: nextShift(k.operationalDate, k.shift),
    dueNow: open.filter((t) => t.kind === "TUBE" || new Date(t.dueIso).getTime() <= soon),
    later: open.filter((t) => t.kind !== "TUBE" && new Date(t.dueIso).getTime() > soon),
    done: done.sort((a, b) => b.atIso.localeCompare(a.atIso)),
  };
}

export async function getToday(s: Session) {
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  return as(s, async (c) => {
    const now = getNow();
    const t = await buildToday(c, now);
    const ho = await c.query<{ id: string; shift: ShiftCode; operational_date: string; outgoing: string; outgoing_id: string; items: number }>(
      `SELECT h.id, h.shift, h.operational_date::text, s.display_name AS outgoing, h.outgoing_staff_id AS outgoing_id,
              (SELECT count(*)::int FROM handover_item i WHERE i.handover_id = h.id) AS items
         FROM shift_handover h JOIN staff s ON s.id = h.outgoing_staff_id WHERE h.acknowledged_at IS NULL
        ORDER BY h.operational_date DESC, array_position(ARRAY['NIGHT','AFTERNOON','MORNING'], h.shift) LIMIT 1`,
    );
    const h = ho.rows[0];
    return {
      nowIso: now.toISOString(),
      operationalDate: t.k.operationalDate,
      shift: t.k.shift,
      shiftEndIso: t.shiftEndIso,
      dueNow: t.dueNow,
      later: t.later,
      done: t.done,
      pendingHandover:
        h && h.outgoing_id !== s.staffId ? { id: h.id, shift: h.shift, operationalDate: h.operational_date, outgoing: h.outgoing, items: h.items } : null,
    };
  });
}

export interface AlertItem {
  id: string;
  severity: "danger" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
}

/** Alerts for the bell. Names are kept out of the bell preview; details are on the linked page. */
export async function getAlerts(s: Session): Promise<AlertItem[]> {
  if (!roleHas(s.role, "notifications:read")) return [];
  return as(s, async (c) => {
    const now = getNow();
    const t = await buildToday(c, now);
    const items: AlertItem[] = [];
    for (const x of [...t.dueNow, ...t.later]) {
      if (x.kind === "NEB" && new Date(x.dueIso).getTime() < now.getTime())
        items.push({
          id: x.key,
          severity: "danger",
          title: "Neb dose overdue",
          detail: `${x.patient.wardRoom ?? "—"} · ${x.whenLabel}`,
          href: "/nebulization",
        });
      if (x.kind === "TUBE" && x.tone === "danger")
        items.push({ id: x.key, severity: "danger", title: "Tubing change overdue", detail: `${x.patient.wardRoom ?? "—"} · ${x.whenLabel}`, href: "/tubing" });
      if (x.kind === "TEST") {
        const mins = (new Date(x.dueIso).getTime() - now.getTime()) / 60_000;
        if (mins >= 0 && mins <= 60)
          items.push({
            id: x.key,
            severity: "info",
            title: `${x.title} within the hour`,
            detail: `${formatTime(new Date(x.dueIso))} · ${x.patient.wardRoom ?? "—"}`,
            href: x.href,
          });
      }
    }
    const ho = await c.query<{ id: string; operational_date: string; shift: string }>(
      "SELECT id, operational_date::text, shift FROM shift_handover WHERE acknowledged_at IS NULL ORDER BY operational_date DESC",
    );
    for (const h of ho.rows)
      items.push({
        id: `ho-${h.id}`,
        severity: "warning",
        title: "Handover not acknowledged",
        detail: `${h.operational_date} · ${h.shift.toLowerCase()} shift`,
        href: "/handover",
      });
    const eq = await equipmentRows(c, now);
    for (const e of eq.filter((x) => x.status === "PM_DUE"))
      items.push({ id: `pm-${e.id}`, severity: "warning", title: "Equipment PM due", detail: `${e.code} · ${e.model} · ${e.pmDueOn}`, href: "/equipment" });
    if (eq.length)
      for (const kind of EQUIPMENT_KINDS)
        if (eq.some((e) => e.kind === kind) && !eq.some((e) => e.kind === kind && e.status === "AVAILABLE"))
          items.push({
            id: `free-${kind}`,
            severity: "warning",
            title: `No free ${kind === "VENTILATOR" ? "ventilator" : kind === "HFNC" ? "HFNC" : "BiPAP"}`,
            detail: "All units are in use or out of service",
            href: "/equipment",
          });
    return items;
  });
}

// ================================================================= census trends

export async function getTrends(s: Session, year?: number) {
  if (!roleHas(s.role, "clinical:read")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  const y = year ?? toLocalParts(getNow()).year;
  return as(s, async (c) => {
    const q = async (sql: string) => {
      const r = await c.query<{ m: number; n: number }>(sql, [y, HOSPITAL_TZ]);
      return Array.from({ length: 12 }, (_, i) => r.rows.find((x) => x.m === i + 1)?.n ?? 0);
    };
    const neb = await q(`SELECT extract(month FROM coalesce(actual_at, scheduled_at) AT TIME ZONE $2)::int AS m, count(DISTINCT patient_id)::int AS n
                           FROM neb_administration WHERE voided_at IS NULL AND extract(year FROM coalesce(actual_at, scheduled_at) AT TIME ZONE $2) = $1 GROUP BY 1`);
    const vent = await q(`SELECT m, count(DISTINCT patient_id)::int AS n FROM (
                            SELECT patient_id, generate_series(date_trunc('month', hooked_at AT TIME ZONE $2), date_trunc('month', coalesce(disconnected_at, now()) AT TIME ZONE $2), interval '1 month') AS mo
                              FROM vent_encounter) x, LATERAL (SELECT extract(month FROM mo)::int AS m) mm
                           WHERE extract(year FROM mo) = $1 GROUP BY m`);
    const niv = await q(`SELECT m, count(DISTINCT patient_id)::int AS n FROM (
                           SELECT patient_id, generate_series(date_trunc('month', started_at AT TIME ZONE $2), date_trunc('month', coalesce(ended_at, now()) AT TIME ZONE $2), interval '1 month') AS mo
                             FROM niv_encounter) x, LATERAL (SELECT extract(month FROM mo)::int AS m) mm
                          WHERE extract(year FROM mo) = $1 GROUP BY m`);
    const dx = await q(`SELECT extract(month FROM scheduled_at AT TIME ZONE $2)::int AS m, count(*)::int AS n FROM diagnostic_appointment
                         WHERE voided_at IS NULL AND status = 'COMPLETED' AND extract(year FROM scheduled_at AT TIME ZONE $2) = $1 GROUP BY 1`);
    const all = await q(`SELECT m, count(DISTINCT patient_id)::int AS n FROM (
                           SELECT patient_id, extract(month FROM occurred_at AT TIME ZONE $2)::int AS m FROM service_event_v
                            WHERE extract(year FROM occurred_at AT TIME ZONE $2) = $1
                           UNION ALL
                           SELECT patient_id, extract(month FROM started_at AT TIME ZONE $2)::int FROM niv_encounter WHERE extract(year FROM started_at AT TIME ZONE $2) = $1
                         ) x GROUP BY m`);
    return { year: y, series: { all, neb, vent, niv, dx } };
  });
}

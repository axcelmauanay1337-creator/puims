import "server-only";
import type { Permission } from "@/lib/authz/permissions";
import { assessFromDue, DEFAULT_TUBING_POLICY, type TubingPolicy, type TubingStatus } from "@/lib/clinical/tubing";
import { SERVICE_LABELS, type DiagnosticService, type DiagnosticStatus, type PatientCategory, type ServiceType } from "@/lib/clinical/vocabulary";
import type { ActivityEvent, HandoverItemRef } from "@/lib/domain/types";
import type { VentSettingView } from "@/components/tables/ModuleTables";
import { COMPLETED_ACTIVITY_STATUSES, countBy, eventsByShift, serviceCounts, uniquePatientsServed, type Window } from "@/lib/metrics/metrics";
import { SHIFT_ORDER, classifyInstant, operationalDayWindow, shiftWindow, type ShiftCode } from "@/lib/time/shifts";
import { HOSPITAL_TZ, type IsoDate, addDays, calendarDayWindow, toLocalParts } from "@/lib/time/zoned";
import { getNow } from "./clock";
import { nebRows, type NebRow } from "./nebulization";
import { audit, getSettingNumber, tx, type Tx } from "./db";
import { requirePermission, type Session } from "./session";

/**
 * Data-access layer (PostgreSQL). Every function:
 *   1. checks the caller's permission in application code (requirePermission),
 *   2. runs in a transaction carrying the session identity, so PostgreSQL RLS
 *      independently enforces access (a revoked/expired session sees nothing),
 *   3. returns plain, serializable view models.
 */

async function run<T>(permission: Permission, fn: (c: Tx, s: Session) => Promise<T>): Promise<T> {
  const s = await requirePermission(permission);
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, (c) => fn(c, s));
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export interface PatientRef {
  id: string;
  name: string;
  hospitalId: string;
  category: PatientCategory;
  wardRoom: string | null;
}

// Selects the columns needed for a PatientRef from the given table alias.
const P = (a: string) => `${a}.id AS p_id, ${a}.full_name AS p_name, ${a}.hospital_patient_id AS p_hid, ${a}.category AS p_cat, ${a}.ward_room AS p_ward`;
interface PRow {
  p_id: string;
  p_name: string;
  p_hid: string | null;
  p_cat: PatientCategory;
  p_ward: string | null;
}
const pref = (r: PRow): PatientRef => ({ id: r.p_id, name: r.p_name, hospitalId: r.p_hid ?? "No hospital no.", category: r.p_cat, wardRoom: r.p_ward });

async function tubingPolicy(c: Tx): Promise<TubingPolicy> {
  return {
    intervalDays: await getSettingNumber(c, "tubing.interval_days", DEFAULT_TUBING_POLICY.intervalDays),
    upcomingWindowHours: await getSettingNumber(c, "tubing.upcoming_window_hours", DEFAULT_TUBING_POLICY.upcomingWindowHours),
  };
}

// ----------------------------------------------------------------- shift context

export async function getShiftContext() {
  return run("shifts:read", async (c, s) => {
    const now = getNow();
    const k = classifyInstant(now);
    const r = await c.query<{ id: string; name: string }>(
      "SELECT s.id, s.display_name AS name FROM shift_assignment a JOIN staff s ON s.id = a.staff_id WHERE a.operational_date = $1 AND a.shift = $2 AND a.removed_at IS NULL ORDER BY s.display_name",
      [k.operationalDate, k.shift],
    );
    const w = shiftWindow(k.operationalDate, k.shift);
    return {
      nowIso: now.toISOString(),
      ...k,
      shiftStartIso: w.start.toISOString(),
      shiftEndIso: w.end.toISOString(),
      onDuty: r.rows,
      iAmOnDuty: r.rows.some((o) => o.id === s.staffId),
    };
  });
}

// ----------------------------------------------------------------- tubing / ventilation

export interface TubingRow {
  encounterId: string;
  patient: PatientRef;
  ventilatorRef: string;
  wardRoom: string;
  lastInstalledIso: string | null;
  nextDueIso: string | null;
  msUntilDue: number | null;
  status: TubingStatus;
  /** Newest first; voided entries kept (marked) but never count towards the due date. */
  history: Array<{ id: string; installedIso: string; by: string; byId: string; reason: string; voided: boolean; voidReason: string | null }>;
}

type HistJson = Array<{
  id: string;
  installed_at: string;
  next_due_at: string;
  by: string | null;
  by_id: string;
  reason: string;
  voided: boolean;
  void_reason: string | null;
}>;

async function tubingRows(c: Tx, now: Date, policy: TubingPolicy, patientId?: string): Promise<TubingRow[]> {
  const r = await c.query<PRow & { encounter_id: string; ventilator_ref: string; ward_room: string; history: HistJson }>(
    `SELECT e.id AS encounter_id, e.ventilator_ref, e.ward_room, ${P("p")},
            coalesce(json_agg(json_build_object('id', t.id, 'installed_at', t.installed_at, 'next_due_at', t.next_due_at, 'by', st.display_name, 'by_id', t.performed_by, 'reason', t.reason, 'voided', t.voided_at IS NOT NULL, 'void_reason', t.void_reason)
                     ORDER BY t.installed_at DESC) FILTER (WHERE t.id IS NOT NULL), '[]') AS history
       FROM vent_encounter e
       JOIN patient p ON p.id = e.patient_id
       LEFT JOIN tubing_event t ON t.encounter_id = e.id
       LEFT JOIN staff st ON st.id = t.performed_by
      WHERE e.disconnected_at IS NULL AND ($1::uuid IS NULL OR e.patient_id = $1)
      GROUP BY e.id, p.id`,
    [patientId ?? null],
  );
  const order: Record<TubingStatus, number> = { OVERDUE: 0, NO_RECORD: 1, DUE: 2, UPCOMING: 3, CURRENT: 4 };
  return r.rows
    .map((row) => {
      const last = row.history.find((h) => !h.voided);
      const a = assessFromDue(last ? new Date(last.next_due_at) : null, now, policy);
      return {
        encounterId: row.encounter_id,
        patient: pref(row),
        ventilatorRef: row.ventilator_ref,
        wardRoom: row.ward_room,
        lastInstalledIso: last ? iso(last.installed_at) : null,
        nextDueIso: a.nextDueAt?.toISOString() ?? null,
        msUntilDue: a.msUntilDue,
        status: a.status,
        history: row.history.map((h) => ({
          id: h.id,
          installedIso: iso(h.installed_at)!,
          by: h.by ?? "—",
          byId: h.by_id,
          reason: h.reason,
          voided: h.voided,
          voidReason: h.void_reason,
        })),
      };
    })
    .sort((x, y) => order[x.status] - order[y.status] || (x.msUntilDue ?? 0) - (y.msUntilDue ?? 0));
}

export async function listTubing() {
  return run("clinical:read", async (c) => {
    const policy = await tubingPolicy(c);
    return { rows: await tubingRows(c, getNow(), policy), policy };
  });
}

export async function listVentilation() {
  return run("clinical:read", async (c) => {
    const tub = new Map((await tubingRows(c, getNow(), await tubingPolicy(c))).map((t) => [t.encounterId, t.status]));
    const r = await c.query<
      PRow & {
        id: string;
        hooked_at: Date;
        disconnected_at: Date | null;
        ventilator_ref: string;
        ward_room: string;
        responsible: string | null;
        status: "ACTIVE" | "DISCONTINUED";
        airway_type: string | null;
        airway_size: string | null;
        airway_position: string | null;
        disconnect_reason: string | null;
        disconnect_note: string | null;
      }
    >(
      `SELECT e.id, e.hooked_at, e.disconnected_at, e.ventilator_ref, e.ward_room, e.status, st.display_name AS responsible,
              e.airway_type, e.airway_size, e.airway_position, e.disconnect_reason, e.disconnect_note, ${P("p")}
         FROM vent_encounter e JOIN patient p ON p.id = e.patient_id LEFT JOIN staff st ON st.id = e.responsible_staff_id
        ORDER BY (e.disconnected_at IS NULL) DESC, e.hooked_at DESC`,
    );
    const ids = r.rows.map((e) => e.id);
    const settings = ids.length
      ? (
          await c.query<{
            id: string;
            encounter_id: string;
            recorded_at: Date;
            mode: string;
            mode_other: string | null;
            note: string | null;
            by_id: string;
            by: string | null;
            voided_at: Date | null;
            void_reason: string | null;
            v: Record<string, string | number | null>;
          }>(
            `SELECT s.id, s.encounter_id, s.recorded_at, s.mode, s.mode_other, s.note, s.recorded_by AS by_id, st.display_name AS by,
                    s.voided_at, s.void_reason,
                    jsonb_build_object('fio2', s.fio2, 'peep', s.peep, 'tidalVolume', s.tidal_volume, 'setRate', s.set_rate,
                      'pressureSupport', s.pressure_support, 'inspiratoryPressure', s.inspiratory_pressure, 'inspiratoryTime', s.inspiratory_time,
                      'peakPressure', s.peak_pressure, 'plateauPressure', s.plateau_pressure, 'totalRate', s.total_rate, 'exhaledVt', s.exhaled_vt,
                      'minuteVentilation', s.minute_ventilation, 'spo2', s.spo2, 'cuffPressure', s.cuff_pressure) AS v
               FROM vent_setting s LEFT JOIN staff st ON st.id = s.recorded_by
              WHERE s.encounter_id = ANY($1::uuid[])
              ORDER BY s.recorded_at DESC`,
            [ids],
          )
        ).rows
      : [];
    const byEnc = new Map<string, VentSettingView[]>();
    for (const x of settings) {
      const list = byEnc.get(x.encounter_id) ?? [];
      list.push({
        id: x.id,
        atIso: iso(x.recorded_at)!,
        mode: x.mode,
        modeOther: x.mode_other,
        values: Object.fromEntries(Object.entries(x.v).filter(([, val]) => val !== null).map(([k, val]) => [k, Number(val)])),
        note: x.note,
        by: x.by ?? "—",
        byId: x.by_id,
        voided: !!x.voided_at,
        voidReason: x.void_reason,
      });
      byEnc.set(x.encounter_id, list);
    }
    return r.rows.map((e) => ({
      id: e.id,
      patient: pref(e),
      hookedIso: iso(e.hooked_at)!,
      disconnectedIso: iso(e.disconnected_at),
      ventilatorRef: e.ventilator_ref,
      wardRoom: e.ward_room,
      responsible: e.responsible ?? "—",
      status: e.status,
      tubingStatus: tub.get(e.id) ?? null,
      airway: { type: e.airway_type, size: e.airway_size, position: e.airway_position },
      disconnectReason: e.disconnect_reason,
      disconnectNote: e.disconnect_note,
      settings: byEnc.get(e.id) ?? [],
    }));
  });
}

// ----------------------------------------------------------------- nebulization

export async function listNebulization(operationalDate?: IsoDate) {
  return run("clinical:read", async (c) => {
    const now = getNow();
    const date = operationalDate ?? classifyInstant(now).operationalDate;
    const rows: NebRow[] = await nebRows(c, operationalDayWindow(date), now);
    const o = await c.query<
      PRow & {
        id: string;
        order_reference: string;
        medication: string;
        frequency: string;
        prescribed_times: string[];
        prescriber: string;
        start_at: Date;
        end_at: Date | null;
        entered_by: string | null;
      }
    >(
      `SELECT o.id, o.order_reference, o.medication_as_ordered AS medication, o.frequency, o.prescribed_times::text[] AS prescribed_times, o.prescriber,
              o.start_at, o.end_at, st.display_name AS entered_by, ${P("p")}
         FROM neb_order o JOIN patient p ON p.id = o.patient_id LEFT JOIN staff st ON st.id = o.entered_by
        WHERE o.discontinued_at IS NULL AND (o.end_at IS NULL OR o.end_at > $1) AND p.voided_at IS NULL ORDER BY o.order_reference`,
      [now],
    );
    return {
      operationalDate: date,
      rows,
      activeOrders: o.rows.map((x) => ({
        id: x.id,
        patient: pref(x),
        orderReference: x.order_reference,
        medication: x.medication,
        frequency: x.frequency,
        prescribedTimes: x.prescribed_times.map((t) => t.slice(0, 5)),
        prescriber: x.prescriber,
        startIso: iso(x.start_at)!,
        endIso: iso(x.end_at),
        enteredBy: x.entered_by ?? "—",
      })),
      counts: countBy(rows, (x) => x.status),
    };
  });
}

// ----------------------------------------------------------------- diagnostics

async function todaysDiagnostics(c: Tx, now: Date) {
  const w = operationalDayWindow(classifyInstant(now).operationalDate);
  const r = await c.query<PRow & { id: string; service: DiagnosticService; scheduled_at: Date; status: DiagnosticStatus; procedure_label: string }>(
    `SELECT d.id, d.service, d.scheduled_at, d.status, d.procedure_label, ${P("p")}
       FROM diagnostic_appointment d JOIN patient p ON p.id = d.patient_id
      WHERE d.scheduled_at >= $1 AND d.scheduled_at < $2 AND d.voided_at IS NULL ORDER BY d.scheduled_at`,
    [w.start, w.end],
  );
  return r.rows.map((d) => ({
    id: d.id,
    service: d.service,
    scheduledIso: iso(d.scheduled_at)!,
    status: d.status,
    patient: pref(d),
    procedureLabel: d.procedure_label,
  }));
}

// ----------------------------------------------------------------- handover

export interface HandoverItemView extends HandoverItemRef {
  /** Live status of the referenced record right now (items are references, not copies). */
  liveStatus: string;
  patient: string | null;
}

export async function getHandoverBoard() {
  return run("shifts:read", async (c) => {
    const now = getNow();
    const policy = await tubingPolicy(c);
    const r = await c.query<{
      id: string;
      operational_date: string;
      shift: ShiftCode;
      outgoing_id: string;
      outgoing: string;
      incoming: string | null;
      acknowledged_by: string | null;
      equipment_concerns: string | null;
      notes: string;
      created_at: Date;
      acknowledged_at: Date | null;
      items: Array<
        HandoverItemRef & {
          vent: string | null;
          neb: string | null;
          dx: string | null;
          next_due: string | null;
          patient: string | null;
          slot_at: string | null;
          order_off: boolean;
          slot_doc: string | null;
        }
      >;
    }>(
      `SELECT h.id, h.operational_date, h.shift, h.outgoing_staff_id AS outgoing_id, o.display_name AS outgoing, i.display_name AS incoming,
              ab.display_name AS acknowledged_by, h.equipment_concerns, h.notes, h.created_at, h.acknowledged_at,
              coalesce((SELECT json_agg(json_build_object(
                  'kind', x.kind, 'refId', x.ref_id, 'summary', x.summary,
                  'vent', ve.status, 'neb', na.status, 'dx', da.status,
                  'next_due', (SELECT t.next_due_at FROM tubing_event t WHERE t.encounter_id = ve.id AND t.voided_at IS NULL ORDER BY t.installed_at DESC LIMIT 1),
                  'slot_at', x.slot_at,
                  'order_off', no.discontinued_at IS NOT NULL OR (no.end_at IS NOT NULL AND no.end_at <= x.slot_at),
                  'slot_doc', (SELECT a.status FROM neb_administration a WHERE x.kind = 'NEBULIZATION_ORDER' AND a.order_id = x.ref_id AND a.scheduled_at = x.slot_at AND a.voided_at IS NULL),
                  'patient', coalesce(pv.full_name, pn.full_name, po.full_name, pd.full_name)) ORDER BY x.kind, x.slot_at, x.summary)
                FROM handover_item x
                LEFT JOIN vent_encounter ve ON x.kind IN ('VENTILATOR_ENCOUNTER', 'TUBING') AND ve.id = x.ref_id
                LEFT JOIN patient pv ON pv.id = ve.patient_id
                LEFT JOIN neb_administration na ON x.kind = 'NEBULIZATION_ADMIN' AND na.id = x.ref_id
                LEFT JOIN patient pn ON pn.id = na.patient_id
                LEFT JOIN neb_order no ON x.kind = 'NEBULIZATION_ORDER' AND no.id = x.ref_id
                LEFT JOIN patient po ON po.id = no.patient_id
                LEFT JOIN diagnostic_appointment da ON x.kind = 'DIAGNOSTIC' AND da.id = x.ref_id
                LEFT JOIN patient pd ON pd.id = da.patient_id
               WHERE x.handover_id = h.id), '[]') AS items
         FROM shift_handover h JOIN staff o ON o.id = h.outgoing_staff_id
         LEFT JOIN staff i ON i.id = h.incoming_staff_id LEFT JOIN staff ab ON ab.id = h.acknowledged_by
        ORDER BY h.operational_date DESC, array_position(ARRAY['NIGHT','AFTERNOON','MORNING'], h.shift) LIMIT 9`,
    );
    return r.rows.map((h) => ({
      id: h.id,
      operationalDate: h.operational_date,
      shift: h.shift,
      outgoingId: h.outgoing_id,
      outgoing: h.outgoing,
      incoming: h.incoming ?? "—",
      acknowledgedBy: h.acknowledged_by,
      pendingItems: h.items.map(
        (x): HandoverItemView => ({
          kind: x.kind,
          refId: x.refId,
          summary: x.summary,
          patient: x.patient,
          liveStatus:
            x.kind === "NEBULIZATION_ORDER"
              ? (x.slot_doc ?? (x.order_off ? "CANCELLED" : x.slot_at && new Date(x.slot_at) > now ? "SCHEDULED" : "PENDING"))
              : x.kind === "TUBING"
                ? x.vent === "DISCONTINUED"
                  ? "DISCONTINUED"
                  : assessFromDue(x.next_due ? new Date(x.next_due) : null, now, policy).status
                : ((x.kind === "VENTILATOR_ENCOUNTER" ? x.vent : x.kind === "NEBULIZATION_ADMIN" ? x.neb : x.dx) ?? "UNKNOWN"),
        }),
      ),
      equipmentConcerns: h.equipment_concerns,
      notes: h.notes,
      createdIso: iso(h.created_at)!,
      acknowledgedIso: iso(h.acknowledged_at),
    }));
  });
}

// ----------------------------------------------------------------- patients

function ageFrom(dob: IsoDate | null, now: Date): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const n = toLocalParts(now);
  let age = n.year - y;
  if (n.month < m || (n.month === m && n.day < d)) age--;
  return age;
}

export async function listPatients() {
  return run("patients:read", async (c) => {
    const now = getNow();
    const r = await c.query<{
      id: string;
      hospital_patient_id: string | null;
      full_name: string;
      date_of_birth: string | null;
      sex: string;
      category: PatientCategory;
      ward_room: string | null;
      provenance: string;
      last_service: Date | null;
    }>(
      `SELECT p.id, p.hospital_patient_id, p.full_name, p.date_of_birth, p.sex, p.category, p.ward_room, p.provenance, ls.last_service
         FROM patient p
         LEFT JOIN (SELECT patient_id, max(occurred_at) AS last_service FROM service_event_v WHERE occurred_at <= $1 GROUP BY patient_id) ls ON ls.patient_id = p.id
        WHERE p.voided_at IS NULL ORDER BY p.full_name`,
      [now],
    );
    return r.rows.map((p) => ({
      id: p.id,
      hospitalId: p.hospital_patient_id ?? "No hospital no.",
      name: p.full_name,
      dob: p.date_of_birth,
      age: ageFrom(p.date_of_birth, now),
      sex: p.sex,
      category: p.category,
      wardRoom: p.ward_room,
      provenance: p.provenance === "IMPORT" ? "IMPORT" : "MANUAL",
      lastServiceIso: iso(p.last_service),
    }));
  });
}

export async function getPatientProfile(id: string) {
  return run("patients:read", async (c) => {
    const pr = await c.query<{
      id: string;
      hospital_patient_id: string | null;
      full_name: string;
      date_of_birth: string | null;
      sex: string;
      category: PatientCategory;
      ward_room: string | null;
      provenance: string;
      created_at: Date;
      updated_at: Date;
    }>(
      "SELECT id, hospital_patient_id, full_name, date_of_birth, sex, category, ward_room, provenance, created_at, updated_at FROM patient WHERE id = $1 AND voided_at IS NULL",
      [id],
    );
    const p = pr.rows[0];
    if (!p) return null;
    const now = getNow();
    // Opening an individual patient record is itself audited.
    await audit(c, "patient.view", undefined, { table: "patient", id });
    const enc = await c.query<{ id: string; hooked_at: Date; disconnected_at: Date | null; ventilator_ref: string; ward_room: string; status: string }>(
      "SELECT id, hooked_at, disconnected_at, ventilator_ref, ward_room, status FROM vent_encounter WHERE patient_id = $1 ORDER BY hooked_at DESC",
      [id],
    );
    const orders = await c.query<{
      id: string;
      order_reference: string;
      medication: string;
      frequency: string;
      prescribed_times: string[];
      prescriber: string;
      start_at: Date;
    }>(
      `SELECT id, order_reference, medication_as_ordered AS medication, frequency, prescribed_times::text[] AS prescribed_times, prescriber, start_at
         FROM neb_order WHERE patient_id = $1 ORDER BY start_at DESC LIMIT 20`,
      [id],
    );
    const dx = await c.query<{
      id: string;
      service: DiagnosticService;
      scheduled_at: Date;
      status: DiagnosticStatus;
      raw_status: string | null;
      procedure_label: string;
      reschedules_id: string | null;
    }>(
      "SELECT id, service, scheduled_at, status, raw_status, procedure_label, reschedules_id FROM diagnostic_appointment WHERE patient_id = $1 AND voided_at IS NULL ORDER BY scheduled_at DESC LIMIT 20",
      [id],
    );
    const tl = await c.query<{ id: string; service: ServiceType; occurred_at: Date; status: string; by: string | null }>(
      `SELECT v.id, v.service, v.occurred_at, v.status, st.display_name AS by FROM service_event_v v LEFT JOIN staff st ON st.id = v.staff_id
        WHERE v.patient_id = $1 AND v.occurred_at <= $2 ORDER BY v.occurred_at DESC LIMIT 25`,
      [id, now],
    );
    return {
      patient: {
        id: p.id,
        hospitalPatientId: p.hospital_patient_id ?? "No hospital no.",
        fullName: p.full_name,
        dateOfBirth: p.date_of_birth,
        sex: p.sex,
        category: p.category,
        wardRoom: p.ward_room,
        provenance: p.provenance === "IMPORT" ? "IMPORT" : "MANUAL",
        createdAt: iso(p.created_at)!,
        updatedAt: iso(p.updated_at)!,
        age: ageFrom(p.date_of_birth, now),
      },
      encounters: enc.rows.map((e) => ({
        id: e.id,
        hookedIso: iso(e.hooked_at)!,
        disconnectedIso: iso(e.disconnected_at),
        ventilatorRef: e.ventilator_ref,
        wardRoom: e.ward_room,
        status: e.status,
      })),
      tubing: await tubingRows(c, now, await tubingPolicy(c), id),
      nebOrders: orders.rows.map((o) => ({
        id: o.id,
        orderReference: o.order_reference,
        medication: o.medication,
        frequency: o.frequency,
        prescribedTimes: o.prescribed_times.map((t) => t.slice(0, 5)),
        prescriber: o.prescriber,
        startIso: iso(o.start_at)!,
      })),
      diagnostics: dx.rows.map((d) => ({
        id: d.id,
        service: d.service,
        scheduledIso: iso(d.scheduled_at)!,
        status: d.status,
        rawStatus: d.raw_status ?? "",
        procedureLabel: d.procedure_label,
        reschedulesId: d.reschedules_id,
      })),
      timeline: tl.rows.map((t) => ({
        id: t.id,
        service: t.service,
        occurredIso: iso(t.occurred_at)!,
        status: t.status,
        by: t.by ?? "—",
        ...classifyInstant(new Date(t.occurred_at)),
      })),
    };
  });
}

// ----------------------------------------------------------------- activity

export async function activityIn(c: Tx, w: Window, staffId?: string): Promise<ActivityEvent[]> {
  const r = await c.query<{ id: string; service: ServiceType; patient_id: string; staff_id: string; occurred_at: Date; status: string; source_id: string }>(
    `SELECT id, service, patient_id, staff_id, occurred_at, status, source_id FROM service_event_v
      WHERE occurred_at >= $1 AND occurred_at < $2 AND ($3::uuid IS NULL OR staff_id = $3) ORDER BY occurred_at DESC`,
    [w.start, w.end, staffId ?? null],
  );
  return r.rows.map((a) => ({
    id: a.id,
    service: a.service,
    patientId: a.patient_id,
    staffId: a.staff_id,
    occurredAt: iso(a.occurred_at)!,
    status: a.status,
    sourceId: a.source_id,
  }));
}

export async function listActivity(session: Session, operationalDate?: IsoDate) {
  const all = session.role === "CHIEF_RT_ADMIN";
  return run(all ? "activity:read-all" : "activity:read-own", async (c) => {
    const now = getNow();
    const date = operationalDate ?? classifyInstant(now).operationalDate;
    const w = operationalDayWindow(date);
    const end = w.end < now ? w.end : now;
    const events = (await activityIn(c, { start: w.start, end }, all ? undefined : session.staffId)).filter((a) => COMPLETED_ACTIVITY_STATUSES.has(a.status));
    const pts = await c.query<PRow>(`SELECT ${P("p")} FROM patient p WHERE p.id = ANY($1::uuid[])`, [[...new Set(events.map((e) => e.patientId))]]);
    const st = await c.query<{ id: string; display_name: string }>("SELECT id, display_name FROM staff WHERE id = ANY($1::uuid[])", [
      [...new Set(events.map((e) => e.staffId))],
    ]);
    const pmap = new Map(pts.rows.map((p) => [p.p_id, pref(p)]));
    const smap = new Map(st.rows.map((s) => [s.id, s.display_name]));
    const rows = events
      .filter((a) => pmap.has(a.patientId))
      .map((a) => ({
        id: a.id,
        service: a.service,
        serviceLabel: SERVICE_LABELS[a.service],
        occurredIso: a.occurredAt,
        status: a.status,
        staff: smap.get(a.staffId) ?? "—",
        shift: classifyInstant(new Date(a.occurredAt)).shift,
        patient: pmap.get(a.patientId)!,
      }));
    const byStaff = new Map<string, { staff: string; total: number; byShift: Record<ShiftCode, number> }>();
    for (const r of rows) {
      const e = byStaff.get(r.staff) ?? { staff: r.staff, total: 0, byShift: { MORNING: 0, AFTERNOON: 0, NIGHT: 0 } };
      e.total++;
      e.byShift[r.shift]++;
      byStaff.set(r.staff, e);
    }
    return {
      operationalDate: date,
      scope: all ? ("unit" as const) : ("own" as const),
      rows,
      byStaff: [...byStaff.values()].sort((a, b) => a.staff.localeCompare(b.staff)),
    };
  });
}

// ----------------------------------------------------------------- shifts

export async function getRoster(days = 7) {
  return run("shifts:read", async (c) => {
    const today = classifyInstant(getNow()).operationalDate;
    const dates = Array.from({ length: days }, (_, i) => addDays(today, i - 1));
    const r = await c.query<{ operational_date: string; shift: ShiftCode; name: string }>(
      `SELECT a.operational_date, a.shift, s.display_name AS name FROM shift_assignment a JOIN staff s ON s.id = a.staff_id
        WHERE a.operational_date BETWEEN $1 AND $2 AND a.removed_at IS NULL ORDER BY s.display_name`,
      [dates[0], dates[dates.length - 1]],
    );
    return {
      today,
      dates: dates.map((date) => ({
        date,
        shifts: SHIFT_ORDER.map((shift) => ({ shift, staff: r.rows.filter((x) => x.operational_date === date && x.shift === shift).map((x) => x.name) })),
      })),
    };
  });
}

// ----------------------------------------------------------------- administration reads

export async function listStaff() {
  return run("staff:manage", async (c) => {
    const r = await c.query<{
      id: string;
      username: string;
      display_name: string;
      role: string;
      status: string;
      created_at: Date;
      last_login_at: Date | null;
      active_sessions: number;
    }>(
      `SELECT s.id, s.username, s.display_name, s.role, s.status, s.created_at, s.last_login_at,
              (SELECT count(*)::int FROM auth_session x WHERE x.staff_id = s.id AND x.revoked_at IS NULL AND x.mfa_verified_at IS NOT NULL AND x.idle_expires_at > now()) AS active_sessions
         FROM staff s ORDER BY (s.role = 'CHIEF_RT_ADMIN') DESC, s.display_name`,
    );
    return r.rows.map((s) => ({
      id: s.id,
      username: s.username,
      displayName: s.display_name,
      role: s.role,
      accountStatus: s.status,
      createdAt: iso(s.created_at)!,
      lastActiveAt: iso(s.last_login_at),
      activeSessions: s.active_sessions,
    }));
  });
}

export async function listAudit(limit = 300, actionPrefix = "") {
  return run("audit:read", async (c) => {
    const r = await c.query<{
      id: number;
      occurred_at: Date;
      actor: string | null;
      action: string;
      table_name: string | null;
      record_id: string | null;
      device: string | null;
    }>(
      `SELECT a.id, a.occurred_at, s.display_name AS actor, a.action, a.table_name, a.record_id, d.label AS device
         FROM audit_log a LEFT JOIN staff s ON s.id = a.actor_id LEFT JOIN device d ON d.id = a.device_id
        WHERE ($2 = '' OR a.action LIKE $2 || '%')
        ORDER BY a.id DESC LIMIT $1`,
      [limit, actionPrefix],
    );
    return r.rows.map((a) => ({
      id: a.id,
      occurredAt: iso(a.occurred_at)!,
      actor: a.actor ?? "System / seed",
      action: a.action,
      target: a.table_name ? `${a.table_name}:${(a.record_id ?? "").slice(0, 8)}` : "—",
      deviceLabel: a.device ?? "—",
    }));
  });
}

export async function listDevices(session: Session) {
  const all = session.role === "CHIEF_RT_ADMIN";
  return run(all ? "devices:manage" : "devices:read-own", async (c) => {
    const sessions = await c.query<{ id: string; device_id: string; device_label: string; staff: string; created_at: Date; last_seen_at: Date }>(
      `SELECT x.id, x.device_id, d.label AS device_label, s.display_name AS staff, x.created_at, x.last_seen_at
         FROM auth_session x JOIN device d ON d.id = x.device_id JOIN staff s ON s.id = x.staff_id
        WHERE x.revoked_at IS NULL AND x.mfa_verified_at IS NOT NULL AND x.idle_expires_at > now() AND x.absolute_expires_at > now()
          AND ($1 OR x.staff_id = $2)
        ORDER BY x.last_seen_at DESC`,
      [all, session.staffId],
    );
    const devices = await c.query<{
      id: string;
      label: string;
      created_at: Date;
      last_seen_at: Date;
      status: "ACTIVE" | "REVOKED";
      revoked_reason: string | null;
      users: string[];
      offline_phi_allowed: boolean;
    }>(
      `SELECT d.id, d.label, d.created_at, d.last_seen_at, d.status, d.revoked_reason, d.offline_phi_allowed,
              coalesce(array_agg(DISTINCT s.display_name) FILTER (WHERE s.id IS NOT NULL), '{}') AS users
         FROM device d LEFT JOIN auth_session x ON x.device_id = d.id LEFT JOIN staff s ON s.id = x.staff_id
        WHERE $1 OR EXISTS (SELECT 1 FROM auth_session y WHERE y.device_id = d.id AND y.staff_id = $2)
        GROUP BY d.id ORDER BY d.last_seen_at DESC`,
      [all, session.staffId],
    );
    return {
      sessions: sessions.rows.map((x) => ({
        id: x.id,
        deviceId: x.device_id,
        deviceLabel: x.device_label,
        staff: x.staff,
        createdIso: iso(x.created_at)!,
        lastSeenIso: iso(x.last_seen_at)!,
        current: x.id === session.sessionId,
      })),
      devices: devices.rows.map((d) => ({
        id: d.id,
        label: d.label,
        createdIso: iso(d.created_at)!,
        lastSeenIso: iso(d.last_seen_at)!,
        status: d.status,
        revokedReason: d.revoked_reason,
        users: d.users,
        current: d.id === session.deviceId,
        offlineApproved: d.offline_phi_allowed,
      })),
    };
  });
}

export async function getSettings() {
  return run("settings:read", async (c) => {
    const r = await c.query<{ key: string; value: number; description: string; updated_at: Date; updated_by: string | null }>(
      "SELECT x.key, x.value, x.description, x.updated_at, s.display_name AS updated_by FROM setting x LEFT JOIN staff s ON s.id = x.updated_by ORDER BY x.key",
    );
    return r.rows.map((x) => ({ key: x.key, value: Number(x.value), description: x.description, updatedIso: iso(x.updated_at)!, updatedBy: x.updated_by }));
  });
}

// ----------------------------------------------------------------- notifications

export interface NotificationItem {
  id: string;
  severity: "danger" | "warning" | "info";
  title: string;
  /** Deliberately PHI-free: no names or hospital numbers (notification previews, §6). */
  detail: string;
  href: string;
}

export async function getNotifications(): Promise<NotificationItem[]> {
  return run("notifications:read", async (c) => {
    const now = getNow();
    const items: NotificationItem[] = [];
    for (const t of await tubingRows(c, now, await tubingPolicy(c))) {
      const detail = `${t.ventilatorRef} · ${t.wardRoom}`;
      if (t.status === "OVERDUE") items.push({ id: `tub-${t.encounterId}`, severity: "danger", title: "Tubing replacement overdue", detail, href: "/tubing" });
      else if (t.status === "NO_RECORD")
        items.push({ id: `tub-${t.encounterId}`, severity: "danger", title: "No documented tubing installation", detail, href: "/tubing" });
      else if (t.status === "DUE")
        items.push({ id: `tub-${t.encounterId}`, severity: "warning", title: "Tubing replacement due this operational day", detail, href: "/tubing" });
    }
    const ho = await c.query<{ id: string; operational_date: string; shift: string }>(
      "SELECT id, operational_date, shift FROM shift_handover WHERE acknowledged_at IS NULL ORDER BY operational_date DESC",
    );
    for (const h of ho.rows) {
      items.push({
        id: `ho-${h.id}`,
        severity: "warning",
        title: "Handover awaiting acknowledgment",
        detail: `${h.operational_date} · ${h.shift.toLowerCase()} shift`,
        href: "/handover",
      });
    }
    const pendingDoses = (await nebRows(c, { start: operationalDayWindow(classifyInstant(now).operationalDate).start, end: now }, now)).filter(
      (r) => r.status === "PENDING",
    ).length;
    const pend = { rows: [{ n: pendingDoses }] };
    if (pend.rows[0].n) {
      items.push({
        id: "neb-pending",
        severity: "warning",
        title: `${pend.rows[0].n} nebulization dose(s) awaiting documentation`,
        detail: "Scheduled time has passed",
        href: "/nebulization",
      });
    }
    const upcoming = (await todaysDiagnostics(c, now)).filter((d) => d.status === "SCHEDULED").length;
    if (upcoming)
      items.push({
        id: "dx-today",
        severity: "info",
        title: `${upcoming} diagnostic appointment(s) still scheduled today`,
        detail: "PFT · ABG · Sputum induction",
        href: "/diagnostics/pft",
      });
    return items;
  });
}

// ----------------------------------------------------------------- overview & reports

export async function unitMetrics(c: Tx, w: Window, reference: Date) {
  const events = await activityIn(c, w);
  const unique = uniquePatientsServed(events, w);
  const cats = await c.query<{ category: PatientCategory; n: number }>(
    "SELECT category, count(*)::int AS n FROM patient WHERE id = ANY($1::uuid[]) GROUP BY category",
    [[...unique]],
  );
  const vent = await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM vent_encounter WHERE hooked_at <= $1 AND (disconnected_at IS NULL OR disconnected_at > $1)",
    [reference],
  );
  const nebCounts = countBy(await nebRows(c, w, reference), (r) => r.status);
  const dx = await c.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM diagnostic_appointment WHERE scheduled_at >= $1 AND scheduled_at < $2 AND voided_at IS NULL GROUP BY status",
    [w.start, w.end],
  );
  const toCounts = (rows: Array<{ status?: string; category?: string; n: number }>, k: "status" | "category") =>
    Object.fromEntries(rows.map((r) => [r[k], r.n])) as Partial<Record<string, number>>;
  return {
    uniquePatients: unique.size,
    serviceCounts: serviceCounts(events, w),
    activeVentilators: vent.rows[0].n,
    nebulization: nebCounts,
    diagnostics: toCounts(dx.rows, "status"),
    opdInp: toCounts(cats.rows, "category"),
    byShift: eventsByShift(events, w),
  };
}

export async function monthly(c: Tx, year: number) {
  const r = await c.query<{ month: number; total: number; unique_patients: number }>(
    `SELECT extract(month FROM occurred_at AT TIME ZONE $2)::int AS month, count(*)::int AS total, count(DISTINCT patient_id)::int AS unique_patients
       FROM service_event_v
      WHERE status = ANY($3::text[]) AND extract(year FROM occurred_at AT TIME ZONE $2) = $1 AND occurred_at <= now()
      GROUP BY 1`,
    [year, HOSPITAL_TZ, [...COMPLETED_ACTIVITY_STATUSES]],
  );
  return Array.from({ length: 12 }, (_, i) => {
    const m = r.rows.find((x) => x.month === i + 1);
    return { month: i + 1, total: m?.total ?? 0, uniquePatients: m?.unique_patients ?? 0 };
  });
}

export async function getOverview(session: Session) {
  return run("clinical:read", async (c) => {
    const now = getNow();
    const k = classifyInstant(now);
    const tub = await tubingRows(c, now, await tubingPolicy(c));
    const tubingCounts = { OVERDUE: 0, DUE: 0, UPCOMING: 0, NO_RECORD: 0, CURRENT: 0 } as Record<TubingStatus, number>;
    for (const t of tub) tubingCounts[t.status]++;
    const ho = await c.query<{ id: string; operational_date: string; shift: ShiftCode; outgoing: string; items: number }>(
      `SELECT h.id, h.operational_date, h.shift, s.display_name AS outgoing, (SELECT count(*)::int FROM handover_item i WHERE i.handover_id = h.id) AS items
         FROM shift_handover h JOIN staff s ON s.id = h.outgoing_staff_id WHERE h.acknowledged_at IS NULL
        ORDER BY h.operational_date DESC, array_position(ARRAY['NIGHT','AFTERNOON','MORNING'], h.shift) LIMIT 1`,
    );
    const h = ho.rows[0];
    const base = {
      tubing: tub.filter((t) => t.status !== "CURRENT"),
      tubingCounts,
      todaysDiagnostics: await todaysDiagnostics(c, now),
      pendingHandover: h ? { id: h.id, operationalDate: h.operational_date, shift: h.shift, outgoing: h.outgoing, items: h.items } : null,
    };
    if (session.role !== "CHIEF_RT_ADMIN") return { ...base, unit: null };
    const w = operationalDayWindow(k.operationalDate);
    const year = toLocalParts(now).year;
    return { ...base, unit: { ...(await unitMetrics(c, { start: w.start, end: now }, now)), monthly: await monthly(c, year), year } };
  });
}

export type ReportMode = "operational" | "calendar";

export async function getDailyReport(mode: ReportMode, date: IsoDate) {
  return run("reports:unit", async (c) => {
    const w = mode === "operational" ? operationalDayWindow(date) : calendarDayWindow(date);
    const now = getNow();
    const reference = w.end < now ? w.end : now;
    const shifts: Array<{ shift: ShiftCode; window: { startIso: string; endIso: string }; events: Record<ServiceType, number>; unique: number }> | null =
      mode === "operational" ? [] : null;
    if (shifts) {
      for (const s of SHIFT_ORDER) {
        const sw = shiftWindow(date, s);
        const ev = await activityIn(c, sw);
        shifts.push({
          shift: s,
          window: { startIso: sw.start.toISOString(), endIso: sw.end.toISOString() },
          events: serviceCounts(ev, sw),
          unique: uniquePatientsServed(ev, sw).size,
        });
      }
    }
    return {
      mode,
      date,
      window: { startIso: w.start.toISOString(), endIso: w.end.toISOString() },
      referenceIso: reference.toISOString(),
      metrics: await unitMetrics(c, w, reference),
      shifts,
      monthly: await monthly(c, toLocalParts(now).year),
    };
  });
}

// ----------------------------------------------------------------- search

export interface SearchHit {
  kind: "patient" | "module";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export async function searchPatients(query: string): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return run("patients:read", async (c) => {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const r = await c.query<PRow>(
      `SELECT ${P("p")} FROM patient p
        WHERE p.voided_at IS NULL AND (lower(p.hospital_patient_id) LIKE $1 OR lower(p.full_name) LIKE $1)
        ORDER BY (lower(p.hospital_patient_id) = $2) DESC, p.full_name LIMIT 8`,
      [like, q],
    );
    return r.rows.map((p) => {
      const ref = pref(p);
      return {
        kind: "patient" as const,
        id: ref.id,
        title: ref.name,
        subtitle: `${ref.hospitalId} · ${ref.category}${ref.wardRoom ? ` · ${ref.wardRoom}` : ""}`,
        href: `/patients/${ref.id}`,
      };
    });
  });
}

export type { ServiceType };

// ----------------------------------------------------------------- ventilator flowsheet (print)

export async function getVentFlowsheet(encounterId: string) {
  if (!/^[0-9a-f-]{36}$/.test(encounterId)) return null;
  const all = await listVentilation();
  const enc = all.find((e) => e.id === encounterId);
  if (!enc) return null;
  return run("clinical:read", async (c) => {
    const p = await c.query<{ date_of_birth: string | null; sex: string | null; category: string }>(
      "SELECT date_of_birth::text, sex, category FROM patient WHERE id = $1",
      [enc.patient.id],
    );
    const t = await c.query<{ id: string; installed_at: Date; reason: string; by: string | null; voided_at: Date | null; void_reason: string | null }>(
      `SELECT t.id, t.installed_at, t.reason, st.display_name AS by, t.voided_at, t.void_reason
         FROM tubing_event t LEFT JOIN staff st ON st.id = t.performed_by
        WHERE t.encounter_id = $1 ORDER BY t.installed_at`,
      [encounterId],
    );
    return {
      ...enc,
      settings: [...enc.settings].reverse(), // oldest first, like a paper flowsheet
      patientInfo: { dob: p.rows[0]?.date_of_birth ?? null, sex: p.rows[0]?.sex ?? null, category: p.rows[0]?.category ?? null },
      tubing: t.rows.map((x) => ({
        id: x.id,
        atIso: iso(x.installed_at)!,
        reason: x.reason,
        by: x.by ?? "—",
        voided: !!x.voided_at,
        voidReason: x.void_reason,
      })),
      printedIso: getNow().toISOString(),
    };
  });
}

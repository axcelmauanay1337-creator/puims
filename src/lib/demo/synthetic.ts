/**
 * SYNTHETIC DEMONSTRATION DATA — NOT REAL PATIENTS, STAFF OR PROVIDERS.
 *
 * Deterministic (seeded) generator anchored to the start of the current
 * operational day so screens look realistic while every value is fictional.
 * Hospital numbers use the reserved `SYN-` prefix, staff are "RT Alpha…",
 * physicians are "Dr. Demo …". Nothing here is derived from the source
 * workbooks. Medication text is a placeholder referencing a synthetic order —
 * no doses are generated.
 *
 * Replaced by PostgreSQL repositories in Milestone 2; retained for seed scripts
 * and automated tests.
 */
import { DEFAULT_TUBING_POLICY } from "@/lib/clinical/tubing";
import type { DiagnosticService, DiagnosticStatus, NebulizationStatus, PatientCategory } from "@/lib/clinical/vocabulary";
import type {
  ActivityEvent,
  AuditEntry,
  DeviceRecord,
  DiagnosticAppointment,
  HandoverItemRef,
  NebulizationAdministration,
  NebulizationOrder,
  Patient,
  ShiftAssignment,
  ShiftHandover,
  StaffMember,
  TubingReplacement,
  VentilatorEncounter,
} from "@/lib/domain/types";
import { SHIFT_ORDER, classifyInstant, operationalDayWindow, previousShift, shiftWindow, type ShiftCode } from "@/lib/time/shifts";
import { HOSPITAL_TZ, type IsoDate, addDays, parseIsoDate, zonedWallTimeToUtc } from "@/lib/time/zoned";

export interface SyntheticDataset {
  anchorOperationalDate: IsoDate;
  staff: StaffMember[];
  patients: Patient[];
  assignments: ShiftAssignment[];
  nebOrders: NebulizationOrder[];
  nebAdministrations: NebulizationAdministration[];
  encounters: VentilatorEncounter[];
  tubing: TubingReplacement[];
  diagnostics: DiagnosticAppointment[];
  handovers: ShiftHandover[];
  activity: ActivityEvent[];
  audit: AuditEntry[];
  devices: DeviceRecord[];
}

// ---------------------------------------------------------------- PRNG

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float() {
    return this.next();
  }
  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
  uuid(): string {
    const h = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16));
    h[12] = "4";
    h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

// ---------------------------------------------------------------- vocab (fictional)

const GIVEN = [
  "Amihan",
  "Bayani",
  "Dalisay",
  "Datu",
  "Ligaya",
  "Mayumi",
  "Tala",
  "Lakan",
  "Hiraya",
  "Isagani",
  "Luningning",
  "Makisig",
  "Marikit",
  "Malaya",
  "Bituin",
  "Dakila",
  "Diwata",
  "Kidlat",
  "Liwayway",
  "Tamaraw",
];
const FAMILY = ["Synthetico", "Demoranza", "Fictorio", "Placeres", "Muestra", "Ejemplo", "Prueba", "Simulado", "Modelo", "Ficcion", "Ensayo", "Patron"];
const RT_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
const PHYSICIANS = ["Dr. Demo Physician A", "Dr. Demo Physician B", "Dr. Demo Physician C", "Dr. Demo Physician D", "Dr. Demo Physician E"];
const WARDS = ["ICU-1", "ICU-2", "ICU-3", "MICU-4", "SICU-2", "Ward 3A-12", "Ward 3B-04", "Ward 5A-08", "ER-Obs 2", "NICU-1"];
const VENTS = ["VENT-SYN-01", "VENT-SYN-02", "VENT-SYN-03", "VENT-SYN-04", "VENT-SYN-05", "VENT-SYN-06", "VENT-SYN-07", "VENT-SYN-08"];
const PROCEDURES: Record<DiagnosticService, string[]> = {
  PFT: ["Simple spirometry (synthetic label)", "Complete PFT with post-bronchodilator (synthetic label)", "PFT with DLCO (synthetic label)"],
  ABG: ["ABG (synthetic label)"],
  SPUTUM_INDUCTION: ["Sputum induction (synthetic label)"],
};

const HOUR = 3_600_000;

function atLocal(date: IsoDate, hour: number, minute = 0): Date {
  return zonedWallTimeToUtc({ ...parseIsoDate(date), hour, minute }, HOSPITAL_TZ);
}

// ---------------------------------------------------------------- generator

export function generateSyntheticDataset(anchorOperationalDate: IsoDate, now: Date): SyntheticDataset {
  const rng = new Rng(0x9a17e5);
  const dayStart = operationalDayWindow(anchorOperationalDate).start;
  const iso = (d: Date) => d.toISOString();

  // Staff ---------------------------------------------------------------
  const chief: StaffMember = {
    id: rng.uuid(),
    displayName: "Chief RT (Demo)",
    initials: "CR",
    role: "CHIEF_RT_ADMIN",
    accountStatus: "ACTIVE",
    createdAt: iso(new Date(dayStart.getTime() - 400 * 24 * HOUR)),
    lastActiveAt: iso(new Date(dayStart.getTime() + HOUR)),
  };
  const rts: StaffMember[] = RT_NAMES.map((n, i) => ({
    id: rng.uuid(),
    displayName: `RT ${n} (Demo)`,
    initials: `R${n[0]}`,
    role: "RESPIRATORY_THERAPIST",
    accountStatus: i === 6 ? "INVITED" : i === 5 ? "DEACTIVATED" : "ACTIVE",
    createdAt: iso(new Date(dayStart.getTime() - (300 - i * 20) * 24 * HOUR)),
    lastActiveAt: i === 6 ? null : iso(new Date(dayStart.getTime() - i * 3 * HOUR)),
  }));
  const staff = [chief, ...rts];
  const activeRts = rts.filter((r) => r.accountStatus === "ACTIVE");

  // Patients --------------------------------------------------------------
  const patients: Patient[] = [];
  for (let i = 0; i < 48; i++) {
    const category: PatientCategory = i < 22 ? "INP" : i < 46 ? "OPD" : "OTHER";
    const age = rng.int(4, 88);
    const dob = addDays(anchorOperationalDate, -(age * 365 + rng.int(0, 364)));
    const created = new Date(dayStart.getTime() - rng.int(1, 330) * 24 * HOUR);
    patients.push({
      id: rng.uuid(),
      // A few outpatients have no hospital number (optional — decision U-13).
      hospitalPatientId: category === "OPD" && i % 9 === 4 ? null : `SYN-${String(100200 + i * 37).padStart(6, "0")}`,
      fullName: `${rng.pick(FAMILY)}, ${rng.pick(GIVEN)}`,
      dateOfBirth: rng.chance(0.92) ? dob : null,
      sex: rng.chance(0.5) ? "F" : "M",
      category,
      wardRoom: category === "INP" ? rng.pick(WARDS) : null,
      createdAt: iso(created),
      updatedAt: iso(new Date(created.getTime() + rng.int(0, 20) * 24 * HOUR)),
      provenance: rng.chance(0.3) ? "IMPORT" : "MANUAL",
    });
  }
  const inpatients = patients.filter((p) => p.category === "INP");
  const outpatients = patients.filter((p) => p.category !== "INP");

  // Shift assignments: two RTs per shift, rotating ----------------------
  const assignments: ShiftAssignment[] = [];
  for (let d = -370; d <= 14; d++) {
    const date = addDays(anchorOperationalDate, d);
    SHIFT_ORDER.forEach((shift, si) => {
      const n = activeRts.length;
      const base = (((d * 3 + si) % n) + n) % n;
      for (let k = 0; k < 2; k++) {
        assignments.push({ id: rng.uuid(), operationalDate: date, shift, staffId: activeRts[(base + k * 2) % activeRts.length].id });
      }
    });
  }
  const byShiftKey = new Map<string, ShiftAssignment[]>();
  for (const a of assignments) {
    const k = `${a.operationalDate}|${a.shift}`;
    byShiftKey.set(k, [...(byShiftKey.get(k) ?? []), a]);
  }
  const rtOnDuty = (instant: Date) => {
    const c = classifyInstant(instant);
    const on = byShiftKey.get(`${c.operationalDate}|${c.shift}`) ?? [];
    return on.length ? on[Math.floor(rng.float() * on.length)].staffId : activeRts[0].id;
  };

  // Mechanical ventilation + tubing ------------------------------------
  const encounters: VentilatorEncounter[] = [];
  const tubing: TubingReplacement[] = [];
  // Hours since last documented installation for ACTIVE encounters (relative to `now`)
  // chosen to exercise every tubing status; `null` = no documented installation.
  const tubingAges: Array<number | null> = [18, 70, 132, 165.5, 160, 176, null];
  tubingAges.forEach((age, i) => {
    const p = inpatients[i];
    const hooked = new Date(now.getTime() - ((age ?? 30) + rng.int(2, 200)) * HOUR);
    const enc: VentilatorEncounter = {
      id: rng.uuid(),
      patientId: p.id,
      hookedAt: iso(hooked),
      disconnectedAt: null,
      ventilatorRef: VENTS[i],
      wardRoom: p.wardRoom ?? "ICU-1",
      responsibleStaffId: rtOnDuty(hooked),
      status: "ACTIVE",
    };
    encounters.push(enc);
    if (age !== null) {
      // Earlier installation(s) preserved as history.
      const prior = new Date(now.getTime() - (age + DEFAULT_TUBING_POLICY.intervalDays * 24) * HOUR);
      if (prior > hooked) {
        tubing.push({
          id: rng.uuid(),
          encounterId: enc.id,
          tubingType: "Ventilator circuit",
          installedAt: iso(prior),
          performedBy: rtOnDuty(prior),
          reason: "Scheduled replacement",
        });
      }
      const inst = new Date(Math.max(now.getTime() - age * HOUR, hooked.getTime()));
      tubing.push({
        id: rng.uuid(),
        encounterId: enc.id,
        tubingType: "Ventilator circuit",
        installedAt: iso(inst),
        performedBy: rtOnDuty(inst),
        reason: inst.getTime() === hooked.getTime() ? "Initial set-up at hook-in" : "Scheduled replacement",
      });
    }
  });
  for (let i = 0; i < 9; i++) {
    const p = inpatients[7 + (i % 12)];
    const hooked = new Date(dayStart.getTime() - rng.int(3, 120) * 24 * HOUR);
    const disc = new Date(hooked.getTime() + rng.int(20, 200) * HOUR);
    const enc: VentilatorEncounter = {
      id: rng.uuid(),
      patientId: p.id,
      hookedAt: iso(hooked),
      disconnectedAt: iso(disc),
      ventilatorRef: rng.pick(VENTS),
      wardRoom: p.wardRoom ?? "ICU-2",
      responsibleStaffId: rtOnDuty(hooked),
      status: "DISCONTINUED",
    };
    encounters.push(enc);
    tubing.push({
      id: rng.uuid(),
      encounterId: enc.id,
      tubingType: "Ventilator circuit",
      installedAt: iso(hooked),
      performedBy: enc.responsibleStaffId,
      reason: "Initial set-up at hook-in",
    });
  }

  // Nebulization -------------------------------------------------------
  const nebOrders: NebulizationOrder[] = [];
  const historicalOrders: NebulizationOrder[] = [];
  const nebAdministrations: NebulizationAdministration[] = [];
  const timesByFreq: Record<string, string[]> = {
    BID: ["08:00", "20:00"],
    TID: ["08:00", "14:00", "20:00"],
    QID: ["06:00", "12:00", "18:00", "00:00"],
    Q6H: ["06:00", "12:00", "18:00", "00:00"],
    Q8H: ["06:00", "14:00", "22:00"],
    Q12H: ["09:00", "21:00"],
  };
  const notGivenReasons: Record<string, string> = {
    NOT_GIVEN: "Patient off unit for imaging (synthetic)",
    REFUSED: "Patient declined; physician informed (synthetic)",
    DELAYED: "Awaiting medication from pharmacy (synthetic)",
    CANCELLED: "Order discontinued by physician (synthetic)",
  };
  // 14 current orders + 110 completed historical orders spread over the past year,
  // so long-range trends are not distorted by a short synthetic history.
  for (let i = 0; i < 124; i++) {
    const historical = i >= 14;
    const p = historical ? rng.pick(inpatients) : inpatients[(i * 3 + 1) % inpatients.length];
    const freq = rng.pick(["BID", "TID", "QID", "Q6H", "Q8H", "Q12H", "PRN"] as const);
    const start = historical ? new Date(dayStart.getTime() - rng.int(6, 365) * 24 * HOUR) : new Date(dayStart.getTime() - rng.int(1, 4) * 24 * HOUR);
    const durationDays = historical ? rng.int(2, 5) : 0;
    const startDate = classifyInstant(start).operationalDate;
    const order: NebulizationOrder = {
      id: rng.uuid(),
      patientId: p.id,
      orderReference: `SYN-ORD-${String(4100 + i).padStart(5, "0")}`,
      prescriber: rng.pick(PHYSICIANS),
      medicationAsOrdered: `Medication as written on SYN-ORD-${String(4100 + i).padStart(5, "0")}`,
      frequency: freq,
      prescribedTimes: timesByFreq[freq] ?? [],
      startAt: iso(start),
      endAt: historical ? iso(new Date(start.getTime() + durationDays * 24 * HOUR)) : null,
    };
    if (!historical) nebOrders.push(order);
    else historicalOrders.push(order);
    const dayOffsets = historical ? Array.from({ length: durationDays }, (_, k) => k) : [-3, -2, -1, 0];
    for (const d of dayOffsets) {
      const date = historical ? addDays(startDate, d) : addDays(anchorOperationalDate, d);
      for (const t of order.prescribedTimes) {
        const [hh, mm] = t.split(":").map(Number);
        const calDate = hh < 6 ? addDays(date, 1) : date; // 00:00 slot belongs to the next calendar day
        const sched = atLocal(calDate, hh, mm);
        if (sched < start) continue;
        if (order.endAt && sched >= new Date(order.endAt)) continue;
        let status: NebulizationStatus = "SCHEDULED";
        let actual: Date | null = null;
        let by: string | null = null;
        if (sched.getTime() < now.getTime() - HOUR) {
          const r = rng.float();
          status = r < 0.84 ? "COMPLETED" : r < 0.9 ? "NOT_GIVEN" : r < 0.95 ? "REFUSED" : "DELAYED";
          if (status === "COMPLETED") {
            actual = new Date(sched.getTime() + rng.int(-10, 35) * 60_000);
            by = rtOnDuty(actual);
          } else by = rtOnDuty(sched);
        } else if (sched.getTime() < now.getTime()) {
          status = "PENDING";
        }
        nebAdministrations.push({
          id: rng.uuid(),
          orderId: order.id,
          patientId: p.id,
          scheduledAt: iso(sched),
          actualAt: actual ? iso(actual) : null,
          status,
          performedBy: by,
          reason: notGivenReasons[status] ?? null,
        });
      }
    }
    // PRN: only documented administrations exist — none are invented on a schedule.
    if (freq === "PRN" && !historical && rng.chance(0.7)) {
      const actual = new Date(Math.min(now.getTime() - HOUR, dayStart.getTime() + rng.int(1, 10) * HOUR));
      nebAdministrations.push({
        id: rng.uuid(),
        orderId: order.id,
        patientId: p.id,
        scheduledAt: null,
        actualAt: iso(actual),
        status: "COMPLETED",
        performedBy: rtOnDuty(actual),
        reason: null,
      });
    }
  }

  // Diagnostics: 12 months history + 14 days ahead ----------------------
  const diagnostics: DiagnosticAppointment[] = [];
  const services: DiagnosticService[] = ["PFT", "PFT", "PFT", "ABG", "ABG", "SPUTUM_INDUCTION"];
  const rawStatus: Record<DiagnosticStatus, string[]> = {
    COMPLETED: ["Done", "DONE", "completed"],
    NO_SHOW: ["No show", "NO-SHOW"],
    CANCELLED: ["Cancelled", "cancel"],
    FOR_RESCHEDULE: ["For resched", "FOR RESCHEDULE"],
    RESCHEDULED: ["Resched"],
    SCHEDULED: ["Scheduled"],
    PENDING: ["Pending"],
  };
  for (let d = -365; d <= 14; d++) {
    const date = addDays(anchorOperationalDate, d);
    const month = parseIsoDate(date).month;
    const seasonal = 1 + 0.45 * Math.sin(((month - 3) / 12) * 2 * Math.PI); // synthetic surge pattern
    const n = Math.max(d === 0 ? 5 : 0, Math.round(rng.float() * 5 * seasonal));
    for (let k = 0; k < n; k++) {
      const service = rng.pick(services);
      const hour = service === "ABG" ? rng.int(6, 29) % 24 : rng.int(8, 15);
      const calDate = hour < 6 ? addDays(date, 1) : date;
      const sched = atLocal(calDate, hour, rng.pick([0, 15, 30, 45]));
      const p = service === "ABG" ? rng.pick(inpatients) : rng.pick(outpatients.concat(inpatients.slice(0, 4)));
      let status: DiagnosticStatus;
      if (sched.getTime() > now.getTime()) status = d > 0 && rng.chance(0.1) ? "PENDING" : "SCHEDULED";
      else if (sched.getTime() > now.getTime() - 2 * HOUR) status = "PENDING";
      else {
        const r = rng.float();
        status = r < 0.78 ? "COMPLETED" : r < 0.86 ? "NO_SHOW" : r < 0.92 ? "CANCELLED" : "FOR_RESCHEDULE";
      }
      const appt: DiagnosticAppointment = {
        id: rng.uuid(),
        patientId: p.id,
        service,
        scheduledAt: iso(sched),
        status,
        rawStatus: rng.pick(rawStatus[status]),
        procedureLabel: rng.pick(PROCEDURES[service]),
        requestingPhysician: rng.pick(PHYSICIANS),
        category: p.category,
        schedulerId: rng.pick(activeRts).id,
        performedBy: status === "COMPLETED" ? rtOnDuty(sched) : null,
        reschedulesId: null,
        remarks: null,
      };
      diagnostics.push(appt);
      // Reschedule lineage: original row kept; new appointment links back.
      if (status === "FOR_RESCHEDULE" && rng.chance(0.7)) {
        appt.status = "RESCHEDULED";
        appt.rawStatus = rng.pick(rawStatus.RESCHEDULED);
        const newSched = new Date(sched.getTime() + rng.int(2, 10) * 24 * HOUR);
        diagnostics.push({
          ...appt,
          id: rng.uuid(),
          scheduledAt: iso(newSched),
          status: newSched > now ? "SCHEDULED" : "COMPLETED",
          rawStatus: newSched > now ? "Scheduled" : "Done",
          performedBy: newSched > now ? null : rtOnDuty(newSched),
          reschedulesId: appt.id,
          remarks: "Rescheduled from earlier appointment (synthetic)",
        });
      }
    }
  }
  diagnostics.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  // Handovers: last 3 operational days of completed shifts ----------------
  const handovers: ShiftHandover[] = [];
  const nowClass = classifyInstant(now);
  let cursor = previousShift(nowClass.operationalDate, nowClass.shift);
  for (let i = 0; i < 9; i++) {
    const w = shiftWindow(cursor.operationalDate, cursor.shift);
    const out = assignments.find((a) => a.operationalDate === cursor.operationalDate && a.shift === cursor.shift)!;
    const nextW = w.end;
    const nc = classifyInstant(nextW);
    const inc = assignments.find((a) => a.operationalDate === nc.operationalDate && a.shift === nc.shift);
    const items: HandoverItemRef[] = encounters
      .filter((e) => e.status === "ACTIVE" && new Date(e.hookedAt) < w.end)
      .slice(0, 3)
      .map((e) => ({ kind: "VENTILATOR_ENCOUNTER" as const, refId: e.id, summary: `Active ventilator ${e.ventilatorRef}` }));
    const created = new Date(w.end.getTime() - 15 * 60_000);
    handovers.push({
      id: rng.uuid(),
      operationalDate: cursor.operationalDate,
      shift: cursor.shift,
      outgoingStaffId: out.staffId,
      incomingStaffId: inc?.staffId ?? null,
      pendingItems: items,
      equipmentConcerns: rng.chance(0.3) ? "Spare circuit stock low in ICU store (synthetic)" : null,
      notes: "Synthetic handover note for demonstration only.",
      createdAt: iso(created),
      acknowledgedAt: i === 0 ? null : iso(new Date(w.end.getTime() + rng.int(2, 25) * 60_000)),
    });
    cursor = previousShift(cursor.operationalDate, cursor.shift);
  }

  // Activity (derived from documented events only) ----------------------
  const activity: ActivityEvent[] = [];
  for (const a of nebAdministrations) {
    if (a.performedBy && (a.actualAt || a.scheduledAt)) {
      activity.push({
        id: rng.uuid(),
        service: "NEBULIZATION",
        patientId: a.patientId,
        staffId: a.performedBy,
        occurredAt: (a.actualAt ?? a.scheduledAt)!,
        status: a.status,
        sourceId: a.id,
      });
    }
  }
  for (const e of encounters) {
    activity.push({
      id: rng.uuid(),
      service: "MECHANICAL_VENTILATION",
      patientId: e.patientId,
      staffId: e.responsibleStaffId,
      occurredAt: e.hookedAt,
      status: "HOOK_IN",
      sourceId: e.id,
    });
    if (e.disconnectedAt)
      activity.push({
        id: rng.uuid(),
        service: "MECHANICAL_VENTILATION",
        patientId: e.patientId,
        staffId: e.responsibleStaffId,
        occurredAt: e.disconnectedAt,
        status: "DISCONNECTION",
        sourceId: e.id,
      });
  }
  for (const t of tubing) {
    const enc = encounters.find((e) => e.id === t.encounterId)!;
    activity.push({
      id: rng.uuid(),
      service: "TUBING_REPLACEMENT",
      patientId: enc.patientId,
      staffId: t.performedBy,
      occurredAt: t.installedAt,
      status: "COMPLETED",
      sourceId: t.id,
    });
  }
  for (const d of diagnostics) {
    if (d.status === "COMPLETED" && d.performedBy) {
      activity.push({
        id: rng.uuid(),
        service: d.service,
        patientId: d.patientId,
        staffId: d.performedBy,
        occurredAt: d.scheduledAt,
        status: "COMPLETED",
        sourceId: d.id,
      });
    }
  }
  activity.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  // Audit (synthetic) ---------------------------------------------------
  const actions = [
    "patient.view",
    "nebulization.document",
    "handover.create",
    "handover.acknowledge",
    "tubing.document",
    "diagnostic.update",
    "report.export",
    "user.invite",
    "settings.view",
  ];
  const audit: AuditEntry[] = Array.from({ length: 60 }, (_, i) => {
    const actor = i % 7 === 0 ? chief : rng.pick(activeRts);
    return {
      id: 9000 - i,
      actorId: actor.id,
      action: actor.role === "CHIEF_RT_ADMIN" ? rng.pick(actions) : rng.pick(actions.slice(0, 6)),
      target: `record:${rng.uuid().slice(0, 8)}`,
      occurredAt: iso(new Date(Math.min(now.getTime(), dayStart.getTime() + 12 * HOUR) - i * rng.int(10, 90) * 60_000)),
      deviceLabel: rng.pick(["Unit workstation 1 (demo)", "Unit tablet A (demo)", "Chief RT laptop (demo)"]),
    };
  });

  const devices: DeviceRecord[] = [
    {
      id: rng.uuid(),
      label: "Unit workstation 1 (demo)",
      platform: "Desktop browser",
      ownerId: chief.id,
      registeredAt: iso(new Date(dayStart.getTime() - 90 * 24 * HOUR)),
      lastSeenAt: iso(dayStart),
      offlinePhiStorage: "DISABLED",
      status: "ACTIVE",
    },
    {
      id: rng.uuid(),
      label: "Unit tablet A (demo)",
      platform: "Tablet browser",
      ownerId: activeRts[0].id,
      registeredAt: iso(new Date(dayStart.getTime() - 60 * 24 * HOUR)),
      lastSeenAt: iso(new Date(dayStart.getTime() - 5 * HOUR)),
      offlinePhiStorage: "DISABLED",
      status: "ACTIVE",
    },
    {
      id: rng.uuid(),
      label: "Lost phone (demo)",
      platform: "Phone browser",
      ownerId: activeRts[1].id,
      registeredAt: iso(new Date(dayStart.getTime() - 120 * 24 * HOUR)),
      lastSeenAt: iso(new Date(dayStart.getTime() - 40 * 24 * HOUR)),
      offlinePhiStorage: "DISABLED",
      status: "REVOKED",
    },
  ];

  return {
    anchorOperationalDate,
    staff,
    patients,
    assignments,
    nebOrders: [...nebOrders, ...historicalOrders],
    nebAdministrations,
    encounters,
    tubing,
    diagnostics,
    handovers,
    activity,
    audit,
    devices,
  };
}

export type { ShiftCode };

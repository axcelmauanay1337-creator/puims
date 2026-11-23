/**
 * Metric definitions and pure computations (PRODUCT_REQUIREMENTS.md §13:
 * "Every metric needs a documented definition, filter, and timezone rule").
 *
 * All windows are half-open [start, end) UTC instants derived from
 * Asia/Manila wall-clock boundaries. Operational-day and calendar-day
 * windows are computed independently (see lib/time).
 */
import type { ServiceType } from "@/lib/clinical/vocabulary";
import type { ActivityEvent, DiagnosticAppointment, NebulizationAdministration, Patient, VentilatorEncounter } from "@/lib/domain/types";
import { classifyInstant, type ShiftCode } from "@/lib/time/shifts";
import { HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";

export interface Window {
  start: Date;
  end: Date;
}

export interface MetricDefinition {
  id: string;
  label: string;
  definition: string;
  counts: string;
  excludes: string;
  timeRule: string;
}

export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  uniquePatients: {
    id: "uniquePatients",
    label: "Unique patients served",
    definition: "Distinct patients with at least one documented, completed RT service event in the window.",
    counts: "Completed nebulization administrations, ventilator hook-in/disconnection, tubing replacements, completed PFT/ABG/sputum induction.",
    excludes: "Scheduled, pending, not-given, refused, cancelled and no-show items. A patient served by several services counts once.",
    timeRule: "Event time (actual administration / procedure time) classified in Asia/Manila.",
  },
  serviceEvents: {
    id: "serviceEvents",
    label: "Completed service events",
    definition: "Count of documented, completed service events by service type.",
    counts: "Each documented event once. A ventilator encounter contributes hook-in and disconnection as separate events.",
    excludes: "Scheduled or not-performed items; offline records not yet synchronized to the server.",
    timeRule: "Event time in Asia/Manila.",
  },
  activeVentilators: {
    id: "activeVentilators",
    label: "Active ventilator encounters",
    definition: "Encounters with a hook-in time at or before the reference instant and no disconnection before it.",
    counts: "Point-in-time census at the reference instant (now, or end of the selected window).",
    excludes: "Discontinued encounters.",
    timeRule: "Instant comparison; no day bucketing.",
  },
  tubing: {
    id: "tubing",
    label: "Tubing upcoming / due / overdue",
    definition: "Active ventilator encounters grouped by change-of-tubing due status from the latest documented installation.",
    counts:
      "Due = due later in the current 06:00–06:00 operational day; Upcoming = due within the configured window; Overdue = past due; No record = no documented installation.",
    excludes: "Discontinued encounters. Replacements are never assumed — only documented events count.",
    timeRule: "Interval (default 7 days, policy-pending) added to the documented installation instant.",
  },
  nebulization: {
    id: "nebulization",
    label: "Nebulization status",
    definition: "Administrations whose scheduled time (or actual time for PRN) falls in the window, by status.",
    counts: "One row per documented or explicitly scheduled administration. Times come from the clinician's order — never inferred from frequency.",
    excludes: "Orders with no explicit scheduled times produce no expected administrations.",
    timeRule: "Scheduled time, else actual time, in Asia/Manila.",
  },
  diagnostics: {
    id: "diagnostics",
    label: "Diagnostics by status",
    definition: "PFT, ABG and sputum induction appointments scheduled in the window, by normalized status.",
    counts: "Each appointment row. Rescheduled appointments remain separate rows linked by lineage.",
    excludes: "Nothing is merged or de-duplicated automatically.",
    timeRule: "Scheduled time in Asia/Manila.",
  },
  opdInp: {
    id: "opdInp",
    label: "OPD / INP split",
    definition: "Unique patients served in the window grouped by the patient's category at the time of reporting.",
    counts: "Same population as 'Unique patients served'.",
    excludes: "Category history is not yet versioned (Milestone 3); current category is used.",
    timeRule: "As unique patients.",
  },
};

const within = (iso: string | null, w: Window) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= w.start.getTime() && t < w.end.getTime();
};

export const COMPLETED_ACTIVITY_STATUSES = new Set(["COMPLETED", "HOOK_IN", "DISCONNECTION"]);

export function completedEventsIn(activity: ActivityEvent[], w: Window): ActivityEvent[] {
  return activity.filter((a) => COMPLETED_ACTIVITY_STATUSES.has(a.status) && within(a.occurredAt, w));
}

export function uniquePatientsServed(activity: ActivityEvent[], w: Window): Set<string> {
  return new Set(completedEventsIn(activity, w).map((a) => a.patientId));
}

export function serviceCounts(activity: ActivityEvent[], w: Window): Record<ServiceType, number> {
  const out: Record<ServiceType, number> = {
    NEBULIZATION: 0,
    MECHANICAL_VENTILATION: 0,
    TUBING_REPLACEMENT: 0,
    PFT: 0,
    ABG: 0,
    SPUTUM_INDUCTION: 0,
  };
  for (const a of completedEventsIn(activity, w)) out[a.service]++;
  return out;
}

export function activeVentilatorsAt(encounters: VentilatorEncounter[], at: Date): VentilatorEncounter[] {
  const t = at.getTime();
  return encounters.filter((e) => Date.parse(e.hookedAt) <= t && (!e.disconnectedAt || Date.parse(e.disconnectedAt) > t));
}

export function countBy<T, K extends string>(xs: T[], key: (x: T) => K): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const x of xs) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function nebulizationByStatus(admins: NebulizationAdministration[], w: Window) {
  return countBy(
    admins.filter((a) => within(a.scheduledAt ?? a.actualAt, w)),
    (a) => a.status,
  );
}

export function diagnosticsByStatus(appts: DiagnosticAppointment[], w: Window) {
  return countBy(
    appts.filter((a) => within(a.scheduledAt, w)),
    (a) => a.status,
  );
}

export function opdInpSplit(activity: ActivityEvent[], patients: Patient[], w: Window) {
  const ids = uniquePatientsServed(activity, w);
  const byId = new Map(patients.map((p) => [p.id, p]));
  return countBy([...ids], (id) => byId.get(id)?.category ?? "OTHER");
}

export function eventsByShift(activity: ActivityEvent[], w: Window): Record<ShiftCode, number> {
  const out: Record<ShiftCode, number> = { MORNING: 0, AFTERNOON: 0, NIGHT: 0 };
  for (const a of completedEventsIn(activity, w)) out[classifyInstant(new Date(a.occurredAt)).shift]++;
  return out;
}

/** Completed events per local calendar month (YYYY-MM) for the given year. */
export function monthlyTrend(activity: ActivityEvent[], year: number, tz: string = HOSPITAL_TZ) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: 0, uniquePatients: new Set<string>() }));
  for (const a of activity) {
    if (!COMPLETED_ACTIVITY_STATUSES.has(a.status)) continue;
    const p = toLocalParts(new Date(a.occurredAt), tz);
    if (p.year !== year) continue;
    months[p.month - 1].total++;
    months[p.month - 1].uniquePatients.add(a.patientId);
  }
  return months.map((m) => ({ month: m.month, total: m.total, uniquePatients: m.uniquePatients.size }));
}

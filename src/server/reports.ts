import "server-only";
import { roleHas } from "@/lib/authz/permissions";
import { csvLine } from "@/lib/import/parse";
import { COMPLETED_ACTIVITY_STATUSES, METRIC_DEFINITIONS } from "@/lib/metrics/metrics";
import { periodBounds, rate, type DayMode, type Period } from "@/lib/metrics/periods";
import { SERVICE_LABELS, type DiagnosticService, type ServiceType } from "@/lib/clinical/vocabulary";
import { SHIFT_ORDER, type ShiftCode } from "@/lib/time/shifts";
import { formatDateTime, HOSPITAL_TZ, parseIsoDate, type IsoDate } from "@/lib/time/zoned";
import { ClinicalError } from "./clinical";
import { getNow } from "./clock";
import { monthly, unitMetrics } from "./data";
import { audit, tx, type Tx } from "./db";
import type { Session } from "./session";

/**
 * Milestone 6 — weekly / monthly / yearly reports, tubing compliance, diagnostic outcome rates,
 * workload context and CSV exports. Every number here has a written definition (REPORT_DEFINITIONS)
 * and is computed from documented events only. Counts are context, never a staff ranking.
 */

export const REPORT_DEFINITIONS = {
  ...METRIC_DEFINITIONS,
  tubingCompliance: {
    id: "tubingCompliance",
    label: "Tubing replacement compliance",
    definition: "Of the replacements that fell due in the period (and before now), the share documented on or before the due time.",
    counts:
      "One 'due' per documented installation whose due time (installation + interval) falls in the period while the encounter was still active. On time = the next documented replacement was at or before the due time; late = after; not documented = none yet.",
    excludes: "Encounters disconnected before the due time. Voided entries. Nothing is assumed replaced.",
    timeRule: "Due instant compared with documented installation instants (Asia/Manila only for bucketing into the period).",
  },
  diagnosticRates: {
    id: "diagnosticRates",
    label: "Diagnostic outcome rates",
    definition: "Completed, no-show and cancelled as a share of appointments that reached one of those outcomes in the period.",
    counts:
      "Appointments scheduled in the period with status Completed, No-show or Cancelled. Rescheduled appointments are reported separately and are not in the denominator.",
    excludes: "Open appointments (scheduled, pending, for reschedule) and voided entries. No rate is shown when the denominator is zero.",
    timeRule: "Scheduled time in Asia/Manila.",
  },
  workload: {
    id: "workload",
    label: "Workload context by shift",
    definition: "Completed service events per shift, beside the number of RT shift assignments rostered for that shift.",
    counts: "Events by the shift in which they happened; RT-shifts = roster assignments (not removed) in the period.",
    excludes: "Complexity, acuity and non-documented work. Not a productivity measure and never a ranking of individuals.",
    timeRule: "Shift windows: Morning 06–14, Afternoon 14–22, Night 22–06 (Asia/Manila).",
  },
} as const;

function as<T>(s: Session, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}

export interface PeriodReport {
  period: Period;
  mode: DayMode;
  firstDay: IsoDate;
  lastDay: IsoDate;
  label: string;
  windowStartIso: string;
  windowEndIso: string;
  referenceIso: string;
  partial: boolean;
  metrics: Awaited<ReturnType<typeof unitMetrics>>;
  perDay: Array<{ date: IsoDate; events: number; unique: number }>;
  diagnostics: Array<{
    service: DiagnosticService;
    total: number;
    completed: number;
    noShow: number;
    cancelled: number;
    rescheduled: number;
    open: number;
    completedRate: number | null;
    noShowRate: number | null;
    cancelledRate: number | null;
  }>;
  tubing: { due: number; onTime: number; late: number; notDocumented: number; complianceRate: number | null };
  workload: Array<{ shift: ShiftCode; events: number; rtShifts: number; perRtShift: number | null }>;
  monthlyTrend: Array<{ month: number; total: number; uniquePatients: number }> | null;
}

export async function getPeriodReport(s: Session, period: Period, mode: DayMode, anchor: IsoDate): Promise<PeriodReport> {
  if (!roleHas(s.role, "reports:unit")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  const b = periodBounds(period, mode, anchor);
  const now = getNow();
  const reference = b.end < now ? b.end : now;
  const w = { start: b.start, end: reference > b.start ? reference : b.start };
  return as(s, async (c) => {
    const metrics = await unitMetrics(c, { start: b.start, end: b.end }, reference);
    // Day bucket: operational date = (local time − 6 h)::date; calendar date = local date.
    const shift = mode === "operational" ? "6 hours" : "0 hours";
    const perDay = await c.query<{ d: string; events: number; uniq: number }>(
      `SELECT ((occurred_at AT TIME ZONE $3) - $4::interval)::date::text AS d, count(*)::int AS events, count(DISTINCT patient_id)::int AS uniq
         FROM service_event_v WHERE occurred_at >= $1 AND occurred_at < $2 AND status = ANY($5::text[]) GROUP BY 1 ORDER BY 1`,
      [w.start, w.end, HOSPITAL_TZ, shift, [...COMPLETED_ACTIVITY_STATUSES]],
    );
    const byDay = new Map(perDay.rows.map((r) => [r.d, r]));
    const days: PeriodReport["perDay"] = [];
    for (let i = 0; i < b.days; i++) {
      const { year, month, day } = parseIsoDate(b.firstDay);
      const d = new Date(Date.UTC(year, month - 1, day + i)).toISOString().slice(0, 10);
      days.push({ date: d, events: byDay.get(d)?.events ?? 0, unique: byDay.get(d)?.uniq ?? 0 });
    }
    const dx = await c.query<{ service: DiagnosticService; status: string; n: number }>(
      "SELECT service, status, count(*)::int AS n FROM diagnostic_appointment WHERE scheduled_at >= $1 AND scheduled_at < $2 AND voided_at IS NULL GROUP BY 1, 2",
      [b.start, b.end],
    );
    const diagnostics = (["PFT", "ABG", "SPUTUM_INDUCTION"] as DiagnosticService[]).map((service) => {
      const n = (st: string) => dx.rows.find((r) => r.service === service && r.status === st)?.n ?? 0;
      const completed = n("COMPLETED");
      const noShow = n("NO_SHOW");
      const cancelled = n("CANCELLED");
      const closed = completed + noShow + cancelled;
      return {
        service,
        total: dx.rows.filter((r) => r.service === service).reduce((a, r) => a + r.n, 0),
        completed,
        noShow,
        cancelled,
        rescheduled: n("RESCHEDULED"),
        open: n("SCHEDULED") + n("PENDING") + n("FOR_RESCHEDULE"),
        completedRate: rate(completed, closed),
        noShowRate: rate(noShow, closed),
        cancelledRate: rate(cancelled, closed),
      };
    });
    const tub = await c.query<{ on_time: number; late: number; missing: number }>(
      `WITH due AS (
         SELECT t.encounter_id, t.installed_at, t.next_due_at,
                (SELECT min(x.installed_at) FROM tubing_event x WHERE x.encounter_id = t.encounter_id AND x.voided_at IS NULL AND x.installed_at > t.installed_at) AS replaced_at
           FROM tubing_event t JOIN vent_encounter e ON e.id = t.encounter_id
          WHERE t.voided_at IS NULL AND t.next_due_at >= $1 AND t.next_due_at < $2 AND t.next_due_at <= $3
            AND (e.disconnected_at IS NULL OR e.disconnected_at > t.next_due_at))
       SELECT count(*) FILTER (WHERE replaced_at IS NOT NULL AND replaced_at <= next_due_at)::int AS on_time,
              count(*) FILTER (WHERE replaced_at IS NOT NULL AND replaced_at > next_due_at)::int AS late,
              count(*) FILTER (WHERE replaced_at IS NULL)::int AS missing FROM due`,
      [b.start, b.end, reference],
    );
    const t = tub.rows[0];
    const dueN = t.on_time + t.late + t.missing;
    const ros = await c.query<{ shift: ShiftCode; n: number }>(
      "SELECT shift, count(*)::int AS n FROM shift_assignment WHERE operational_date BETWEEN $1 AND $2 AND removed_at IS NULL GROUP BY shift",
      [b.firstDay, b.lastDay],
    );
    const workload = SHIFT_ORDER.map((sh) => {
      const events = metrics.byShift[sh] ?? 0;
      const rtShifts = ros.rows.find((r) => r.shift === sh)?.n ?? 0;
      return { shift: sh, events, rtShifts, perRtShift: rtShifts ? Math.round((events / rtShifts) * 10) / 10 : null };
    });
    await audit(c, "report.viewed", { period, mode, first_day: b.firstDay });
    return {
      period,
      mode,
      firstDay: b.firstDay,
      lastDay: b.lastDay,
      label: b.label,
      windowStartIso: b.start.toISOString(),
      windowEndIso: b.end.toISOString(),
      referenceIso: reference.toISOString(),
      partial: b.end > now,
      metrics,
      perDay: days,
      diagnostics,
      tubing: { due: dueN, onTime: t.on_time, late: t.late, notDocumented: t.missing, complianceRate: rate(t.on_time, dueN) },
      workload,
      monthlyTrend: period === "year" ? await monthly(c, parseIsoDate(b.firstDay).year) : null,
    };
  });
}

// ================================================================= CSV exports

export type ExportKind = "summary" | "daily" | "appointments";

/**
 * CSV exports (Chief RT, `reports:export`). Summary and daily exports are aggregates (no patient data).
 * The appointment list contains patient identifiers: it is offered separately, and every export is
 * audited with its parameters and row count. Cells are formula-injection-safe.
 */
export async function exportReport(
  s: Session,
  kind: ExportKind,
  period: Period,
  mode: DayMode,
  anchor: IsoDate,
): Promise<{ fileName: string; csv: string; rows: number }> {
  if (!roleHas(s.role, "reports:export")) throw new ClinicalError("FORBIDDEN", "Only the Chief RT can export reports.");
  const r = await getPeriodReport(s, period, mode, anchor);
  const head = csvLine([
    `PUIMS ${kind} export`,
    r.label,
    `${r.firstDay} to ${r.lastDay}`,
    `generated ${new Date().toISOString()}`,
    `by ${s.username}`,
    r.partial ? "PERIOD NOT YET COMPLETE" : "",
  ]);
  let csv = head;
  let rows = 0;
  if (kind === "summary") {
    csv += csvLine(["metric", "value", "definition"]);
    const add = (m: string, v: unknown, d: string) => {
      csv += csvLine([m, v ?? "n/a", d]);
      rows++;
    };
    add("Unique patients served", r.metrics.uniquePatients, METRIC_DEFINITIONS.uniquePatients.definition);
    for (const [k, v] of Object.entries(r.metrics.serviceCounts))
      add(`Completed events: ${SERVICE_LABELS[k as ServiceType]}`, v, METRIC_DEFINITIONS.serviceEvents.definition);
    add("Active ventilators at reference", r.metrics.activeVentilators, METRIC_DEFINITIONS.activeVentilators.definition);
    for (const [k, v] of Object.entries(r.metrics.opdInp)) add(`Unique patients: ${k}`, v, METRIC_DEFINITIONS.opdInp.definition);
    for (const d of r.diagnostics) {
      add(`${d.service} appointments`, d.total, METRIC_DEFINITIONS.diagnostics.definition);
      add(`${d.service} completed %`, d.completedRate, REPORT_DEFINITIONS.diagnosticRates.definition);
      add(`${d.service} no-show %`, d.noShowRate, REPORT_DEFINITIONS.diagnosticRates.definition);
      add(`${d.service} cancelled %`, d.cancelledRate, REPORT_DEFINITIONS.diagnosticRates.definition);
    }
    add("Tubing replacements due", r.tubing.due, REPORT_DEFINITIONS.tubingCompliance.definition);
    add("Tubing on-time %", r.tubing.complianceRate, REPORT_DEFINITIONS.tubingCompliance.definition);
    for (const w of r.workload) add(`Events ${w.shift} / RT-shifts`, `${w.events} / ${w.rtShifts}`, REPORT_DEFINITIONS.workload.definition);
  } else if (kind === "daily") {
    csv += csvLine([r.mode === "operational" ? "operational date" : "calendar date", "completed events", "unique patients"]);
    for (const d of r.perDay) {
      csv += csvLine([d.date, d.events, d.unique]);
      rows++;
    }
  } else {
    await as(s, async (c) => {
      const a = await c.query<{
        scheduled_at: Date;
        service: string;
        status: string;
        raw_status: string | null;
        procedure_label: string;
        category: string;
        full_name: string;
        hid: string | null;
        physician: string | null;
        performer: string | null;
      }>(
        `SELECT d.scheduled_at, d.service, d.status, d.raw_status, d.procedure_label, d.category, p.full_name, p.hospital_patient_id AS hid,
                d.requesting_physician AS physician, st.display_name AS performer
           FROM diagnostic_appointment d JOIN patient p ON p.id = d.patient_id LEFT JOIN staff st ON st.id = d.performed_by
          WHERE d.scheduled_at >= $1 AND d.scheduled_at < $2 AND d.voided_at IS NULL ORDER BY d.scheduled_at`,
        [new Date(r.windowStartIso), new Date(r.windowEndIso)],
      );
      csv += csvLine([
        "scheduled (Asia/Manila)",
        "service",
        "status",
        "source status",
        "procedure",
        "OPD/INP",
        "patient",
        "hospital no.",
        "requesting physician",
        "performed by",
      ]);
      for (const x of a.rows) {
        const local = formatDateTime(new Date(x.scheduled_at));
        csv += csvLine([
          local,
          x.service,
          x.status,
          x.raw_status ?? "",
          x.procedure_label,
          x.category,
          x.full_name,
          x.hid ?? "",
          x.physician ?? "",
          x.performer ?? "",
        ]);
        rows++;
      }
    });
  }
  await as(s, (c) => audit(c, "report.exported", { kind, period, mode, first_day: r.firstDay, rows, contains_patient_data: kind === "appointments" }));
  return { fileName: `puims-${kind}-${r.period}-${r.firstDay}.csv`, csv, rows };
}

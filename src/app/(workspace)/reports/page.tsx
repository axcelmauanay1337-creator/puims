import { AccessDenied } from "@/components/ui/AccessDenied";
import { BarChart } from "@/components/ui/BarChart";
import Link from "next/link";
import { Badge, Card, CardHeader, MetricCard, PageHeader, ShiftBadge, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/PrintButton";
import { SERVICE_LABELS, type ServiceType } from "@/lib/clinical/vocabulary";
import { METRIC_DEFINITIONS } from "@/lib/metrics/metrics";
import { classifyInstant } from "@/lib/time/shifts";
import { type IsoDate, addDays, formatDateTime, formatLongDate, monthShortName, parseIsoDate } from "@/lib/time/zoned";
import { getDailyReport } from "@/server/data";
import { getPeriodReport, REPORT_DEFINITIONS } from "@/server/reports";
import { can } from "@/server/session";
import { PERIODS, shiftPeriod, type DayMode, type Period } from "@/lib/metrics/periods";
import { getNow } from "@/server/clock";
import { guard } from "@/server/guard";

export const metadata = { title: "Reports & Analytics" };

function validDate(raw: unknown, today: IsoDate): IsoDate {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
  try {
    parseIsoDate(raw);
  } catch {
    return today;
  }
  return raw > today || raw < addDays(today, -366 * 5) ? today : raw;
}

const PERIOD_LABEL: Record<Period, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const sel = "min-h-9 rounded-[var(--radius-control)] border border-line bg-surface px-2 text-[13px] text-ink";

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const session = await guard("reports:unit");
  if (!session) return <AccessDenied what="unit reports" />;
  const sp = await searchParams;
  const mode: DayMode = sp.mode === "calendar" ? "calendar" : "operational";
  const period: Period = PERIODS.includes(sp.period as Period) ? (sp.period as Period) : "day";
  const today = classifyInstant(getNow())[mode === "operational" ? "operationalDate" : "calendarDate"];
  const date = validDate(sp.date, today);
  const r = await getPeriodReport(session, period, mode, date);
  const daily = period === "day" && mode === "operational" ? await getDailyReport(mode, date) : null;
  const m = r.metrics;
  const total = Object.values(m.serviceCounts).reduce((a, b) => a + b, 0);
  const canExport = can(session, "reports:export");
  const q = (o: Record<string, string>) => `/reports?${new URLSearchParams({ mode, period, date, ...o }).toString()}`;
  const prev = shiftPeriod(period, date, -1);
  const next = shiftPeriod(period, date, 1);
  const exportHref = (kind: string) => `/api/reports/export?${new URLSearchParams({ kind, mode, period, date }).toString()}`;

  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Reports & Analytics"
        crumbs={[{ label: "Management" }, { label: "Reports & Analytics" }]}
        description="Computed from documented events only, in Asia/Manila. Operational days run 06:00–06:00; calendar days 00:00–24:00. Every figure has a definition below."
        actions={<PrintButton label="Print report" />}
      />

      <form
        method="get"
        className="no-print mb-4 flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-3"
        aria-label="Report period"
      >
        <label className="text-[12px] text-ink-3">
          <span className="mb-1 block">Period</span>
          <select name="period" defaultValue={period} className={sel}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-ink-3">
          <span className="mb-1 block">Days counted as</span>
          <select name="mode" defaultValue={mode} className={sel}>
            <option value="operational">Operational days (06:00–06:00)</option>
            <option value="calendar">Calendar days (00:00–24:00)</option>
          </select>
        </label>
        <label className="text-[12px] text-ink-3">
          <span className="mb-1 block">Any date in the period</span>
          <input type="date" name="date" defaultValue={date} max={today} className={sel} />
        </label>
        <button
          type="submit"
          className="min-h-9 rounded-[var(--radius-control)] border border-accent bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover"
        >
          Show report
        </button>
        <span className="ml-auto flex gap-2 text-[13px]">
          <Link href={q({ date: prev })} className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 hover:bg-hover">
            ← Previous
          </Link>
          {next <= today ? (
            <Link href={q({ date: next })} className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 hover:bg-hover">
              Next →
            </Link>
          ) : null}
        </span>
      </form>

      <Card className="mb-4" aria-labelledby="win-h">
        <h2 id="win-h" className="text-[13px] font-semibold">
          {r.label} {r.partial ? <Badge tone="warning">in progress — counts up to now</Badge> : null}
        </h2>
        <p className="tabular mt-1 text-[12px] text-ink-2">
          {formatLongDate(r.firstDay)}
          {r.lastDay !== r.firstDay ? ` – ${formatLongDate(r.lastDay)}` : ""} · window {formatDateTime(new Date(r.windowStartIso))} →{" "}
          {formatDateTime(new Date(r.windowEndIso))} (end exclusive). Census reference: {formatDateTime(new Date(r.referenceIso))}.
        </p>
        {canExport ? (
          <div className="no-print mt-3 flex flex-wrap gap-2 text-[12px]">
            <a href={exportHref("summary")} className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 hover:bg-hover">
              Export summary (CSV)
            </a>
            <a href={exportHref("daily")} className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 hover:bg-hover">
              Export per-day counts (CSV)
            </a>
            <a
              href={exportHref("appointments")}
              className="rounded-[var(--radius-control)] border border-warning px-3 py-1.5 text-warning hover:bg-warning-soft"
            >
              Export appointment list — contains patient data (CSV)
            </a>
            <span className="self-center text-ink-3">Every export is recorded in the audit log.</span>
          </div>
        ) : null}
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Unique patients served" value={m.uniquePatients} definition={METRIC_DEFINITIONS.uniquePatients} />
        <MetricCard label="Completed service events" value={total} definition={METRIC_DEFINITIONS.serviceEvents} />
        <MetricCard label="Active ventilators" value={m.activeVentilators} note="At census reference" definition={METRIC_DEFINITIONS.activeVentilators} />
        <MetricCard
          label="OPD / INP"
          value={`${m.opdInp.OPD ?? 0} / ${m.opdInp.INP ?? 0}`}
          note={`Other ${m.opdInp.OTHER ?? 0}`}
          definition={METRIC_DEFINITIONS.opdInp}
        />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card aria-labelledby="svc-h">
          <CardHeader id="svc-h" title="Service counts" subtitle="Completed, documented" />
          <dl className="space-y-1.5 text-[13px]">
            {(Object.entries(m.serviceCounts) as [ServiceType, number][]).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <dt className="text-ink-2">{SERVICE_LABELS[k]}</dt>
                <dd className="tabular font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card aria-labelledby="tub-h">
          <CardHeader id="tub-h" title="Tubing replacement compliance" subtitle={REPORT_DEFINITIONS.tubingCompliance.definition} />
          <p className="tabular text-[28px] font-semibold">{pct(r.tubing.complianceRate)}</p>
          <dl className="mt-1 space-y-1 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-ink-2">Replacements due</dt>
              <dd className="tabular font-semibold">{r.tubing.due}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-2">✓ On time</dt>
              <dd className="tabular">{r.tubing.onTime}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-2">! Late</dt>
              <dd className="tabular">{r.tubing.late}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-2">‼ Not documented yet</dt>
              <dd className="tabular">{r.tubing.notDocumented}</dd>
            </div>
          </dl>
        </Card>
        <Card aria-labelledby="neb-h">
          <CardHeader id="neb-h" title="Nebulization by status" subtitle="Scheduled (or PRN actual) in the period" />
          <StatusCounts counts={m.nebulization} />
        </Card>
      </div>

      <Card className="mb-4" aria-labelledby="dx-h">
        <CardHeader id="dx-h" title="Diagnostics" subtitle={REPORT_DEFINITIONS.diagnosticRates.definition} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <caption className="sr-only">Diagnostic appointments and outcome rates</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
                {["Service", "Appointments", "Completed", "No-show", "Cancelled", "Rescheduled", "Still open", "Completed %", "No-show %", "Cancelled %"].map(
                  (h) => (
                    <th key={h} scope="col" className="py-1.5 pr-3 font-semibold">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="tabular">
              {r.diagnostics.map((d) => (
                <tr key={d.service} className="border-t border-line-soft">
                  <th scope="row" className="py-2 pr-3 text-left">
                    {d.service === "SPUTUM_INDUCTION" ? "Sputum induction" : d.service}
                  </th>
                  <td className="py-2 pr-3">{d.total}</td>
                  <td className="py-2 pr-3">{d.completed}</td>
                  <td className="py-2 pr-3">{d.noShow}</td>
                  <td className="py-2 pr-3">{d.cancelled}</td>
                  <td className="py-2 pr-3">{d.rescheduled}</td>
                  <td className="py-2 pr-3">{d.open}</td>
                  <td className="py-2 pr-3">{pct(d.completedRate)}</td>
                  <td className="py-2 pr-3">{pct(d.noShowRate)}</td>
                  <td className="py-2 pr-3">{pct(d.cancelledRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mb-4" aria-labelledby="wl-h">
        <CardHeader id="wl-h" title="Workload context by shift" subtitle={REPORT_DEFINITIONS.workload.excludes} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[13px]">
            <caption className="sr-only">Completed events and rostered RT-shifts by shift</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
                {["Shift", "Completed events", "RT-shifts rostered", "Events per RT-shift"].map((h) => (
                  <th key={h} scope="col" className="py-1.5 pr-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {r.workload.map((w) => (
                <tr key={w.shift} className="border-t border-line-soft">
                  <th scope="row" className="py-2 pr-3 text-left">
                    <ShiftBadge shift={w.shift} />
                  </th>
                  <td className="py-2 pr-3">{w.events}</td>
                  <td className="py-2 pr-3">{w.rtShifts}</td>
                  <td className="py-2 pr-3">{w.perRtShift ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {daily?.shifts && (
        <Card className="mb-4" aria-labelledby="shift-h">
          <CardHeader id="shift-h" title="Shift reports" subtitle="Each shift window of this operational day, by service" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <caption className="sr-only">Completed events by shift and service</caption>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    Shift
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    Unique patients
                  </th>
                  {(Object.keys(SERVICE_LABELS) as ServiceType[]).map((s) => (
                    <th key={s} scope="col" className="py-1.5 pr-3 font-semibold">
                      {SERVICE_LABELS[s]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular">
                {daily.shifts.map((s) => (
                  <tr key={s.shift} className="border-t border-line-soft">
                    <th scope="row" className="py-2 pr-3 text-left">
                      <ShiftBadge shift={s.shift} />
                    </th>
                    <td className="py-2 pr-3">{s.unique}</td>
                    {(Object.keys(SERVICE_LABELS) as ServiceType[]).map((k) => (
                      <td key={k} className="py-2 pr-3">
                        {s.events[k]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {r.monthlyTrend ? (
        <Card className="mb-4" aria-labelledby="trend-h">
          <CardHeader id="trend-h" title="Monthly trend — completed service events" subtitle="Calendar months, Asia/Manila — use to spot surges" />
          <BarChart
            data={r.monthlyTrend.map((x) => ({ label: monthShortName(x.month), value: x.total }))}
            caption="Synthetic demonstration data — not actual census."
            unit="events"
          />
        </Card>
      ) : r.perDay.length > 1 ? (
        <Card className="mb-4" aria-labelledby="trend-h">
          <CardHeader id="trend-h" title="Completed service events per day" subtitle={mode === "operational" ? "Operational days" : "Calendar days"} />
          <BarChart
            data={r.perDay.map((d) => ({ label: d.date.slice(8), value: d.events }))}
            caption="Synthetic demonstration data — not actual census."
            unit="events"
          />
        </Card>
      ) : null}

      <Card className="mb-4" aria-labelledby="def-h">
        <CardHeader id="def-h" title="Definitions" subtitle="What each figure counts, what it excludes, and its time rule" />
        <dl className="space-y-3 text-[12px]">
          {Object.values(REPORT_DEFINITIONS).map((d) => (
            <div key={d.id}>
              <dt className="font-semibold">{d.label}</dt>
              <dd className="text-ink-2">
                {d.definition} <b>Counts:</b> {d.counts} <b>Excludes:</b> {d.excludes} <b>Time:</b> {d.timeRule}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <SyntheticDataNote />
    </>
  );
}

function StatusCounts({ counts }: { counts: Partial<Record<string, number>> }) {
  const entries = Object.entries(counts).filter(([, v]) => v);
  if (!entries.length) return <p className="text-[12px] text-ink-3">None in this window.</p>;
  return (
    <dl className="space-y-1.5 text-[13px]">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between">
          <dt>
            <StatusBadge status={k} />
          </dt>
          <dd className="tabular font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

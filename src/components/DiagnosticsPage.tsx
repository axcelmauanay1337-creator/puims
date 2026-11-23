import Link from "next/link";
import { AppointmentList, BookAppointmentButton, MonthCalendar } from "@/components/diagnostics/Scheduling";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Card, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/PrintButton";
import type { DiagnosticService } from "@/lib/clinical/vocabulary";
import { calendarDateOf, formatShortDate } from "@/lib/time/zoned";
import { getNow } from "@/server/clock";
import { DIAG_STATUSES, listAppointments, listRtNames, parseFilter } from "@/server/diagnostics";
import { guard } from "@/server/guard";
import { can } from "@/server/session";

const TITLES: Record<DiagnosticService, string> = { PFT: "PFT Scheduling", ABG: "ABG", SPUTUM_INDUCTION: "Sputum Induction" };
const PATHS: Record<DiagnosticService, string> = { PFT: "/diagnostics/pft", ABG: "/diagnostics/abg", SPUTUM_INDUCTION: "/diagnostics/sputum" };
const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open (scheduled, pending, for reschedule)",
  SCHEDULED: "Scheduled",
  PENDING: "Pending",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
  CANCELLED: "Cancelled",
  FOR_RESCHEDULE: "For reschedule",
  RESCHEDULED: "Rescheduled",
};

const sel = "mt-1 block min-h-10 w-full rounded-[7px] border border-line bg-surface px-2 text-[13px]";

export async function DiagnosticsPage({
  service,
  searchParams,
}: {
  service: DiagnosticService;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="diagnostics" />;
  const sp = await searchParams;
  const today = calendarDateOf(getNow());
  const filter = parseFilter(sp, service, today);
  const view = sp.view === "calendar" ? "calendar" : "list";
  const [rows, rts] = await Promise.all([listAppointments(session, filter), listRtNames(session)]);
  const canSchedule = can(session, "diagnostics:schedule");
  const path = PATHS[service];
  const qs = (o: Record<string, string>) => {
    const p = new URLSearchParams({
      from: filter.from,
      to: filter.to,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.staffId ? { staff: filter.staffId } : {}),
      ...o,
    });
    return `${path}?${p.toString()}`;
  };
  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

  return (
    <>
      <PageHeader
        eyebrow="Diagnostics"
        title={TITLES[service]}
        crumbs={[{ label: "Diagnostics" }, { label: TITLES[service] }]}
        description={
          <>
            Times are Asia/Manila. Rescheduled appointments stay as separate, linked events; imported rows keep their original status text.
            {service === "PFT" ? " Open an appointment to start or view its PFT form (the official clinical record)." : null}
          </>
        }
        actions={
          <>
            {canSchedule ? <BookAppointmentButton service={service} /> : null}
            <PrintButton label="Print schedule" />
          </>
        }
      />

      <Card className="no-print mb-4">
        {/* Filters use GET with dates/status codes only — never names or hospital numbers. */}
        <form method="get" action={path} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <input type="hidden" name="view" value={view} />
          <label className="text-[12px] font-medium text-ink-2">
            From
            <input type="date" name="from" defaultValue={filter.from} className={sel} />
          </label>
          <label className="text-[12px] font-medium text-ink-2">
            To
            <input type="date" name="to" defaultValue={filter.to} className={sel} />
          </label>
          <label className="text-[12px] font-medium text-ink-2">
            Status
            <select name="status" defaultValue={filter.status ?? ""} className={sel}>
              <option value="">Any</option>
              {["OPEN", ...DIAG_STATUSES].map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] font-medium text-ink-2">
            OPD / INP
            <select name="category" defaultValue={filter.category ?? ""} className={sel}>
              <option value="">Any</option>
              <option value="OPD">OPD</option>
              <option value="INP">INP</option>
              <option value="OTHER">Other / not stated</option>
            </select>
          </label>
          <label className="text-[12px] font-medium text-ink-2">
            RT (scheduler or performer)
            <select name="staff" defaultValue={filter.staffId ?? ""} className={sel}>
              <option value="">Any</option>
              {rts.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="min-h-10 flex-1 rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover"
            >
              Apply
            </button>
            <Link href={path} className="inline-flex min-h-10 items-center rounded-[7px] border border-line px-3 text-[13px] hover:bg-hover">
              Reset
            </Link>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-ink-3">View:</span>
          <Link
            href={qs({ view: "list" })}
            aria-current={view === "list" ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${view === "list" ? "border-accent bg-accent-soft font-semibold" : "border-line hover:bg-hover"}`}
          >
            List
          </Link>
          <Link
            href={qs({ view: "calendar" })}
            aria-current={view === "calendar" ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${view === "calendar" ? "border-accent bg-accent-soft font-semibold" : "border-line hover:bg-hover"}`}
          >
            Calendar
          </Link>
          <span className="ml-auto text-ink-3">
            {rows.length} appointment(s) · {formatShortDate(filter.from)} – {formatShortDate(filter.to)}
            {Object.keys(counts).length
              ? " · " +
                Object.entries(counts)
                  .map(([k, n]) => `${STATUS_LABEL[k] ?? k} ${n}`)
                  .join(", ")
              : ""}
          </span>
        </div>
      </Card>

      <p className="mb-2 hidden text-[12px] print:block">
        {TITLES[service]} · {formatShortDate(filter.from)} – {formatShortDate(filter.to)} · printed {formatShortDate(today)} · contains patient information —
        handle per hospital policy.
      </p>

      {view === "calendar" ? (
        <MonthCalendar
          rows={rows}
          from={filter.from}
          to={filter.to}
          basePath={path}
          query={{
            ...(filter.status ? { status: filter.status } : {}),
            ...(filter.category ? { category: filter.category } : {}),
            ...(filter.staffId ? { staff: filter.staffId } : {}),
          }}
        />
      ) : (
        <AppointmentList rows={rows} />
      )}
      <SyntheticDataNote />
    </>
  );
}

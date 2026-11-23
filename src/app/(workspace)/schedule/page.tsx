import Link from "next/link";
import { BookAppointmentButton } from "@/components/diagnostics/Scheduling";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import type { DiagnosticService } from "@/lib/clinical/vocabulary";
import { addDays, calendarDateOf, formatCompactDate, formatTime } from "@/lib/time/zoned";
import { getNow } from "@/server/clock";
import { listAppointments, parseFilter, type AppointmentRow } from "@/server/diagnostics";
import { guard } from "@/server/guard";
import { can } from "@/server/session";

export const metadata = { title: "Schedule" };

const FILTERS: Array<[string, string, DiagnosticService[]]> = [
  ["all", "All", ["PFT", "ABG", "SPUTUM_INDUCTION"]],
  ["pft", "PFT", ["PFT"]],
  ["abg", "ABG", ["ABG"]],
  ["sputum", "Sputum", ["SPUTUM_INDUCTION"]],
];
const SHORT: Record<DiagnosticService, string> = { PFT: "PFT", ABG: "ABG", SPUTUM_INDUCTION: "Sputum" };

function shortProc(r: AppointmentRow): string {
  if (r.service !== "PFT") return SHORT[r.service];
  const p = r.procedureLabel.toUpperCase();
  if (p.startsWith("SIMPLE")) return p.includes("DLCO") ? "Simple + DLCO" : "Simple PFT";
  if (p.startsWith("COMPLETE")) return p.includes("DLCO") ? "Complete + DLCO" : "Complete PFT";
  if (p.startsWith("LUNG VOLUME")) return "Lung volume";
  return r.procedureLabel.length > 18 ? `${r.procedureLabel.slice(0, 17)}…` : r.procedureLabel;
}

export default async function SchedulePage({ searchParams }: PageProps<"/schedule">) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="the schedule" />;
  const sp = await searchParams;
  const today = calendarDateOf(getNow());
  const f = FILTERS.find(([k]) => k === sp.s) ?? FILTERS[0];
  const from = typeof sp.from === "string" ? sp.from : today;
  const base = parseFilter({ from, to: addDays(from, 13) }, "PFT", today);
  const rows = (await Promise.all(f[2].map((service) => listAppointments(session, { ...base, service }))))
    .flat()
    .sort((a, b) => a.scheduledIso.localeCompare(b.scheduledIso));
  const days = new Map<string, AppointmentRow[]>();
  for (const r of rows) {
    const d = calendarDateOf(new Date(r.scheduledIso));
    days.set(d, [...(days.get(d) ?? []), r]);
  }
  const canSchedule = can(session, "diagnostics:schedule");
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Schedule"
        crumbs={[{ label: "Workspace" }, { label: "Schedule" }]}
        description="PFT, ABG and sputum induction for the next two weeks. Tap a time for the patient's full details, status, the RT who performed it and the official PFT result."
        actions={
          canSchedule ? (
            <>
              <BookAppointmentButton service="PFT" label="Book PFT" />
              <BookAppointmentButton service="ABG" label="Book ABG" />
              <BookAppointmentButton service="SPUTUM_INDUCTION" label="Book sputum" />
            </>
          ) : undefined
        }
      />
      <nav aria-label="Test" className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(([k, label]) => (
          <Link
            key={k}
            href={`/schedule?s=${k}&from=${base.from}`}
            aria-current={k === f[0] ? "page" : undefined}
            className={`inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] ${k === f[0] ? "border-accent bg-accent font-semibold text-white" : "border-line bg-surface"}`}
          >
            {label}
          </Link>
        ))}
        <span className="ml-auto flex gap-2 text-[13px]">
          <Link
            className="inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 hover:bg-hover"
            href={`/schedule?s=${f[0]}&from=${addDays(base.from, -14)}`}
          >
            ← Earlier
          </Link>
          <Link
            className="inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 hover:bg-hover"
            href={`/schedule?s=${f[0]}&from=${addDays(base.from, 14)}`}
          >
            Later →
          </Link>
        </span>
      </nav>
      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line bg-surface px-4 py-6 text-center text-[13px] text-ink-2">
          Nothing booked in these two weeks.
        </p>
      ) : (
        [...days].map(([d, list]) => (
          <section key={d} aria-label={formatCompactDate(d)} className="mb-4">
            <h2 className="mb-2 px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-ink-2">
              {d === today ? "Today · " : d === addDays(today, 1) ? "Tomorrow · " : ""}
              {formatCompactDate(d)}
            </h2>
            <ul className="space-y-2">
              {list.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/diagnostics/appointments/${r.id}`}
                    className="flex min-h-14 items-center gap-3 rounded-[14px] border border-line bg-surface px-4 py-2.5 hover:border-[#c9cec6]"
                  >
                    <span className="tabular w-20 shrink-0 text-[15px] font-bold">{formatTime(new Date(r.scheduledIso))}</span>
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{r.patient.name}</span>
                    <span className="hidden rounded-full bg-neutral-soft px-2.5 py-1 text-[12px] font-semibold text-ink-2 sm:inline">{shortProc(r)}</span>
                    <StatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <SyntheticDataNote />
    </>
  );
}

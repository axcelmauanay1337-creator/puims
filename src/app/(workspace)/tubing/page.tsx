import { TubingList } from "@/components/clinical/Ventilation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { MetricCard, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { can } from "@/server/session";
import { listTubing } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Tubing Tracker" };

export default async function TubingPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="the tubing tracker" />;
  const { rows, policy } = await listTubing();
  const c = (s: string) => rows.filter((r) => r.status === s).length;
  return (
    <>
      <PageHeader
        eyebrow="Clinical services"
        title="Chamfecof Tubing Tracker"
        crumbs={[{ label: "Clinical services" }, { label: "Tubing Tracker" }]}
        description={`Next due = last documented installation + ${policy.intervalDays} days. A replacement is never marked complete automatically.`}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricCard label="Overdue" value={c("OVERDUE")} tone={c("OVERDUE") ? "danger" : undefined} />
        <MetricCard label="No documented install" value={c("NO_RECORD")} tone={c("NO_RECORD") ? "danger" : undefined} />
        <MetricCard label="Due this operational day" value={c("DUE")} tone={c("DUE") ? "warning" : undefined} />
        <MetricCard label={`Upcoming (≤ ${policy.upcomingWindowHours}h)`} value={c("UPCOMING")} />
        <MetricCard label="Current" value={c("CURRENT")} />
      </div>
      <p className="mb-3 text-[12px] text-ink-3">
        The {policy.intervalDays}-day interval and the {policy.upcomingWindowHours}-hour “upcoming” window are placeholders pending infection-prevention,
        manufacturer and hospital-policy confirmation (decision U-04). Each documented replacement keeps the interval that was in force at the time.
      </p>
      <TubingList
        rows={rows}
        intervalDays={policy.intervalDays}
        me={session.staffId}
        isChief={session.role === "CHIEF_RT_ADMIN"}
        canDocument={can(session, "clinical:document")}
      />
      <SyntheticDataNote />
    </>
  );
}

import Link from "next/link";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { BarChart } from "@/components/ui/BarChart";
import { ButtonLink, Card, CardHeader, EmptyState, MetricCard, PageHeader, ShiftBadge, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { describeDuration } from "@/lib/clinical/tubing";
import { SERVICE_LABELS, type ServiceType } from "@/lib/clinical/vocabulary";
import { METRIC_DEFINITIONS } from "@/lib/metrics/metrics";
import { SHIFT_DEFINITIONS, SHIFT_ORDER } from "@/lib/time/shifts";
import { formatDayTime, formatLongDate, formatTime, monthShortName, toLocalParts } from "@/lib/time/zoned";
import { getOverview, getShiftContext } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="the overview" />;
  const [ctx, ov] = await Promise.all([getShiftContext(), getOverview(session)]);
  const isChief = session.role === "CHIEF_RT_ADMIN";
  const now = new Date(ctx.nowIso);
  const hour = toLocalParts(now).hour;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const t = ov.tubingCounts;

  return (
    <>
      <PageHeader
        eyebrow={`${formatLongDate(ctx.calendarDate)} · ${isChief ? "Command center" : "My shift"}`}
        title={`${greeting}, ${session.displayName}`}
        description={
          isChief ? "Operational snapshot of the Pulmonary Unit for the current 06:00–06:00 operational day." : "What needs your attention this shift."
        }
        actions={
          <>
            <ButtonLink href="/handover">Shift handover</ButtonLink>
            {isChief ? (
              <ButtonLink href="/reports" variant="primary">
                View reports
              </ButtonLink>
            ) : (
              <ButtonLink href="/nebulization" variant="primary">
                Nebulization worklist
              </ButtonLink>
            )}
          </>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2" aria-labelledby="ctx-h">
        <h2 id="ctx-h" className="sr-only">
          Shift context
        </h2>
        <div>
          <p className="text-[11px] text-ink-3">Current shift</p>
          <ShiftBadge shift={ctx.shift} current />
        </div>
        <div>
          <p className="text-[11px] text-ink-3">Operational date (06:00–06:00)</p>
          <p className="text-[13px] font-semibold" data-testid="operational-date">
            {formatLongDate(ctx.operationalDate)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-ink-3">Shift ends</p>
          <p className="tabular text-[13px] font-semibold">{formatTime(new Date(ctx.shiftEndIso))} Asia/Manila</p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-ink-3">RTs on duty</p>
          <p className="text-[13px] font-semibold">{ctx.onDuty.length ? ctx.onDuty.map((o) => o.name).join(", ") : "No assignment recorded"}</p>
        </div>
        {!isChief && (
          <div>
            <p className="text-[11px] text-ink-3">Your assignment</p>
            <p className="text-[13px] font-semibold">{ctx.iAmOnDuty ? "On duty this shift" : "Not rostered this shift"}</p>
          </div>
        )}
      </Card>

      {isChief && ov.unit && (
        <section aria-labelledby="kpi-h" className="mb-4">
          <h2 id="kpi-h" className="sr-only">
            Unit metrics for this operational day
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label="Unique patients served"
              value={ov.unit.uniquePatients}
              note="This operational day, so far"
              definition={METRIC_DEFINITIONS.uniquePatients}
            />
            <MetricCard
              label="Completed service events"
              value={Object.values(ov.unit.serviceCounts).reduce((a, b) => a + b, 0)}
              note="All services, documented"
              definition={METRIC_DEFINITIONS.serviceEvents}
            />
            <MetricCard label="Active ventilators" value={ov.unit.activeVentilators} note="Current census" definition={METRIC_DEFINITIONS.activeVentilators} />
            <MetricCard
              label="Tubing due / overdue"
              value={`${t.DUE} / ${t.OVERDUE}`}
              tone={t.OVERDUE ? "danger" : t.DUE ? "warning" : undefined}
              note={`${t.UPCOMING} upcoming · ${t.NO_RECORD} no record · 7-day interval (policy-pending)`}
              definition={METRIC_DEFINITIONS.tubing}
            />
          </div>
        </section>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.45fr_1fr]">
        {isChief && ov.unit ? (
          <Card aria-labelledby="trend-h">
            <CardHeader
              id="trend-h"
              title={`Monthly completed service events · ${ov.unit.year}`}
              subtitle="Calendar months, Asia/Manila. Computed from documented events."
            />
            <BarChart
              data={ov.unit.monthly.map((m) => ({ label: monthShortName(m.month), value: m.total }))}
              highlightIndex={toLocalParts(now).month - 1}
              caption="Synthetic demonstration data — not actual census. Current month highlighted (month to date)."
              unit="events"
            />
          </Card>
        ) : (
          <Card aria-labelledby="dx-h">
            <CardHeader id="dx-h" title="Today's diagnostic schedule" subtitle="PFT · ABG · Sputum induction, this operational day" />
            <DiagnosticsList items={ov.todaysDiagnostics} />
          </Card>
        )}

        <Card aria-labelledby="attn-h">
          <CardHeader id="attn-h" title="Needs attention" subtitle="Tubing on active ventilator encounters and pending handover" />
          {ov.pendingHandover && (
            <Link
              href="/handover"
              className="mb-3 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-[#f0dfbf] bg-warning-soft p-2.5 text-[12px] hover:brightness-[0.98]"
            >
              <span aria-hidden="true" className="font-bold text-warning">
                !
              </span>
              <span>
                <b className="block text-ink">Handover awaiting acknowledgment</b>
                {SHIFT_DEFINITIONS[ov.pendingHandover.shift].label} shift · {ov.pendingHandover.items} carried-forward item(s) · from{" "}
                {ov.pendingHandover.outgoing}
              </span>
            </Link>
          )}
          {ov.tubing.length === 0 ? (
            <EmptyState title="No tubing actions needed">All active encounters have a current documented installation.</EmptyState>
          ) : (
            <ul className="divide-y divide-line-soft">
              {ov.tubing.slice(0, 6).map((r) => (
                <li key={r.encounterId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">
                      {r.ventilatorRef} · {r.wardRoom}
                    </p>
                    <p className="truncate text-[11px] text-ink-3">
                      {r.patient.hospitalId} ·{" "}
                      {r.nextDueIso
                        ? r.msUntilDue! <= 0
                          ? `overdue by ${describeDuration(r.msUntilDue!)}`
                          : `due ${formatDayTime(new Date(r.nextDueIso))} (in ${describeDuration(r.msUntilDue!)})`
                        : "no documented installation"}
                    </p>
                  </div>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
          <Link href="/tubing" className="mt-2 inline-block text-[12px] font-medium text-accent-ink hover:underline">
            Open tubing tracker
          </Link>
        </Card>
      </div>

      {isChief && ov.unit && (
        <div className="mb-4 grid gap-4 lg:grid-cols-3">
          <Card aria-labelledby="svc-h">
            <CardHeader id="svc-h" title="Service volume by type" subtitle="Completed, this operational day" />
            <dl className="space-y-1.5 text-[13px]">
              {(Object.entries(ov.unit.serviceCounts) as [ServiceType, number][]).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-ink-2">{SERVICE_LABELS[k]}</dt>
                  <dd className="tabular font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card aria-labelledby="neb-h">
            <CardHeader id="neb-h" title="Nebulization" subtitle="Scheduled or documented this operational day" />
            <CountList counts={ov.unit.nebulization} order={["SCHEDULED", "PENDING", "COMPLETED", "DELAYED", "NOT_GIVEN", "REFUSED", "CANCELLED"]} />
          </Card>
          <Card aria-labelledby="shiftsnap-h">
            <CardHeader id="shiftsnap-h" title="Shift snapshot" subtitle="Completed events by shift, today" />
            <dl className="space-y-1.5 text-[13px]">
              {SHIFT_ORDER.map((s) => (
                <div key={s} className="flex items-center justify-between">
                  <dt>
                    <ShiftBadge shift={s} current={s === ctx.shift} />
                  </dt>
                  <dd className="tabular font-semibold">{ov.unit!.byShift[s]}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 border-t border-line-soft pt-2 text-[12px] text-ink-2">
              OPD {ov.unit.opdInp.OPD ?? 0} · INP {ov.unit.opdInp.INP ?? 0} · Other {ov.unit.opdInp.OTHER ?? 0}{" "}
              <span className="text-ink-3">(unique patients)</span>
            </p>
          </Card>
        </div>
      )}

      {isChief && (
        <Card className="mb-4" aria-labelledby="dx2-h">
          <CardHeader id="dx2-h" title="Today's diagnostic schedule" subtitle="PFT · ABG · Sputum induction, this operational day" />
          <DiagnosticsList items={ov.todaysDiagnostics} />
        </Card>
      )}

      <Card className="mb-4" aria-labelledby="qa-h">
        <CardHeader id="qa-h" title="Quick actions" subtitle="Each opens the full, validated workflow" />
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/nebulization">Nebulization worklist</ButtonLink>
          <ButtonLink href="/ventilation">Ventilation</ButtonLink>
          <ButtonLink href="/tubing">Change of tubing</ButtonLink>
          <ButtonLink href="/diagnostics/pft">PFT schedule</ButtonLink>
          <ButtonLink href="/handover">Shift handover</ButtonLink>
        </div>
      </Card>
      <SyntheticDataNote />
    </>
  );
}

function DiagnosticsList({
  items,
}: {
  items: Array<{
    id: string;
    service: string;
    scheduledIso: string;
    status: string;
    patient: { hospitalId: string; name: string; id: string };
    procedureLabel: string;
  }>;
}) {
  if (items.length === 0) return <EmptyState title="No diagnostics scheduled">Nothing is scheduled for this operational day.</EmptyState>;
  return (
    <ul className="divide-y divide-line-soft">
      {items.slice(0, 10).map((d) => (
        <li key={d.id} className="flex items-center gap-3 py-2 text-[12px]">
          <span className="tabular w-11 shrink-0 font-semibold">{formatTime(new Date(d.scheduledIso))}</span>
          <span className="w-14 shrink-0 text-ink-3">{d.service === "SPUTUM_INDUCTION" ? "Sputum" : d.service}</span>
          <Link href={`/patients/${d.patient.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
            {d.patient.name} <span className="font-normal text-ink-3">· {d.patient.hospitalId}</span>
          </Link>
          <StatusBadge status={d.status} />
        </li>
      ))}
      {items.length > 10 && <li className="pt-2 text-[11px] text-ink-3">+{items.length - 10} more on the diagnostics pages</li>}
    </ul>
  );
}

function CountList({ counts, order }: { counts: Partial<Record<string, number>>; order: string[] }) {
  const total = order.reduce((a, k) => a + (counts[k] ?? 0), 0);
  if (!total) return <EmptyState title="None recorded">No administrations scheduled or documented today.</EmptyState>;
  return (
    <dl className="space-y-1.5 text-[13px]">
      {order
        .filter((k) => counts[k])
        .map((k) => (
          <div key={k} className="flex items-center justify-between">
            <dt>
              <StatusBadge status={k} />
            </dt>
            <dd className="tabular font-semibold">{counts[k]}</dd>
          </div>
        ))}
    </dl>
  );
}

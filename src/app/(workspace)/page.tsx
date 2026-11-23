import Link from "next/link";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { ButtonLink, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { TodayBoard } from "@/components/workspace/TodayBoard";
import { roleHas } from "@/lib/authz/permissions";
import { SHIFT_DEFINITIONS } from "@/lib/time/shifts";
import { formatLongDate, formatTime } from "@/lib/time/zoned";
import { listTubing } from "@/server/data";
import { guard } from "@/server/guard";
import { getToday } from "@/server/workspace";

export const metadata = { title: "Today" };

export default async function TodayPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="today's tasks" />;
  const [t, tub] = await Promise.all([getToday(session), listTubing()]);
  const shift = SHIFT_DEFINITIONS[t.shift];
  return (
    <>
      <PageHeader
        eyebrow={
          <span data-testid="operational-date">
            {formatLongDate(t.operationalDate)} · {shift.label} shift {shift.rangeLabel} · {session.displayName}
          </span>
        }
        title="Today"
        description={
          <span data-testid="today-summary">
            {t.dueNow.length} due now · {t.later.length} later this shift · {t.done.length} done · shift ends {formatTime(new Date(t.shiftEndIso))}
          </span>
        }
        actions={
          <>
            <ButtonLink href="/handover">Shift handover</ButtonLink>
            <ButtonLink href="/patients" variant="primary">
              Patients
            </ButtonLink>
          </>
        }
      />
      {t.pendingHandover ? (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-[14px] bg-warning-soft px-4 py-3 text-[13px] text-warning">
          <span className="min-w-0 flex-1">
            <b>{SHIFT_DEFINITIONS[t.pendingHandover.shift].label} handover</b> from {t.pendingHandover.outgoing} is waiting for acknowledgment ·{" "}
            {t.pendingHandover.items} open item(s).
          </span>
          <Link href="/handover" className="inline-flex min-h-9 items-center rounded-[8px] border border-[#ebcf94] bg-surface px-3 font-semibold text-ink">
            Open handover
          </Link>
        </div>
      ) : null}
      <TodayBoard
        dueNow={t.dueNow}
        later={t.later}
        done={t.done}
        canDocument={roleHas(session.role, "clinical:document")}
        intervalDays={tub.policy.intervalDays}
      />
      <SyntheticDataNote />
    </>
  );
}

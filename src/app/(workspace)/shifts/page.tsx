import { AccessDenied } from "@/components/ui/AccessDenied";
import { Card, CardHeader, PageHeader, ShiftBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { SHIFT_DEFINITIONS } from "@/lib/time/shifts";
import { formatCompactDate } from "@/lib/time/zoned";
import { RosterEditor } from "@/components/shifts/RosterEditor";
import { getEditableRoster } from "@/server/clinical";
import { getRoster, getShiftContext } from "@/server/data";
import { guard } from "@/server/guard";
import { can } from "@/server/session";

export const metadata = { title: "Shift Management" };

export default async function ShiftsPage() {
  const session = await guard("shifts:read");
  if (!session) return <AccessDenied what="shift management" />;
  const [roster, ctx] = await Promise.all([getRoster(8), getShiftContext()]);
  const editable = can(session, "shifts:manage") ? await getEditableRoster(session, 14) : null;
  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Shift Management"
        crumbs={[{ label: "Management" }, { label: "Shift Management" }]}
        description="Three 8-hour shifts in Asia/Manila. The operational day runs 6:00 AM–6:00 AM; events from midnight to 5:59 AM belong to the previous operational date's night shift."
      />
      <Card className="mb-4" aria-labelledby="rules-h">
        <CardHeader id="rules-h" title="Shift rules" subtitle="Server-authoritative classification by actual event time" />
        <ul className="flex flex-wrap gap-2">
          {(Object.keys(SHIFT_DEFINITIONS) as Array<keyof typeof SHIFT_DEFINITIONS>).map((s) => (
            <li key={s}>
              <ShiftBadge shift={s} current={s === ctx.shift} />
            </li>
          ))}
        </ul>
      </Card>
      {editable ? (
        <Card aria-labelledby="edit-h">
          <CardHeader
            id="edit-h"
            title="Roster (editable)"
            subtitle="Yesterday through the next 12 operational days · removals are kept in history, never deleted · every change is audited"
          />
          <RosterEditor roster={editable} />
        </Card>
      ) : null}
      {!editable ? (
        <Card aria-labelledby="roster-h">
          <CardHeader id="roster-h" title="Roster" subtitle="Yesterday through the next 6 operational days" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[12px]">
              <caption className="sr-only">Shift roster by operational date</caption>
              <thead>
                <tr>
                  <th scope="col" className="border-b border-line py-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                    Operational date
                  </th>
                  {(["MORNING", "AFTERNOON", "NIGHT"] as const).map((s) => (
                    <th
                      key={s}
                      scope="col"
                      className="border-b border-line px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3"
                    >
                      {SHIFT_DEFINITIONS[s].label} <span className="font-normal normal-case">{SHIFT_DEFINITIONS[s].rangeLabel}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roster.dates.map((d) => (
                  <tr key={d.date} className={d.date === roster.today ? "bg-accent-soft/50" : ""}>
                    <th scope="row" className="border-b border-line-soft py-2 pr-3 text-left font-medium">
                      {formatCompactDate(d.date)} {d.date === roster.today ? <span className="text-[11px] font-semibold text-accent-ink">· today</span> : null}
                    </th>
                    {d.shifts.map((s) => (
                      <td
                        key={s.shift}
                        className={`border-b border-line-soft px-2 py-2 align-top ${d.date === roster.today && s.shift === ctx.shift ? "font-semibold" : ""}`}
                      >
                        {s.staff.length ? s.staff.join(", ") : <span className="text-ink-3">Unassigned</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <SyntheticDataNote />
    </>
  );
}

import { ActivityTable } from "@/components/tables/ModuleTables";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Card, CardHeader, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { formatLongDate } from "@/lib/time/zoned";
import { listActivity } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "RT Daily Activities" };

export default async function ActivitiesPage() {
  const session = await guard("activity:read-own");
  if (!session) return <AccessDenied what="RT activity" />;
  const a = await listActivity(session);
  const unit = a.scope === "unit";
  return (
    <>
      <PageHeader
        eyebrow={`Operational day · ${formatLongDate(a.operationalDate)} (6:00 AM–6:00 AM)`}
        title={unit ? "RT Daily Activities" : "My Daily Activities"}
        crumbs={[{ label: "Workspace", href: "/" }, { label: "RT Daily Activities" }]}
        description={
          unit
            ? "Documented service events for every RT this operational day."
            : "Your documented service events this operational day. Other RTs' activity is visible to the Chief RT only."
        }
      />
      {unit && (
        <Card className="mb-4" aria-labelledby="ctx-h">
          <CardHeader
            id="ctx-h"
            title="Workload context"
            subtitle="Event counts are not a measure of performance: complexity, patient acuity, handovers and non-documented work are not captured. Listed alphabetically, not ranked."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Documented events per RT by shift</caption>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    RT
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    Morning
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    Afternoon
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    Night
                  </th>
                  <th scope="col" className="py-1.5 font-semibold">
                    Documented events
                  </th>
                </tr>
              </thead>
              <tbody className="tabular">
                {a.byStaff.map((s) => (
                  <tr key={s.staff} className="border-t border-line-soft">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                      {s.staff}
                    </th>
                    <td className="py-1.5 pr-3">{s.byShift.MORNING}</td>
                    <td className="py-1.5 pr-3">{s.byShift.AFTERNOON}</td>
                    <td className="py-1.5 pr-3">{s.byShift.NIGHT}</td>
                    <td className="py-1.5">{s.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <ActivityTable rows={a.rows} showStaff={unit} />
      <SyntheticDataNote />
    </>
  );
}

import { VentilationList } from "@/components/clinical/Ventilation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { ButtonLink, MetricCard, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { can } from "@/server/session";
import { METRIC_DEFINITIONS } from "@/lib/metrics/metrics";
import { listVentilation } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Mechanical Ventilation" };

export default async function VentilationPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="mechanical ventilation" />;
  const canDocument = can(session, "clinical:document");
  const rows = await listVentilation();
  const active = rows.filter((r) => r.status === "ACTIVE").length;
  return (
    <>
      <PageHeader
        eyebrow="Clinical services"
        title="Mechanical Ventilation"
        crumbs={[{ label: "Clinical services" }, { label: "Mechanical Ventilation" }]}
        description="Ventilator encounters with hook-in and disconnection times. A patient may have several encounters; history is never overwritten."
        actions={
          <>
            <ButtonLink href="/tubing">Tubing tracker</ButtonLink>
            {canDocument ? (
              <ButtonLink href="/ventilation/new" variant="primary">
                Record hook-in
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <div className="mb-4 grid max-w-md grid-cols-2 gap-3">
        <MetricCard label="Active encounters" value={active} definition={METRIC_DEFINITIONS.activeVentilators} />
        <MetricCard label="Discontinued (listed)" value={rows.length - active} />
      </div>
      <VentilationList rows={rows} canDocument={canDocument} />
      <SyntheticDataNote />
    </>
  );
}

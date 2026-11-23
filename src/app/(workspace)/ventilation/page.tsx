import { VentilationList } from "@/components/clinical/Ventilation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { ButtonLink, MetricCard, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { can } from "@/server/session";
import { METRIC_DEFINITIONS } from "@/lib/metrics/metrics";
import { listVentilation } from "@/server/data";
import { guard } from "@/server/guard";
import { availableUnits, listNiv } from "@/server/workspace";
import { NivSection } from "@/components/workspace/NivSection";

export const metadata = { title: "Vents / NIV" };

export default async function VentilationPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="mechanical ventilation" />;
  const canDocument = can(session, "clinical:document");
  const [rows, niv, hfnc, bipap] = await Promise.all([listVentilation(), listNiv(session), availableUnits(session, "HFNC"), availableUnits(session, "BIPAP")]);
  const active = rows.filter((r) => r.status === "ACTIVE").length;
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Vents / NIV"
        crumbs={[{ label: "Workspace" }, { label: "Vents / NIV" }]}
        description={`${active} on ventilator · ${niv.length} on HFNC or NIV. Machines come from the equipment board; settings history is never overwritten.`}
        actions={
          <>
            <ButtonLink href="/tubing">Change of tubing</ButtonLink>
            {canDocument ? (
              <ButtonLink href="/ventilation/new" variant="primary">
                Record hook-in
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <NivSection
        rows={niv}
        units={[...hfnc.map((u) => ({ ...u, kind: "HFNC" as const })), ...bipap.map((u) => ({ ...u, kind: "BIPAP" as const }))]}
        canDocument={canDocument}
      />
      <h2 className="mb-3 text-[18px] font-semibold">Ventilators</h2>
      <div className="mb-4 grid max-w-md grid-cols-2 gap-3">
        <MetricCard label="Active encounters" value={active} definition={METRIC_DEFINITIONS.activeVentilators} />
        <MetricCard label="Discontinued (listed)" value={rows.length - active} />
      </div>
      <VentilationList rows={rows} canDocument={canDocument} me={session.staffId} isChief={session.role === "CHIEF_RT_ADMIN"} />
      <SyntheticDataNote />
    </>
  );
}

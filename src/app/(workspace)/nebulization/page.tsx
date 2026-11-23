import { ActiveOrders, NebWorklist } from "@/components/clinical/Nebulization";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { ButtonLink, PageHeader, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { formatLongDate } from "@/lib/time/zoned";
import { listNebulization } from "@/server/data";
import { guard } from "@/server/guard";
import { can } from "@/server/session";

export const metadata = { title: "Nebulization" };

export default async function NebulizationPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="nebulization" />;
  const n = await listNebulization();
  const canOrder = can(session, "orders:enter");
  const canDocument = can(session, "clinical:document");
  return (
    <>
      <PageHeader
        eyebrow={`Clinical services · ${formatLongDate(n.operationalDate)}`}
        title="Nebulization"
        crumbs={[{ label: "Clinical services" }, { label: "Nebulization" }]}
        description="Expected doses come only from the times written on each order. Nothing is documented automatically: every outcome is recorded by an RT, in their own name, with the actual time."
        actions={
          canOrder ? (
            <ButtonLink href="/nebulization/orders/new" variant="primary">
              New order
            </ButtonLink>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap gap-3" aria-label="Status counts">
        {Object.entries(n.counts).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5 text-[12px]">
            <StatusBadge status={k} /> <span className="tabular font-semibold">{v}</span>
          </span>
        ))}
      </div>
      <h2 className="mb-2 text-[15px] font-semibold">Worklist — this operational day (06:00–06:00)</h2>
      <NebWorklist rows={n.rows} me={session.staffId} isChief={session.role === "CHIEF_RT_ADMIN"} canDocument={canDocument} />
      <h2 className="mb-2 mt-8 text-[15px] font-semibold">Active orders</h2>
      {!canOrder && <p className="mb-2 text-[12px] text-ink-3">Orders are entered and discontinued by Respiratory Therapists.</p>}
      <ActiveOrders orders={n.activeOrders} canDocument={canDocument} canOrder={canOrder} />
      <SyntheticDataNote />
    </>
  );
}

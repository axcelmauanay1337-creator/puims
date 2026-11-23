import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { EquipmentBoard } from "@/components/workspace/EquipmentBoard";
import { guard } from "@/server/guard";
import { can } from "@/server/session";
import { listEquipment } from "@/server/workspace";

export const metadata = { title: "Equipment" };

export default async function EquipmentPage() {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="the equipment board" />;
  const rows = await listEquipment(session);
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Equipment"
        crumbs={[{ label: "Workspace" }, { label: "Equipment" }]}
        description="Every ventilator, HFNC and BiPAP unit: who has it, what is free, what is due for maintenance and what is rented. Hook-in and HFNC/NIV only offer free units."
      />
      <EquipmentBoard rows={rows} canManage={can(session, "settings:manage")} />
      <SyntheticDataNote />
    </>
  );
}

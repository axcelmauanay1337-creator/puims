import { PatientsTable } from "@/components/tables/ModuleTables";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { ButtonLink, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { can } from "@/server/session";
import { listPatients } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Patient Master" };

export default async function PatientsPage() {
  const session = await guard("patients:read");
  if (!session) return <AccessDenied what="the patient masterlist" />;
  const rows = await listPatients();
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Patient Master"
        crumbs={[{ label: "Workspace", href: "/" }, { label: "Patient Master" }]}
        description="Register a patient once. Hook-in, neb orders, HFNC/NIV and test bookings pick the patient from here — no retyping. Precautions, special endorsements and the patient's own supplies show on every task for that patient."
        actions={
          can(session, "patients:write") ? (
            <ButtonLink href="/patients/new" variant="primary">
              Register patient
            </ButtonLink>
          ) : undefined
        }
      />
      <PatientsTable rows={rows} />
      <SyntheticDataNote />
    </>
  );
}

import { PatientsTable } from "@/components/tables/ModuleTables";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { ButtonLink, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { can } from "@/server/session";
import { listPatients } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Patient Masterlist" };

export default async function PatientsPage() {
  const session = await guard("patients:read");
  if (!session) return <AccessDenied what="the patient masterlist" />;
  const rows = await listPatients();
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Patient Masterlist"
        crumbs={[{ label: "Workspace", href: "/" }, { label: "Patient Masterlist" }]}
        description="Search by hospital number or name. Filtering happens on this screen only — search terms are never placed in the page address. Possible duplicates are shown for review when registering; records are never merged automatically."
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

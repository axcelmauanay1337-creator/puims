import { notFound } from "next/navigation";
import { PatientForm } from "@/components/patients/PatientForm";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { getPatientForEdit } from "@/server/clinical";
import { guard } from "@/server/guard";

export const metadata = { title: "Correct patient details" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function EditPatientPage({ params }: PageProps<"/patients/[id]/edit">) {
  const session = await guard("patients:write");
  if (!session) return <AccessDenied what="patient corrections" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const p = await getPatientForEdit(session, id);
  if (!p) notFound();
  return (
    <>
      <PageHeader
        title="Correct patient details"
        crumbs={[{ label: "Patient Master", href: "/patients" }, { label: "Patient profile", href: `/patients/${id}` }, { label: "Correct" }]}
        description="Every change is kept in the record's correction history with who, when and why. Service history stays linked to this patient."
      />
      <PatientForm mode="correct" initial={p} />
    </>
  );
}

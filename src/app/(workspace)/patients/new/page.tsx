import { PatientForm } from "@/components/patients/PatientForm";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { guard } from "@/server/guard";

export const metadata = { title: "Register patient" };

export default async function NewPatientPage() {
  if (!(await guard("patients:write"))) return <AccessDenied what="patient registration" />;
  return (
    <>
      <PageHeader
        title="Register patient"
        crumbs={[{ label: "Patient Master", href: "/patients" }, { label: "Register patient" }]}
        description="Hospital number and date of birth are optional. Before saving, PUIMS shows any possible existing records for you to check — it never merges records on its own."
      />
      <PatientForm mode="register" />
    </>
  );
}

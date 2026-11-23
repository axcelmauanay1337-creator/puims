import { StaffAdmin } from "@/components/admin/StaffAdmin";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { listStaff } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "RT Staff" };

export default async function StaffPage() {
  const session = await guard("staff:manage");
  if (!session) return <AccessDenied what="RT staff management" />;
  const rows = await listStaff();
  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="RT Staff"
        crumbs={[{ label: "Management" }, { label: "RT Staff" }]}
        description="Individual accounts only — no shared logins. There is exactly one Chief RT administrator; you can only create Respiratory Therapist accounts. Sensitive actions ask you to confirm your password and authenticator code."
      />
      <StaffAdmin rows={rows} selfId={session.staffId} />
    </>
  );
}

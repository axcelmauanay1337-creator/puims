import { HookInForm } from "@/components/clinical/Ventilation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { listTubing } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Record ventilator hook-in" };

export default async function HookInPage() {
  if (!(await guard("clinical:document"))) return <AccessDenied what="ventilation documentation" />;
  const { policy } = await listTubing();
  return (
    <>
      <PageHeader
        title="Record ventilator hook-in"
        crumbs={[{ label: "Mechanical Ventilation", href: "/ventilation" }, { label: "Hook-in" }]}
        description="Starts a new ventilator encounter in your name. A patient cannot have two overlapping encounters. Hook-in details cannot be edited later."
      />
      <HookInForm intervalDays={policy.intervalDays} />
    </>
  );
}

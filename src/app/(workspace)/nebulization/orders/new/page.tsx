import { NewOrderForm } from "@/components/clinical/Nebulization";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { guard } from "@/server/guard";
import { patientBrief } from "@/server/workspace";

export const metadata = { title: "New nebulization order" };

export default async function NewOrderPage({ searchParams }: PageProps<"/nebulization/orders/new">) {
  // Decision 2026-11-22: only Respiratory Therapists enter orders (not the Chief RT).
  const session = await guard("orders:enter");
  if (!session) return <AccessDenied what="entering nebulization orders (Respiratory Therapists only)" />;
  const sp = await searchParams;
  const initial = await patientBrief(session, typeof sp.patient === "string" ? sp.patient : undefined);
  return (
    <>
      <PageHeader
        title="New nebulization order"
        crumbs={[{ label: "Nebulization", href: "/nebulization" }, { label: "New order" }]}
        description="Transcribe the physician's order exactly as written. Orders cannot be edited afterwards — a wrong order is discontinued with a reason and entered again."
      />
      <NewOrderForm initialPatient={initial} />
    </>
  );
}

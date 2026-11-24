import { HookInForm } from "@/components/clinical/Ventilation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { listTubing } from "@/server/data";
import { guard } from "@/server/guard";
import { availableUnits, boardUnitCount, patientBrief } from "@/server/workspace";

export const metadata = { title: "Record ventilator hook-in" };

export default async function HookInPage({ searchParams }: PageProps<"/ventilation/new">) {
  const session = await guard("clinical:document");
  if (!session) return <AccessDenied what="ventilation documentation" />;
  const sp = await searchParams;
  const [{ policy }, units, onBoard, initial] = await Promise.all([
    listTubing(),
    availableUnits(session, "VENTILATOR"),
    boardUnitCount(session, "VENTILATOR"),
    patientBrief(session, typeof sp.patient === "string" ? sp.patient : undefined),
  ]);
  return (
    <>
      <PageHeader
        title="Record ventilator hook-in"
        crumbs={[{ label: "Vents / NIV", href: "/ventilation" }, { label: "Hook-in" }]}
        description="Starts a new ventilator encounter in your name. A patient cannot have two overlapping encounters. Hook-in details cannot be edited later."
      />
      <HookInForm intervalDays={policy.intervalDays} units={units} boardRequired={onBoard > 0} initialPatient={initial} />
    </>
  );
}

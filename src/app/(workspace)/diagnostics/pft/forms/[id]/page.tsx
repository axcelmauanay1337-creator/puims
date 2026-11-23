import Link from "next/link";
import { notFound } from "next/navigation";
import { PftFormScreen } from "@/components/diagnostics/PftForm";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/PrintButton";
import { formatDateTime } from "@/lib/time/zoned";
import { guard } from "@/server/guard";
import { getPftForm } from "@/server/pft";

export const metadata = { title: "PFT form" };

const STATUS = {
  DRAFT: ["Draft", "warning"],
  RT_SIGNED: ["RT signed — awaiting pulmonologist", "info"],
  FINAL: ["Final — official record", "success"],
} as const;

export default async function PftFormPage({ params }: PageProps<"/diagnostics/pft/forms/[id]">) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="PFT records" />;
  const { id } = await params;
  const form = await getPftForm(session, id);
  if (!form) notFound();
  const [label, tone] = STATUS[form.status];
  return (
    <>
      <div className="no-print">
        <PageHeader
          eyebrow="Diagnostics · PFT"
          title={`PFT form · ${form.draft.patientName}`}
          crumbs={[
            { label: "Diagnostics" },
            { label: "PFT Scheduling", href: "/diagnostics/pft" },
            { label: "Appointment", href: `/diagnostics/appointments/${form.appointmentId}` },
            { label: "PFT form" },
          ]}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={tone}>{label}</Badge>
              <span className="text-ink-3">
                Started by {form.createdBy} · {formatDateTime(new Date(form.createdIso))} · appointment{" "}
                {formatDateTime(new Date(form.appointment.scheduledIso))}
              </span>
            </span>
          }
          actions={<PrintButton label="Print form" />}
        />
      </div>
      <PftFormScreen form={form} />
      <p className="no-print mt-4 text-[12px]">
        <Link href={`/patients/${form.patientId}`} className="text-accent-ink hover:underline">
          Patient profile →
        </Link>
      </p>
      <div className="no-print">
        <SyntheticDataNote />
      </div>
    </>
  );
}

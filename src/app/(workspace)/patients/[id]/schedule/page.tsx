import { notFound } from "next/navigation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader, StatusBadge } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/PrintButton";
import { calendarDateOf, formatDateTime, formatShortDate } from "@/lib/time/zoned";
import { getNow } from "@/server/clock";
import { patientSchedule } from "@/server/diagnostics";
import { guard } from "@/server/guard";

export const metadata = { title: "Patient schedule" };

const SERVICE = { PFT: "PFT", ABG: "ABG", SPUTUM_INDUCTION: "Sputum induction" } as Record<string, string>;

/** Printable patient appointment sheet (PRODUCT_REQUIREMENTS §8). Printing is audited. */
export default async function PatientSchedulePage({ params }: PageProps<"/patients/[id]/schedule">) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="patient schedules" />;
  const { id } = await params;
  const data = await patientSchedule(session, id);
  if (!data) notFound();
  const { patient: p, appointments } = data;
  return (
    <>
      <PageHeader
        eyebrow="Diagnostics"
        title="Patient schedule"
        crumbs={[{ label: "Patient Master", href: "/patients" }, { label: p.full_name, href: `/patients/${p.id}` }, { label: "Schedule" }]}
        actions={<PrintButton label="Print" />}
      />
      <section className="rounded-[10px] border border-line bg-surface p-5 print:border-0 print:p-0">
        <h2 className="text-[18px] font-semibold">{p.full_name}</h2>
        <p className="text-[13px] text-ink-2">
          Hospital no.: {p.hospital_patient_id ?? "—"} · Sex: {p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : "Not recorded"} · Category: {p.category}
        </p>
        <div className="mt-4 overflow-x-auto print:overflow-visible" tabIndex={0} role="region" aria-label="Appointments">
          <table className="w-full min-w-[560px] text-[13px] print:min-w-0">
            <caption className="sr-only">Appointments</caption>
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
                <th scope="col" className="py-1.5 pr-3">
                  Date / time (Asia/Manila)
                </th>
                <th scope="col" className="py-1.5 pr-3">
                  Service
                </th>
                <th scope="col" className="py-1.5 pr-3">
                  Procedure
                </th>
                <th scope="col" className="py-1.5 pr-3">
                  Requesting physician
                </th>
                <th scope="col" className="py-1.5">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((a) => (
                <tr key={a.id} className="border-b border-line-soft align-top">
                  <td className="tabular py-1.5 pr-3 whitespace-nowrap">{formatDateTime(new Date(a.scheduledIso))}</td>
                  <td className="py-1.5 pr-3">{SERVICE[a.service] ?? ""}</td>
                  <td className="py-1.5 pr-3">{a.procedureLabel}</td>
                  <td className="py-1.5 pr-3">{a.requestingPhysician ?? "—"}</td>
                  <td className="py-1.5">
                    <StatusBadge status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!appointments.length ? <p className="mt-3 text-[13px] text-ink-2">No appointments in the last 90 days or ahead.</p> : null}
        <p className="mt-4 text-[11px] text-ink-3">
          Printed {formatShortDate(calendarDateOf(getNow()))} by {session.displayName}. Contains patient information — hand only to the patient or authorized
          staff.
        </p>
      </section>
    </>
  );
}

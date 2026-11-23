import Link from "next/link";
import { notFound } from "next/navigation";
import { AppointmentActions } from "@/components/diagnostics/Scheduling";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, CardHeader, PageHeader, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { getAppointment } from "@/server/diagnostics";
import { guard } from "@/server/guard";
import { can } from "@/server/session";

export const metadata = { title: "Appointment" };

const FIELD_LABEL: Record<string, string> = {
  scheduled_at: "date/time",
  procedure_label: "procedure",
  requesting_physician: "physician",
  category: "OPD/INP",
  remarks: "remarks",
};

const SERVICE_TITLE = { PFT: "PFT", ABG: "ABG", SPUTUM_INDUCTION: "Sputum induction" } as const;
const SERVICE_PATH = { PFT: "/diagnostics/pft", ABG: "/diagnostics/abg", SPUTUM_INDUCTION: "/diagnostics/sputum" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 border-t border-line-soft py-1.5 text-[13px] first:border-t-0">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default async function AppointmentPage({ params }: PageProps<"/diagnostics/appointments/[id]">) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="diagnostics" />;
  const { id } = await params;
  const a = await getAppointment(session, id);
  if (!a) notFound();
  const title = SERVICE_TITLE[a.service];
  return (
    <>
      <PageHeader
        eyebrow="Diagnostics"
        title={`${title} · ${formatDateTime(new Date(a.scheduledIso))}`}
        crumbs={[{ label: "Diagnostics" }, { label: title, href: SERVICE_PATH[a.service] }, { label: "Appointment" }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={a.status} />
            {a.source === "IMPORT" ? <Badge tone="info">Imported</Badge> : null}
            {a.rawStatus ? <span className="text-ink-3">Source status: “{a.rawStatus}”</span> : null}
          </span>
        }
      />
      <div className="mb-4">
        <AppointmentActions
          id={a.id}
          status={a.status}
          service={a.service}
          canSchedule={can(session, "diagnostics:schedule")}
          canVoid={a.canVoid}
          canStartPft={session.role === "RESPIRATORY_THERAPIST" && ["SCHEDULED", "PENDING", "COMPLETED"].includes(a.status)}
          pftFormId={a.pftFormId}
          edit={
            a.canCorrect
              ? {
                  scheduledIso: a.scheduledIso,
                  procedureLabel: a.procedureLabel,
                  requestingPhysician: a.requestingPhysician,
                  category: a.category,
                  remarks: a.remarks,
                  updatedIso: a.updatedIso,
                }
              : null
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="det-h">
          <CardHeader id="det-h" title="Details" />
          <dl>
            <Row label="Patient">
              <Link href={`/patients/${a.patient.id}`} className="font-medium hover:underline">
                {a.patient.name}
              </Link>{" "}
              <span className="text-ink-3">· {a.patient.hospitalId ?? "No hospital no."}</span>
            </Row>
            <Row label="Procedure (as recorded)">{a.procedureLabel}</Row>
            <Row label="OPD / INP">{a.category}</Row>
            <Row label="Requesting physician">{a.requestingPhysician ?? "—"}</Row>
            {a.paymentClass ? <Row label="Payment">{a.paymentClass}</Row> : null}
            {a.contactNote ? (
              <Row label="Contact (as written)">
                {a.contactNote} <span className="text-[11px] text-ink-3">· not verified as a phone number · viewing is logged</span>
              </Row>
            ) : null}
            {a.rawAgeSex ? <Row label="Age / sex (source)">{a.rawAgeSex}</Row> : null}
            <Row label="Scheduled by">{a.scheduler ?? (a.source === "IMPORT" ? "Imported record" : "—")}</Row>
            <Row label="Performed by">{a.performedBy ?? "—"}</Row>
            {a.statusReason ? <Row label="Status reason">{a.statusReason}</Row> : null}
            <Row label="Remarks">{a.remarks ?? "—"}</Row>
            <Row label="Recorded">{formatDateTime(new Date(a.receivedIso))}</Row>
            {a.importRef ? (
              <Row label="Import provenance">
                <Link href={`/import/${a.importRef.batchId}`} className="hover:underline">
                  {a.importRef.fileName}
                </Link>{" "}
                · sheet {a.importRef.sheet}, row {a.importRef.row}
              </Row>
            ) : null}
          </dl>
          <p className="mt-3 text-[12px]">
            <Link href={`/patients/${a.patient.id}/schedule`} className="text-accent-ink hover:underline">
              Printable patient schedule →
            </Link>
          </p>
        </Card>
        <div className="space-y-4">
          <Card aria-labelledby="lin-h">
            <CardHeader id="lin-h" title="Reschedule lineage" subtitle="Every booking is kept; each reschedule links to the next." />
            {a.lineage.length > 1 ? (
              <ol className="space-y-1 text-[13px]">
                {a.lineage.map((l, i) => (
                  <li key={l.id} className="flex items-center gap-2">
                    <span className="text-ink-3">{i + 1}.</span>
                    {l.current ? (
                      <span className="font-semibold">{formatDateTime(new Date(l.scheduledIso))} (this appointment)</span>
                    ) : (
                      <Link href={`/diagnostics/appointments/${l.id}`} className="hover:underline">
                        {formatDateTime(new Date(l.scheduledIso))}
                      </Link>
                    )}
                    <StatusBadge status={l.status} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-ink-2">Not rescheduled.</p>
            )}
          </Card>
          <Card aria-labelledby="his-h">
            <CardHeader id="his-h" title="History" subtitle="From the audit trail (status changes only)." />
            <ol className="space-y-1.5 text-[13px]">
              {a.history.map((h, i) => (
                <li key={i}>
                  <span className="tabular text-ink-3">{formatDateTime(new Date(h.atIso))}</span> ·{" "}
                  {h.action.endsWith(".insert")
                    ? "Booked"
                    : h.toStatus && h.fromStatus !== h.toStatus
                      ? `${h.fromStatus ?? "—"} → ${h.toStatus}`
                      : h.changed.length
                        ? `Corrected: ${h.changed.map((k) => FIELD_LABEL[k] ?? k).join(", ")}`
                        : "Updated"}
                  {h.actor ? ` · ${h.actor}` : ""}
                  {h.reason ? <span className="block text-[12px] text-ink-2">“{h.reason}”</span> : null}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      <SyntheticDataNote />
    </>
  );
}

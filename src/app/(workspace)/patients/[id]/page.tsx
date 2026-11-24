import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, ShiftBadge, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { SERVICE_LABELS } from "@/lib/clinical/vocabulary";
import { formatClock, formatDateTime, formatShortDate } from "@/lib/time/zoned";
import { getPatientRevisions } from "@/server/clinical";
import { getPatientProfile } from "@/server/data";
import { availableUnits } from "@/server/workspace";
import { PatientFlagsCard, PatientQuickActions, PatientStatusPanel } from "@/components/workspace/PatientPanels";
import { guard } from "@/server/guard";
import { can } from "@/server/session";

export const metadata = { title: "Patient profile" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export default async function PatientProfilePage({ params }: PageProps<"/patients/[id]">) {
  const session = await guard("patients:read");
  if (!session) return <AccessDenied what="patient records" />;
  const { id } = await params;
  // The URL carries only the internal UUID — never a name or hospital number.
  if (!UUID_RE.test(id)) notFound();
  const profile = await getPatientProfile(id);
  if (!profile) notFound();
  const { patient: p } = profile;
  const revisions = await getPatientRevisions(session, id);
  const [hfnc, bipap] = await Promise.all([availableUnits(session, "HFNC"), availableUnits(session, "BIPAP")]);
  const flags = { precautions: p.precautions, ownSupplies: p.ownSupplies, endorsement: p.endorsement };
  const FIELD: Record<string, string> = {
    full_name: "Name",
    hospital_patient_id: "Hospital no.",
    date_of_birth: "Date of birth",
    sex: "Sex",
    category: "Category",
    ward_room: "Ward / room",
    contact_info: "Contact info",
    attending_physician: "Attending physician",
    height_cm: "Height (cm)",
    weight_kg: "Weight (kg)",
    voided_at: "Voided",
    void_reason: "Void reason",
  };

  return (
    <>
      <PageHeader
        title={p.fullName}
        crumbs={[{ label: "Patient Master", href: "/patients" }, { label: "Patient profile" }]}
        actions={can(session, "patients:write") ? <ButtonLink href={`/patients/${p.id}/edit`}>Correct details</ButtonLink> : undefined}
      />

      <PatientQuickActions
        patient={{ id: p.id, title: p.fullName, subtitle: `${p.hospitalPatientId}${p.wardRoom ? ` · ${p.wardRoom}` : ""}`, wardRoom: p.wardRoom }}
        canDocument={can(session, "clinical:document")}
        canOrder={can(session, "orders:enter")}
        canSchedule={can(session, "diagnostics:schedule")}
        nivUnits={[...hfnc.map((u) => ({ ...u, kind: "HFNC" as const })), ...bipap.map((u) => ({ ...u, kind: "BIPAP" as const }))]}
        flags={flags}
      />
      <PatientStatusPanel
        patientId={p.id}
        name={p.fullName}
        mgh={p.mgh}
        activeNebs={profile.nebOrders.filter((o) => o.active).length}
        onVent={p.onVent}
        onNiv={p.onNiv}
        canWrite={can(session, "patients:write")}
        canOrder={can(session, "orders:enter")}
      />
      <PatientFlagsCard patientId={p.id} flags={flags} canEdit={can(session, "patients:write")} />

      <Card className="mb-4" aria-labelledby="id-h">
        <h2 id="id-h" className="sr-only">
          Patient identity
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3 lg:grid-cols-6">
          <Field k="Hospital no." v={<span className="tabular font-semibold">{p.hospitalPatientId}</span>} />
          <Field k="Date of birth" v={p.dateOfBirth ? formatShortDate(p.dateOfBirth) : "Not recorded"} />
          <Field k="Age" v={p.age !== null ? `${p.age} (from DOB)` : "—"} />
          <Field k="Sex" v={p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : "Not recorded"} />
          <Field k="Category" v={<Badge tone={p.category === "INP" ? "info" : "neutral"}>{p.category}</Badge>} />
          <Field k="Ward / room" v={p.wardRoom ?? "—"} />
          <Field k="Contact info" v={p.contactInfo ?? "—"} />
          <Field k="Attending physician" v={p.attendingPhysician ?? "—"} />
          <Field k="Height · weight" v={`${p.heightCm !== null ? `${p.heightCm} cm` : "—"} · ${p.weightKg !== null ? `${p.weightKg} kg` : "—"}`} />
          <Field k="Record source" v={p.provenance === "IMPORT" ? "Imported (provenance retained)" : "Manual entry"} />
          <Field k="Created" v={formatDateTime(new Date(p.createdAt))} />
          <Field k="Last updated" v={formatDateTime(new Date(p.updatedAt))} />
        </dl>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="vent-h">
          <CardHeader id="vent-h" title="Ventilator encounters" subtitle="Complete history; encounters are never overwritten" />
          {profile.encounters.length === 0 ? (
            <EmptyState title="No ventilator encounters" />
          ) : (
            <ul className="divide-y divide-line-soft text-[12px]">
              {profile.encounters.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <b className="block text-[13px]">
                      {e.ventilatorRef} · {e.wardRoom}
                    </b>
                    {formatDateTime(new Date(e.hookedIso))} → {e.disconnectedIso ? formatDateTime(new Date(e.disconnectedIso)) : "ongoing"}
                  </span>
                  <StatusBadge status={e.status} />
                </li>
              ))}
            </ul>
          )}
          {profile.tubing.map((t) => (
            <p key={t.encounterId} className="mt-2 flex items-center gap-2 text-[12px]">
              Tubing on {t.ventilatorRef}: <StatusBadge status={t.status} />
              {t.nextDueIso ? <span className="text-ink-3">next due {formatDateTime(new Date(t.nextDueIso))}</span> : null}
            </p>
          ))}
        </Card>

        <Card aria-labelledby="neb-h">
          <CardHeader id="neb-h" title="Nebulization orders" subtitle="As entered from the clinician's order — times are never inferred" />
          {profile.nebOrders.length === 0 ? (
            <EmptyState title="No nebulization orders" />
          ) : (
            <ul className="divide-y divide-line-soft text-[12px]">
              {profile.nebOrders.map((o) => (
                <li key={o.id} className={`py-2 ${o.active ? "" : "text-ink-3"}`}>
                  <b className="block text-[13px]">
                    {o.orderReference}
                    {o.active ? null : <span className="ml-2 font-normal">· Stopped{o.stopReason ? `: ${o.stopReason}` : ""}</span>}
                  </b>
                  {o.medication} · <Badge>{o.frequency}</Badge> ·{" "}
                  {o.prescribedTimes.length ? o.prescribedTimes.map(formatClock).join(", ") : "no scheduled times on order"} · Attending: {o.prescriber}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="dx-h">
          <CardHeader id="dx-h" title="Diagnostic appointments" subtitle="Each appointment and reschedule kept as its own event" />
          {profile.diagnostics.length === 0 ? (
            <EmptyState title="No diagnostic appointments" />
          ) : (
            <ul className="divide-y divide-line-soft text-[12px]">
              {profile.diagnostics.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <b className="block text-[13px]">
                      {d.service === "SPUTUM_INDUCTION" ? "Sputum induction" : d.service} · {formatDateTime(new Date(d.scheduledIso))}
                    </b>
                    {d.procedureLabel}
                    {d.reschedulesId ? " · ↻ rescheduled" : ""} · raw status “{d.rawStatus}”
                  </span>
                  <StatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="tl-h">
          <CardHeader id="tl-h" title="Service timeline" subtitle="Documented events with shift and operational date" />
          {profile.timeline.length === 0 ? (
            <EmptyState title="No documented service events" />
          ) : (
            <ol className="divide-y divide-line-soft text-[12px]">
              {profile.timeline.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="tabular w-36 shrink-0 font-semibold">{formatDateTime(new Date(t.occurredIso))}</span>
                  <span className="min-w-0 flex-1">
                    {SERVICE_LABELS[t.service]} · {t.by}
                    <span className="block text-[11px] text-ink-3">Operational date {formatShortDate(t.operationalDate)}</span>
                  </span>
                  <ShiftBadge shift={t.shift} />
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <Card className="mt-4" aria-labelledby="rev-h">
        <CardHeader id="rev-h" title="Correction history" subtitle="Every change to identity or location, with who, when and why" />
        {revisions.length === 0 ? (
          <EmptyState title="No corrections">This record has not been changed since registration.</EmptyState>
        ) : (
          <ol className="divide-y divide-line-soft text-[12px]" data-testid="revision-list">
            {revisions.map((r) => (
              <li key={r.id} className="py-2">
                <p>
                  <b>{formatDateTime(new Date(r.changedIso))}</b> · {r.by}
                  {r.reason ? <span className="text-ink-2"> · “{r.reason}”</span> : null}
                </p>
                <ul className="mt-0.5 text-ink-2">
                  {r.changes.map((ch) => (
                    <li key={ch.field}>
                      {FIELD[ch.field] ?? ch.field}: <span className="line-through">{ch.from ?? "—"}</span> → <b>{ch.to ?? "—"}</b>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <p className="mt-4 text-[12px]">
        <Link href="/patients" className="text-accent-ink hover:underline">
          ← Back to masterlist
        </Link>
      </p>
      <SyntheticDataNote />
    </>
  );
}

function Field({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-ink-3">{k}</dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}

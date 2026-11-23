"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  bookAction,
  correctAppointmentAction,
  createPftAction,
  rescheduleAction,
  statusAction,
  voidAppointmentAction,
  type ActResult,
} from "@/app/actions/diagnostics";
import { Buttons, FormError, inputCls, labelCls, ManilaDateTime, manilaNowLocal, PatientPicker, useClientId } from "@/components/clinical/fields";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/primitives";
import type { DiagnosticService, DiagnosticStatus, PatientCategory } from "@/lib/clinical/vocabulary";
import { addDays, formatDateTime, formatTime, HOSPITAL_TZ, parseIsoDate, toLocalParts, type IsoDate } from "@/lib/time/zoned";
import type { AppointmentRow } from "@/server/diagnostics";

const unreachable = { ok: false as const, error: "Could not reach the server. Nothing was saved.", detail: undefined as unknown };
const btn = "inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover";
const btnPrimary =
  "inline-flex min-h-9 items-center rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover";

const PROCEDURE_HINTS: Record<DiagnosticService, string[]> = {
  // Examples only (from the source workbook's labels); the final catalogue needs Pulmonary Unit approval.
  PFT: ["Simple PFT", "Complete PFT with post-bronchodilator", "PFT with DLCO"],
  ABG: ["ABG"],
  SPUTUM_INDUCTION: ["Sputum induction"],
};

// ---------------------------------------------------------------- booking

export function BookAppointmentButton({ service, patient }: { service: DiagnosticService; patient?: { id: string; title: string; subtitle: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={btnPrimary} onClick={() => setOpen(true)}>
        Book appointment
      </button>
      {open ? <BookDialog service={service} patient={patient} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function BookDialog({
  service,
  patient: initial,
  onClose,
}: {
  service: DiagnosticService;
  patient?: { id: string; title: string; subtitle: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const clientId = useClientId();
  const [patient, setPatient] = useState(initial ?? null);
  const [at, setAt] = useState(() => manilaNowLocal().slice(0, 11) + "08:00");
  const [procedure, setProcedure] = useState(PROCEDURE_HINTS[service][0]);
  const [category, setCategory] = useState<PatientCategory>("OPD");
  const [physician, setPhysician] = useState("");
  const [remarks, setRemarks] = useState("");
  const [payment, setPayment] = useState("");
  const [contact, setContact] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const listId = `proc-${service}`;
  return (
    <Modal title={`Book ${service === "SPUTUM_INDUCTION" ? "sputum induction" : service}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!patient) return setError("Choose a patient.");
          setPending(true);
          setError(null);
          const r = await bookAction({
            clientId,
            patientId: patient.id,
            service,
            scheduledAt: at,
            procedureLabel: procedure,
            category,
            requestingPhysician: physician,
            paymentClass: payment,
            contactNote: contact,
            remarks,
            recordedAtDevice: new Date().toISOString(),
          }).catch(() => unreachable);
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.push(`/diagnostics/appointments/${clientId}`);
        }}
        className="space-y-3"
      >
        <PatientPicker value={patient} onChange={setPatient} />
        <ManilaDateTime label="Date and time" value={at} onChange={setAt} required />
        <label className={labelCls}>
          Procedure / test (as requested)
          <input className={inputCls} list={listId} value={procedure} onChange={(e) => setProcedure(e.target.value)} required maxLength={160} />
          <datalist id={listId}>
            {PROCEDURE_HINTS[service].map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <fieldset>
          <legend className={labelCls}>OPD / INP</legend>
          <div className="mt-1 flex gap-2">
            {(["OPD", "INP", "OTHER"] as const).map((c) => (
              <label key={c} className="flex min-h-10 items-center gap-1.5 rounded-[7px] border border-line px-3 text-[13px]">
                <input type="radio" name="cat" checked={category === c} onChange={() => setCategory(c)} /> {c === "OTHER" ? "Other" : c}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={labelCls}>
          Requesting physician
          <input className={inputCls} value={physician} onChange={(e) => setPhysician(e.target.value)} maxLength={120} />
        </label>
        <label className={labelCls}>
          Payment <span className="font-normal text-ink-3">(optional, e.g. HMO / cash)</span>
          <input className={inputCls} value={payment} onChange={(e) => setPayment(e.target.value)} maxLength={60} />
        </label>
        <label className={labelCls}>
          Contact <span className="font-normal text-ink-3">(optional, as given — shown only on the appointment page)</span>
          <input className={inputCls} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={300} />
        </label>
        <label className={labelCls}>
          Remarks
          <textarea className={`${inputCls} min-h-16 py-2`} value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={1000} />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Book" onCancel={onClose} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- list + calendar

export function AppointmentList({ rows }: { rows: AppointmentRow[] }) {
  const columns: Column<AppointmentRow>[] = [
    {
      key: "when",
      header: "Scheduled",
      cell: (r) => (
        <Link href={`/diagnostics/appointments/${r.id}`} className="tabular whitespace-nowrap font-semibold hover:underline">
          {formatDateTime(new Date(r.scheduledIso))}
        </Link>
      ),
      sort: (r) => Date.parse(r.scheduledIso),
    },
    {
      key: "patient",
      header: "Patient",
      cell: (r) => (
        <Link href={`/diagnostics/appointments/${r.id}`} className="block hover:underline">
          <span className="block font-medium">{r.patient.name}</span>
          <span className="block text-[11px] text-ink-3">{r.patient.hospitalId ?? "No hospital no."}</span>
        </Link>
      ),
      sort: (r) => r.patient.name,
    },
    { key: "proc", header: "Procedure (as recorded)", cell: (r) => r.procedureLabel },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={r.status} />
          {r.rawStatus ? <span className="text-[10px] text-ink-3">source: “{r.rawStatus}”</span> : null}
          {r.reschedulesId ? <span className="text-[10px] text-ink-3">↻ follow-up of an earlier appointment</span> : null}
          {r.pftFormStatus ? (
            <span className="text-[10px] text-ink-3">
              PFT form: {r.pftFormStatus === "FINAL" ? "final" : r.pftFormStatus === "RT_SIGNED" ? "RT signed" : "draft"}
            </span>
          ) : null}
        </span>
      ),
      sort: (r) => r.status,
    },
    { key: "cat", header: "OPD/INP", cell: (r) => r.category, sort: (r) => r.category },
    { key: "md", header: "Requesting physician", cell: (r) => r.requestingPhysician ?? "—", hideOnCard: true },
    { key: "sch", header: "Scheduler", cell: (r) => r.scheduler ?? (r.source === "IMPORT" ? "Imported" : "—"), hideOnCard: true },
    { key: "by", header: "Performed by", cell: (r) => r.performedBy ?? "—" },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      caption="Diagnostic appointments"
      searchPlaceholder="Patient, hospital no., physician, procedure"
      searchText={(r) => `${r.patient.name} ${r.patient.hospitalId ?? ""} ${r.requestingPhysician ?? ""} ${r.procedureLabel}`}
      initialSort={{ key: "when", dir: "asc" }}
      emptyTitle="No appointments in this range"
      emptyText="Change the dates or filters above."
      pageSize={100}
    />
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayOfWeekMon0(d: IsoDate): number {
  const { year, month, day } = parseIsoDate(d);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}
function manilaDate(iso: string): IsoDate {
  const p = toLocalParts(new Date(iso), HOSPITAL_TZ);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Month-style calendar over the filtered range: per-day appointments (time · status glyph · patient). */
export function MonthCalendar({
  rows,
  from,
  to,
  basePath,
  query,
}: {
  rows: AppointmentRow[];
  from: IsoDate;
  to: IsoDate;
  basePath: string;
  query: Record<string, string>;
}) {
  const dayHref = (d: IsoDate) => `${basePath}?${new URLSearchParams({ ...query, view: "list", from: d, to: d }).toString()}`;
  const byDay = new Map<string, AppointmentRow[]>();
  for (const r of rows) {
    const d = manilaDate(r.scheduledIso);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const start = addDays(from, -dayOfWeekMon0(from));
  const end = addDays(to, 6 - dayOfWeekMon0(to));
  const days: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return (
    <div>
      <div className="hidden grid-cols-7 gap-px text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3 md:grid" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-1">
            {w}
          </div>
        ))}
      </div>
      <ol className="grid grid-cols-1 gap-2 md:grid-cols-7 md:gap-px md:overflow-hidden md:rounded-[10px] md:border md:border-line md:bg-line">
        {days.map((d) => {
          const list = (byDay.get(d) ?? []).sort((a, b) => a.scheduledIso.localeCompare(b.scheduledIso));
          const inRange = d >= from && d <= to;
          const { day, month } = parseIsoDate(d);
          if (!inRange && !list.length) return <li key={d} className="hidden min-h-24 bg-canvas md:block" aria-hidden="true" />;
          return (
            <li
              key={d}
              className={`min-h-24 rounded-[10px] border border-line bg-surface p-2 md:rounded-none md:border-0 ${list.length ? "" : "max-md:hidden"}`}
            >
              <Link href={dayHref(d)} className="text-[12px] font-semibold hover:underline" aria-label={`${d}: ${list.length} appointment(s)`}>
                <span className="md:hidden">{WEEKDAYS[dayOfWeekMon0(d)]} </span>
                {day === 1 || d === start ? `${month}/${day}` : day}
                {list.length ? <span className="ml-1 font-normal text-ink-3">· {list.length}</span> : null}
              </Link>
              <ul className="mt-1 space-y-0.5">
                {list.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <Link href={`/diagnostics/appointments/${r.id}`} className="block truncate rounded px-1 text-[11px] hover:bg-hover">
                      <span className="tabular">{formatTime(new Date(r.scheduledIso))}</span> <StatusGlyph status={r.status} /> {r.patient.name}
                    </Link>
                  </li>
                ))}
                {list.length > 6 ? (
                  <li>
                    <Link href={dayHref(d)} className="px-1 text-[11px] text-accent-ink hover:underline">
                      +{list.length - 6} more
                    </Link>
                  </li>
                ) : null}
              </ul>
            </li>
          );
        })}
      </ol>
      {!rows.length ? <p className="mt-3 text-[13px] text-ink-2">No appointments in this range.</p> : null}
    </div>
  );
}

const GLYPH: Record<string, string> = { SCHEDULED: "○", PENDING: "◔", COMPLETED: "✓", NO_SHOW: "✕", CANCELLED: "–", FOR_RESCHEDULE: "↻", RESCHEDULED: "↻" };
function StatusGlyph({ status }: { status: string }) {
  return (
    <span title={status} aria-label={status.toLowerCase().replace("_", " ")}>
      {GLYPH[status] ?? "·"}
    </span>
  );
}

// ---------------------------------------------------------------- appointment actions (detail page)

type Dialog = null | { kind: "status"; status: DiagnosticStatus } | { kind: "reschedule" } | { kind: "void" } | { kind: "edit" };

export interface EditableDetails {
  scheduledIso: string;
  procedureLabel: string;
  requestingPhysician: string | null;
  category: PatientCategory;
  remarks: string | null;
  updatedIso: string | null;
}

export function AppointmentActions({
  id,
  status,
  service,
  canSchedule,
  canVoid,
  canStartPft,
  pftFormId,
  edit,
}: {
  id: string;
  status: DiagnosticStatus;
  service: DiagnosticService;
  canSchedule: boolean;
  canVoid: boolean;
  canStartPft: boolean;
  pftFormId: string | null;
  /** Present when the appointment's details may be corrected (open appointment). */
  edit?: EditableDetails | null;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pftError, setPftError] = useState<string | null>(null);
  const pftClientId = useClientId();
  const open = ["SCHEDULED", "PENDING", "FOR_RESCHEDULE"].includes(status);
  const next: DiagnosticStatus[] =
    status === "FOR_RESCHEDULE"
      ? ["CANCELLED"]
      : status === "SCHEDULED"
        ? ["COMPLETED", "PENDING", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE"]
        : status === "PENDING"
          ? ["COMPLETED", "SCHEDULED", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE"]
          : [];
  const LABEL: Record<string, string> = {
    COMPLETED: "Mark done",
    PENDING: "Mark pending",
    SCHEDULED: "Back to scheduled",
    NO_SHOW: "No-show",
    CANCELLED: "Cancel",
    FOR_RESCHEDULE: "For reschedule",
  };
  return (
    <div className="flex flex-wrap gap-2">
      {service === "PFT" && pftFormId ? (
        <Link href={`/diagnostics/pft/forms/${pftFormId}`} className={btnPrimary}>
          Open PFT form
        </Link>
      ) : null}
      {service === "PFT" && !pftFormId && canStartPft ? (
        <button
          type="button"
          className={btnPrimary}
          onClick={async () => {
            setPftError(null);
            const r = await createPftAction(pftClientId, id).catch(() => unreachable);
            if (r.ok) router.push(`/diagnostics/pft/forms/${pftClientId}`);
            else if ((r.detail as { id?: string } | undefined)?.id) router.push(`/diagnostics/pft/forms/${(r.detail as { id: string }).id}`);
            else setPftError(r.error);
          }}
        >
          Start PFT form
        </button>
      ) : null}
      {canSchedule && open
        ? next.map((s) => (
            <button key={s} type="button" className={btn} onClick={() => setDialog({ kind: "status", status: s })}>
              {LABEL[s]}
            </button>
          ))
        : null}
      {edit ? (
        <button type="button" className={btn} onClick={() => setDialog({ kind: "edit" })}>
          Edit details
        </button>
      ) : null}
      {canSchedule && open ? (
        <button type="button" className={btn} onClick={() => setDialog({ kind: "reschedule" })}>
          Reschedule
        </button>
      ) : null}
      {canVoid ? (
        <button type="button" className={`${btn} text-danger`} onClick={() => setDialog({ kind: "void" })}>
          Void (entered in error)
        </button>
      ) : null}
      <FormError error={pftError} />
      {dialog?.kind === "status" ? <StatusDialog id={id} status={dialog.status} label={LABEL[dialog.status]} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "reschedule" ? <RescheduleDialog id={id} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "void" ? <VoidDialog id={id} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "edit" && edit ? <EditDialog id={id} edit={edit} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function ReasonForm({
  title,
  onClose,
  submit,
  required,
  run,
  intro,
}: {
  title: string;
  onClose: () => void;
  submit: string;
  required: boolean;
  run: (reason: string) => Promise<ActResult<unknown>>;
  intro?: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      {intro ? <p className="text-[12px] text-ink-2">{intro}</p> : null}
      <form
        className="mt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await run(reason).catch(() => unreachable);
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <label className={labelCls}>
          Reason {required ? "" : <span className="font-normal text-ink-3">(optional)</span>}
          <textarea
            className={`${inputCls} min-h-16 py-2`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required={required}
            minLength={required ? 5 : undefined}
            maxLength={300}
          />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit={submit} onCancel={onClose} />
      </form>
    </Modal>
  );
}

function StatusDialog({ id, status, label, onClose }: { id: string; status: DiagnosticStatus; label: string; onClose: () => void }) {
  const required = ["CANCELLED", "NO_SHOW", "FOR_RESCHEDULE"].includes(status);
  return (
    <ReasonForm
      title={label}
      onClose={onClose}
      submit={label}
      required={required}
      intro={
        status === "COMPLETED"
          ? "Recorded in your name as the RT who performed it. Done, no-show and cancelled cannot be changed afterwards (void instead)."
          : "This change is kept in the appointment's history."
      }
      run={(reason) => statusAction(id, status, reason)}
    />
  );
}

function VoidDialog({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <ReasonForm
      title="Void appointment"
      onClose={onClose}
      submit="Void"
      required
      intro="Use only for an appointment entered in error. It disappears from schedules but stays in the audit trail."
      run={(reason) => voidAppointmentAction(id, reason)}
    />
  );
}

function RescheduleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter();
  const clientId = useClientId();
  const [at, setAt] = useState(() => manilaNowLocal().slice(0, 11) + "08:00");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title="Reschedule" onClose={onClose}>
      <p className="text-[12px] text-ink-2">The current appointment is kept as “Rescheduled” and a new, linked appointment is booked.</p>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await rescheduleAction(id, clientId, at, reason).catch(() => unreachable);
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.push(`/diagnostics/appointments/${clientId}`);
        }}
      >
        <ManilaDateTime label="New date and time" value={at} onChange={setAt} required />
        <label className={labelCls}>
          Reason
          <textarea className={`${inputCls} min-h-16 py-2`} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Reschedule" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function EditDialog({ id, edit, onClose }: { id: string; edit: EditableDetails; onClose: () => void }) {
  const router = useRouter();
  const [at, setAt] = useState(() => manilaLocal(edit.scheduledIso));
  const [procedure, setProcedure] = useState(edit.procedureLabel);
  const [physician, setPhysician] = useState(edit.requestingPhysician ?? "");
  const [category, setCategory] = useState<PatientCategory>(edit.category);
  const [remarks, setRemarks] = useState(edit.remarks ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title="Edit appointment details" onClose={onClose}>
      <p className="text-[12px] text-ink-2">
        Corrects this booking. The previous values stay in the history with your reason. To change the patient or the test service, void this entry and book
        again.
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await correctAppointmentAction(id, {
            expectedUpdatedIso: edit.updatedIso,
            scheduledAt: at,
            procedureLabel: procedure,
            requestingPhysician: physician,
            category,
            remarks,
            reason,
          }).catch(() => unreachable);
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <ManilaDateTime label="Date and time" value={at} onChange={setAt} required />
        <label className={labelCls}>
          Procedure / test
          <input className={inputCls} value={procedure} onChange={(e) => setProcedure(e.target.value)} required maxLength={160} />
        </label>
        <fieldset>
          <legend className={labelCls}>OPD / INP</legend>
          <div className="mt-1 flex gap-2">
            {(["OPD", "INP", "OTHER"] as const).map((c) => (
              <label key={c} className="flex min-h-10 items-center gap-1.5 rounded-[7px] border border-line px-3 text-[13px]">
                <input type="radio" name="edit-cat" checked={category === c} onChange={() => setCategory(c)} /> {c === "OTHER" ? "Other" : c}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={labelCls}>
          Requesting physician
          <input className={inputCls} value={physician} onChange={(e) => setPhysician(e.target.value)} maxLength={120} />
        </label>
        <label className={labelCls}>
          Remarks
          <textarea className={`${inputCls} min-h-16 py-2`} value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={1000} />
        </label>
        <label className={labelCls}>
          Reason for the correction
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Save correction" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function manilaLocal(iso: string): string {
  const p = toLocalParts(new Date(iso), HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { discontinueNebOrderAction, documentNebulizationAction, enterNebOrderAction, voidNebulizationAction } from "@/app/actions/documentation";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Modal } from "@/components/ui/Modal";
import { Badge, StatusBadge } from "@/components/ui/primitives";
import { FlagBoxes, FlagChips, type FlagsView } from "@/components/workspace/Flags";
import { dosesFromFirst, FREQUENCY_HOURS, isSingleDose, ORDER_FREQUENCIES } from "@/lib/clinical/nebSlots";
import { formatClock, formatDayTime, formatTime } from "@/lib/time/zoned";
import type { NebRow } from "@/server/nebulization";
import { Buttons, FormError, inputCls, labelCls, ManilaDateTime, manilaLocalOf, manilaNowLocal, PatientPicker, useClientId } from "./fields";

const OUTCOMES = [
  ["COMPLETED", "Given"],
  ["NOT_GIVEN", "Not given"],
  ["REFUSED", "Refused"],
  ["DELAYED", "Delayed"],
  ["CANCELLED", "Cancelled"],
] as const;

export interface DoseTarget {
  flags?: FlagsView;
  orderId: string;
  orderReference: string;
  medication: string;
  patient: string;
  scheduledIso: string | null;
}

export function DocumentDoseDialog({ target, onClose, notice }: { target: DoseTarget; onClose: () => void; notice?: React.ReactNode }) {
  const router = useRouter();
  const clientId = useClientId();
  const [status, setStatus] = useState<string>("COMPLETED");
  const [at, setAt] = useState(() => {
    const now = manilaNowLocal();
    return target.scheduledIso && manilaLocalOf(target.scheduledIso) < now ? manilaLocalOf(target.scheduledIso) : now;
  });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const given = status === "COMPLETED";
  return (
    <Modal
      title={target.scheduledIso ? `Document dose due ${formatDayTime(new Date(target.scheduledIso))}` : "Document unscheduled / PRN dose"}
      onClose={onClose}
    >
      <p className="mb-3 text-[12px] text-ink-2">
        <b>{target.patient}</b> · {target.orderReference} · {target.medication}
      </p>
      {notice ? (
        <div className="mb-3">{notice}</div>
      ) : target.flags ? (
        <div className="mb-3">
          <FlagBoxes flags={target.flags} />
        </div>
      ) : null}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await documentNebulizationAction({
            clientId,
            orderId: target.orderId,
            scheduledAt: target.scheduledIso,
            status,
            actualAt: given ? at : "",
            reason,
            recordedAtDevice: new Date().toISOString(),
          }).catch(() => ({ ok: false as const, error: "Could not reach the server. Nothing was saved — try again." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <fieldset>
          <legend className={labelCls}>What happened?</legend>
          <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {OUTCOMES.filter(([v]) => target.scheduledIso || v === "COMPLETED").map(([v, l]) => (
              <label
                key={v}
                className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-[7px] border px-3 text-[13px] ${status === v ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
              >
                <input type="radio" name="outcome" value={v} checked={status === v} onChange={() => setStatus(v)} />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 space-y-3">
          {given && <ManilaDateTime label="Time given" value={at} onChange={setAt} required />}
          {!given && (
            <label className={labelCls}>
              Reason <span className="text-danger">*</span>
              <textarea className={`${inputCls} py-2`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
            </label>
          )}
        </div>
        <p className="mt-2 text-[11px] text-ink-3">Recorded in your name. To correct it later, void it with a reason and document again.</p>
        <FormError error={error} />
        <Buttons pending={pending} submit="Save" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function ReasonDialog({
  title,
  explain,
  submit,
  onSubmit,
  onClose,
}: {
  title: string;
  explain: string;
  submit: string;
  onSubmit: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-[12px] text-ink-2">{explain}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const r = await onSubmit(reason).catch(() => ({ ok: false, error: "Could not reach the server." }));
          setPending(false);
          if (!r.ok) return setError(r.error ?? "Not saved.");
          onClose();
          router.refresh();
        }}
      >
        <label className={`${labelCls} mt-3`}>
          Reason <span className="text-danger">*</span>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required minLength={5} />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit={submit} onCancel={onClose} />
      </form>
    </Modal>
  );
}

/** Keeps the full tables out of the way until needed (the order cards are the main view). */
export function ShowMore({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="min-h-10 w-full rounded-[10px] border border-line bg-surface px-4 text-left text-[14px] font-semibold hover:bg-hover"
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/** One card per order with today's dose times as chips (tap an open time to document it). */
export function NebOrderCards({
  rows,
  canDocument,
  canOrder = false,
  prn = [],
}: {
  rows: NebRow[];
  canDocument: boolean;
  canOrder?: boolean;
  prn?: ActiveOrder[];
}) {
  const [dose, setDose] = useState<DoseTarget | null>(null);
  const [stopping, setStopping] = useState<{ id: string; label: string } | null>(null);
  const byOrder = new Map<string, NebRow[]>();
  for (const r of rows) {
    if (!r.scheduledIso) continue;
    const list = byOrder.get(r.orderId) ?? [];
    list.push(r);
    byOrder.set(r.orderId, list);
  }
  const cards = [...byOrder.values()].map((list) => list.sort((a, b) => Date.parse(a.scheduledIso!) - Date.parse(b.scheduledIso!)));
  if (!cards.length && !prn.length)
    return <p className="mb-6 rounded-[12px] border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-3">No scheduled doses today.</p>;
  const tone = (r: NebRow) =>
    r.status === "COMPLETED"
      ? "bg-success-soft text-success"
      : r.documented
        ? "bg-warning-soft text-warning"
        : r.status === "PENDING"
          ? "bg-danger-soft text-danger"
          : "bg-neutral-soft text-ink-2";
  return (
    <>
      {dose && <DocumentDoseDialog target={dose} onClose={() => setDose(null)} />}
      {stopping && (
        <ReasonDialog
          title={`Discontinue ${stopping.label}`}
          explain="The order stops now and its remaining doses disappear from Nebs and Today. Orders are never edited — enter a new order if the physician changes it."
          submit="Discontinue order"
          onSubmit={(reason) => discontinueNebOrderAction(stopping.id, reason)}
          onClose={() => setStopping(null)}
        />
      )}
      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="neb-order-cards">
        {cards.map((list) => {
          const o = list[0];
          return (
            <div key={o.orderId} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/patients/${o.patient.id}`} className="min-w-0 truncate text-[15px] font-semibold hover:underline">
                  {o.patient.name}
                </Link>
                <span className="shrink-0 text-[13px] text-ink-2">{o.patient.wardRoom ?? "—"}</span>
              </div>
              <span className="text-[14px]">
                {o.medication} · <strong>{o.frequency}</strong>
              </span>
              <FlagChips flags={o.patient} />
              <div className="flex flex-wrap gap-1.5">
                {list.map((r) => {
                  const label = `${formatTime(new Date(r.scheduledIso!))}${r.status === "COMPLETED" ? " ✓" : r.documented ? " ✕" : ""}`;
                  const open = !r.documented && canDocument;
                  return open ? (
                    <button
                      key={r.key}
                      type="button"
                      className={`tabular min-h-9 rounded-[8px] px-2.5 text-[13px] font-semibold ${tone(r)}`}
                      aria-label={`Document ${o.medication} due ${label} for ${o.patient.name}`}
                      onClick={() =>
                        setDose({
                          orderId: r.orderId,
                          orderReference: r.orderReference,
                          medication: r.medication,
                          patient: r.patient.name,
                          scheduledIso: r.scheduledIso,
                          flags: r.patient,
                        })
                      }
                    >
                      {label}
                    </button>
                  ) : (
                    <span key={r.key} className={`tabular inline-flex min-h-9 items-center rounded-[8px] px-2.5 text-[13px] font-semibold ${tone(r)}`}>
                      {label}
                    </span>
                  );
                })}
              </div>
              {canOrder ? (
                <button
                  type="button"
                  onClick={() => setStopping({ id: o.orderId, label: `${o.medication} · ${o.patient.name}` })}
                  className="min-h-9 self-start rounded-[8px] border border-[#f0d0cc] px-3 text-[12px] font-semibold text-danger hover:bg-danger-soft"
                >
                  Discontinue
                </button>
              ) : null}
            </div>
          );
        })}
        {prn.map((o) => (
          <div key={o.id} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
            <Link href={`/patients/${o.patient.id}`} className="min-w-0 truncate text-[15px] font-semibold hover:underline">
              {o.patient.name}
            </Link>
            <span className="text-[14px]">
              {o.medication} · <strong>PRN</strong>
            </span>
            {canDocument ? (
              <button
                type="button"
                onClick={() =>
                  setDose({ orderId: o.id, orderReference: o.orderReference, medication: o.medication, patient: o.patient.name, scheduledIso: null })
                }
                className="min-h-9 self-start rounded-[8px] border border-line px-3 text-[13px] font-semibold hover:bg-hover"
              >
                Document PRN dose
              </button>
            ) : (
              <span className="text-[12px] text-ink-3">As needed — no fixed times</span>
            )}
            {canOrder ? (
              <button
                type="button"
                onClick={() => setStopping({ id: o.id, label: `${o.medication} · ${o.patient.name}` })}
                className="min-h-9 self-start rounded-[8px] border border-[#f0d0cc] px-3 text-[12px] font-semibold text-danger hover:bg-danger-soft"
              >
                Discontinue
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

export function NebWorklist({ rows, me, isChief, canDocument }: { rows: NebRow[]; me: string; isChief: boolean; canDocument: boolean }) {
  const [dose, setDose] = useState<DoseTarget | null>(null);
  const [voiding, setVoiding] = useState<NebRow | null>(null);
  const columns: Column<NebRow>[] = [
    {
      key: "sched",
      header: "Due",
      cell: (r) => (r.scheduledIso ? <span className="tabular font-semibold">{formatDayTime(new Date(r.scheduledIso))}</span> : <Badge>Unscheduled</Badge>),
      sort: (r) => Date.parse(r.scheduledIso ?? r.actualIso ?? ""),
    },
    {
      key: "patient",
      header: "Patient",
      cell: (r) => (
        <Link href={`/patients/${r.patient.id}`} className="block hover:underline">
          <span className="block font-medium">{r.patient.name}</span>
          <span className="block text-[11px] text-ink-3">
            {r.patient.hospitalId}
            {r.patient.wardRoom ? ` · ${r.patient.wardRoom}` : ""}
          </span>
          <span className="mt-1 block">
            <FlagChips flags={r.patient} />
          </span>
        </Link>
      ),
      sort: (r) => r.patient.name,
    },
    {
      key: "order",
      header: "Order",
      cell: (r) => (
        <span>
          <span className="block">{r.medication}</span>
          <span className="block text-[11px] text-ink-3">
            Ordered {r.orderReference} · {r.frequency} · {r.prescriber}
          </span>
        </span>
      ),
    },
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} />, sort: (r) => r.status },
    {
      key: "actual",
      header: "Given / by",
      cell: (r) =>
        r.documented ? (
          <span className="text-[12px]">
            {r.actualIso ? <span className="tabular block">{formatTime(new Date(r.actualIso))}</span> : null}
            <span className="block text-ink-3">{r.performedBy}</span>
            {r.reason ? <span className="block text-ink-2">“{r.reason}”</span> : null}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      key: "act",
      header: "Action",
      cell: (r) =>
        !r.documented ? (
          canDocument ? (
            <button
              type="button"
              onClick={() =>
                setDose({
                  orderId: r.orderId,
                  orderReference: r.orderReference,
                  medication: r.medication,
                  patient: r.patient.name,
                  scheduledIso: r.scheduledIso,
                  flags: r.patient,
                })
              }
              className="min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[12px] font-semibold text-white hover:bg-accent-hover"
            >
              Document
            </button>
          ) : null
        ) : r.performedById === me || isChief ? (
          <button type="button" onClick={() => setVoiding(r)} className="min-h-9 rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover">
            Void
          </button>
        ) : null,
    },
  ];
  return (
    <>
      {dose && <DocumentDoseDialog target={dose} onClose={() => setDose(null)} />}
      {voiding && (
        <ReasonDialog
          title="Void this entry"
          explain="The entry stays in the record marked as voided, with your reason. The dose becomes open again so the correct outcome can be documented."
          submit="Void entry"
          onSubmit={(reason) => voidNebulizationAction(voiding.id!, reason)}
          onClose={() => setVoiding(null)}
        />
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.key}
        caption="Nebulization worklist"
        searchPlaceholder="Patient, hospital no., medication"
        searchText={(r) => `${r.patient.name} ${r.patient.hospitalId} ${r.orderReference} ${r.medication}`}
        filters={[
          {
            key: "st",
            label: "Status",
            options: ["SCHEDULED", "PENDING", "COMPLETED", "DELAYED", "NOT_GIVEN", "REFUSED", "CANCELLED"].map((v) => ({
              value: v,
              label: v.replace("_", " ").toLowerCase(),
            })),
            match: (r, v) => r.status === v,
          },
        ]}
        initialSort={{ key: "sched", dir: "asc" }}
        emptyTitle="No doses for this operational day"
      />
    </>
  );
}

export interface ActiveOrder {
  id: string;
  patient: { id: string; name: string; hospitalId: string };
  orderReference: string;
  medication: string;
  frequency: string;
  prescribedTimes: string[];
  prescriber: string;
  startIso: string;
  endIso: string | null;
  enteredBy: string;
}

export function ActiveOrders({ orders, canDocument, canOrder }: { orders: ActiveOrder[]; canDocument: boolean; canOrder: boolean }) {
  const [dose, setDose] = useState<DoseTarget | null>(null);
  const [stopping, setStopping] = useState<ActiveOrder | null>(null);
  const columns: Column<ActiveOrder>[] = [
    { key: "ref", header: "Ordered", cell: (r) => <span className="tabular font-medium">{r.orderReference}</span>, sort: (r) => r.orderReference },
    {
      key: "patient",
      header: "Patient",
      cell: (r) => (
        <Link href={`/patients/${r.patient.id}`} className="hover:underline">
          <span className="block font-medium">{r.patient.name}</span>
          <span className="block text-[11px] text-ink-3">{r.patient.hospitalId}</span>
        </Link>
      ),
      sort: (r) => r.patient.name,
    },
    { key: "med", header: "Medication as ordered", cell: (r) => r.medication },
    { key: "freq", header: "Frequency", cell: (r) => <Badge>{r.frequency}</Badge> },
    {
      key: "times",
      header: "Times on order",
      cell: (r) =>
        r.prescribedTimes.length ? (
          <span className="tabular">{r.prescribedTimes.map(formatClock).join(", ")}</span>
        ) : (
          <span className="text-ink-3">None written — document doses as given</span>
        ),
    },
    {
      key: "by",
      header: "Attending physician / entered by",
      cell: (r) => (
        <span className="text-[12px]">
          {r.prescriber} · {r.enteredBy}
        </span>
      ),
      hideOnCard: true,
    },
    {
      key: "act",
      header: "Action",
      cell: (r) => (
        <span className="flex flex-wrap gap-1.5">
          {canDocument && (
            <button
              type="button"
              onClick={() =>
                setDose({ orderId: r.id, orderReference: r.orderReference, medication: r.medication, patient: r.patient.name, scheduledIso: null })
              }
              className="min-h-9 rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover"
            >
              {r.frequency === "PRN" ? "Document PRN dose" : "Unscheduled dose"}
            </button>
          )}
          {canOrder && (
            <button
              type="button"
              onClick={() => setStopping(r)}
              className="min-h-9 rounded-[7px] border border-[#f0d0cc] px-2.5 text-[12px] text-danger hover:bg-danger-soft"
            >
              Discontinue
            </button>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      {dose && <DocumentDoseDialog target={dose} onClose={() => setDose(null)} />}
      {stopping && (
        <ReasonDialog
          title={`Discontinue order of ${stopping.orderReference}`}
          explain="Orders are never edited. Discontinue this order (e.g. stopped by the physician, or transcribed wrongly) and enter a new one if needed. Remaining expected doses disappear from the worklist."
          submit="Discontinue order"
          onSubmit={(reason) => discontinueNebOrderAction(stopping.id, reason)}
          onClose={() => setStopping(null)}
        />
      )}
      <DataTable
        rows={orders}
        columns={columns}
        rowKey={(r) => r.id}
        caption="Active nebulization orders"
        searchPlaceholder="Patient, medication or order date"
        searchText={(r) => `${r.patient.name} ${r.patient.hospitalId} ${r.orderReference} ${r.medication}`}
        initialSort={{ key: "ref", dir: "asc" }}
      />
    </>
  );
}

export function NewOrderForm({ initialPatient = null }: { initialPatient?: { id: string; title: string; subtitle: string } | null }) {
  const router = useRouter();
  const clientId = useClientId();
  const [patient, setPatient] = useState<{ id: string; title: string; subtitle: string } | null>(initialPatient);
  const [f, setF] = useState({
    orderReference: "",
    prescriber: "",
    medicationAsOrdered: "",
    frequency: "Q6H",
    prescribedTimes: "",
    firstDose: "20:00",
    startAt: "",
    endAt: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const hours = FREQUENCY_HOURS[f.frequency];
  const preview = f.frequency === "PRN" ? null : (dosesFromFirst(f.frequency, f.firstDose) ?? []);
  // Show the expected doses in the order they come, starting from the first dose.
  const ordered = preview ? [...preview.filter((t) => t >= f.firstDose), ...preview.filter((t) => t < f.firstDose)] : null;
  return (
    <form
      className="max-w-2xl space-y-4 rounded-[10px] border border-line bg-surface p-5"
      aria-label="New nebulization order"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!patient) return setError("Select a patient.");
        setPending(true);
        setError(null);
        const r = await enterNebOrderAction({ clientId, patientId: patient.id, ...f }).catch(() => ({
          ok: false as const,
          error: "Could not reach the server. Nothing was saved.",
        }));
        setPending(false);
        if (!r.ok) return setError(r.error);
        router.push("/nebulization");
        router.refresh();
      }}
    >
      <PatientPicker value={patient} onChange={setPatient} />
      <div className="grid gap-4 sm:grid-cols-2">
        <ManilaDateTime
          label="Order date/time (as written in the chart)"
          value={f.orderReference}
          onChange={(v) => setF((x) => ({ ...x, orderReference: v }))}
          required
        />
        <label className={labelCls}>
          Attending physician <span className="text-danger">*</span>
          <input className={inputCls} value={f.prescriber} onChange={set("prescriber")} maxLength={120} required />
        </label>
        <label className={`${labelCls} sm:col-span-2`}>
          Medication exactly as ordered <span className="text-danger">*</span>
          <textarea className={`${inputCls} py-2`} rows={2} value={f.medicationAsOrdered} onChange={set("medicationAsOrdered")} maxLength={300} required />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className={labelCls}>
            Frequency <span className="text-danger">*</span>
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label="Frequency">
            {ORDER_FREQUENCIES.map((x) => (
              <button
                key={x}
                type="button"
                role="radio"
                aria-checked={f.frequency === x}
                onClick={() => setF((v) => ({ ...v, frequency: x, firstDose: x === "STAT" ? manilaNowLocal().slice(11, 16) : v.firstDose }))}
                className={`min-h-10 rounded-full border px-4 text-[14px] font-semibold ${
                  f.frequency === x ? "border-accent bg-accent text-white" : "border-line bg-surface hover:bg-hover"
                }`}
              >
                {x}
              </button>
            ))}
          </div>
        </fieldset>
        {f.frequency !== "PRN" ? (
          <label className={labelCls}>
            {isSingleDose(f.frequency) ? "Dose time" : "First dose time"} <span className="text-danger">*</span>
            <input type="time" className={inputCls} value={f.firstDose} onChange={set("firstDose")} required aria-describedby="neb-dose-preview" />
          </label>
        ) : null}
        <div id="neb-dose-preview" className="flex flex-col gap-2 rounded-[12px] bg-info-soft px-3.5 py-3 text-info sm:col-span-2" aria-live="polite">
          <strong className="text-[13px]">{isSingleDose(f.frequency) ? "This order expects one dose" : "Doses this order will expect (every 24 h)"}</strong>
          <div className="flex flex-wrap gap-1.5" data-testid="neb-dose-preview">
            {ordered === null ? (
              <span className="rounded-[8px] bg-surface px-2.5 py-1.5 text-[13px] font-semibold">As needed, no fixed times</span>
            ) : (
              ordered.map((t) => (
                <span key={t} className="tabular rounded-[8px] bg-surface px-2.5 py-1.5 text-[13px] font-semibold">
                  {formatClock(t)}
                </span>
              ))
            )}
          </div>
          <span className="text-[12px]">
            {f.frequency === "PRN"
              ? "PRN doses are documented only when given."
              : isSingleDose(f.frequency)
                ? `${f.frequency}: a single dose; the order ends after it. It becomes a task on Today; it is never marked done by itself.`
                : `${f.frequency} = ${f.frequency === "QID" ? "4 times a day, " : ""}every ${hours} hours, counted from the first dose. The order starts at the first dose. Each time becomes a task on Today when it is due; a dose is never marked done by itself.`}
          </span>
        </div>
        {!isSingleDose(f.frequency) ? (
          <ManilaDateTime label="Order end (optional)" value={f.endAt} onChange={(v) => setF((x) => ({ ...x, endAt: v }))} />
        ) : null}
      </div>
      <FormError error={error} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-10 rounded-[7px] border border-accent bg-accent px-4 text-[14px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save order"}
        </button>
        <Link href="/nebulization" className="inline-flex min-h-10 items-center rounded-[7px] border border-line px-4 text-[14px] hover:bg-hover">
          Cancel
        </Link>
      </div>
    </form>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { disconnectAction, documentTubingAction, hookInAction, voidTubingAction } from "@/app/actions/documentation";
import type { TubingRowView, VentRow } from "@/components/tables/ModuleTables";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/primitives";
import { describeDuration } from "@/lib/clinical/tubing";
import { formatDateTime } from "@/lib/time/zoned";
import { Buttons, FormError, inputCls, labelCls, ManilaDateTime, manilaNowLocal, PatientPicker, useClientId } from "./fields";

function PatientCell({ p }: { p: VentRow["patient"] }) {
  return (
    <Link href={`/patients/${p.id}`} className="block hover:underline">
      <span className="block font-medium">{p.name}</span>
      <span className="block text-[11px] text-ink-3">{p.hospitalId}</span>
    </Link>
  );
}

function DisconnectDialog({ row, onClose }: { row: VentRow; onClose: () => void }) {
  const router = useRouter();
  const [at, setAt] = useState(manilaNowLocal);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title={`Disconnect ${row.ventilatorRef}`} onClose={onClose}>
      <p className="text-[12px] text-ink-2">
        {row.patient.name} · hooked in {formatDateTime(new Date(row.hookedIso))}. The encounter is kept in the patient&apos;s history.
      </p>
      <form
        className="mt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const r = await disconnectAction(row.id, at).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <ManilaDateTime label="Disconnection time" value={at} onChange={setAt} required />
        <FormError error={error} />
        <Buttons pending={pending} submit="Record disconnection" onCancel={onClose} />
      </form>
    </Modal>
  );
}

export function VentilationList({ rows, canDocument }: { rows: VentRow[]; canDocument: boolean }) {
  const [closing, setClosing] = useState<VentRow | null>(null);
  const columns: Column<VentRow>[] = [
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} />, sort: (r) => r.status },
    { key: "patient", header: "Patient", cell: (r) => <PatientCell p={r.patient} />, sort: (r) => r.patient.name },
    { key: "vent", header: "Ventilator", cell: (r) => <span className="tabular">{r.ventilatorRef}</span>, sort: (r) => r.ventilatorRef },
    { key: "ward", header: "Ward / room", cell: (r) => r.wardRoom },
    {
      key: "hook",
      header: "Hook-in",
      cell: (r) => <span className="tabular whitespace-nowrap">{formatDateTime(new Date(r.hookedIso))}</span>,
      sort: (r) => Date.parse(r.hookedIso),
    },
    {
      key: "disc",
      header: "Disconnection",
      cell: (r) =>
        r.disconnectedIso ? (
          <span className="tabular whitespace-nowrap">{formatDateTime(new Date(r.disconnectedIso))}</span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { key: "tub", header: "Tubing", cell: (r) => (r.tubingStatus ? <StatusBadge status={r.tubingStatus} /> : <span className="text-ink-3">—</span>) },
    { key: "rt", header: "Responsible RT", cell: (r) => r.responsible, hideOnCard: true },
    {
      key: "act",
      header: "Action",
      cell: (r) =>
        r.status === "ACTIVE" && canDocument ? (
          <button type="button" onClick={() => setClosing(r)} className="min-h-9 rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover">
            Disconnect
          </button>
        ) : null,
    },
  ];
  return (
    <>
      {closing && <DisconnectDialog row={closing} onClose={() => setClosing(null)} />}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        caption="Ventilator encounters"
        searchPlaceholder="Patient, hospital no., ventilator"
        searchText={(r) => `${r.patient.name} ${r.patient.hospitalId} ${r.ventilatorRef} ${r.wardRoom}`}
        filters={[
          {
            key: "st",
            label: "Status",
            options: [
              { value: "ACTIVE", label: "Active" },
              { value: "DISCONTINUED", label: "Discontinued" },
            ],
            match: (r, v) => r.status === v,
          },
        ]}
      />
    </>
  );
}

export function HookInForm({ intervalDays }: { intervalDays: number }) {
  const router = useRouter();
  const clientId = useClientId();
  const [patient, setPatient] = useState<{ id: string; title: string; subtitle: string } | null>(null);
  const [f, setF] = useState({ ventilatorRef: "", wardRoom: "", hookedAt: manilaNowLocal(), newCircuitInstalled: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="max-w-2xl space-y-4 rounded-[10px] border border-line bg-surface p-5"
      aria-label="Ventilator hook-in"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!patient) return setError("Select a patient.");
        setPending(true);
        setError(null);
        const r = await hookInAction({ clientId, patientId: patient.id, ...f, recordedAtDevice: new Date().toISOString() }).catch(() => ({
          ok: false as const,
          error: "Could not reach the server. Nothing was saved.",
        }));
        setPending(false);
        if (!r.ok) return setError(r.error);
        router.push("/ventilation");
        router.refresh();
      }}
    >
      <PatientPicker value={patient} onChange={setPatient} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelCls}>
          Ventilator identifier <span className="text-danger">*</span>
          <input
            className={inputCls}
            value={f.ventilatorRef}
            onChange={(e) => setF((x) => ({ ...x, ventilatorRef: e.target.value }))}
            maxLength={60}
            required
          />
        </label>
        <label className={labelCls}>
          Ward / room <span className="text-danger">*</span>
          <input className={inputCls} value={f.wardRoom} onChange={(e) => setF((x) => ({ ...x, wardRoom: e.target.value }))} maxLength={60} required />
        </label>
        <ManilaDateTime label="Hook-in time" value={f.hookedAt} onChange={(v) => setF((x) => ({ ...x, hookedAt: v }))} required />
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={f.newCircuitInstalled}
          onChange={(e) => setF((x) => ({ ...x, newCircuitInstalled: e.target.checked }))}
        />
        <span>
          A new Chamfecof circuit was installed at hook-in
          <span className="block text-[12px] text-ink-3">
            Tick only if it actually was — this documents the installation in your name and starts the {intervalDays}-day replacement clock. Otherwise the
            tracker shows “no documented installation”.
          </span>
        </span>
      </label>
      <FormError error={error} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-10 rounded-[7px] border border-accent bg-accent px-4 text-[14px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? "Saving…" : "Record hook-in"}
        </button>
        <Link href="/ventilation" className="inline-flex min-h-10 items-center rounded-[7px] border border-line px-4 text-[14px] hover:bg-hover">
          Cancel
        </Link>
      </div>
    </form>
  );
}

const REASONS = ["Scheduled replacement", "Visibly soiled / contaminated", "Damaged / leaking", "Other"];

function ReplaceDialog({ row, intervalDays, onClose }: { row: TubingRowView; intervalDays: number; onClose: () => void }) {
  const router = useRouter();
  const clientId = useClientId();
  const [at, setAt] = useState(manilaNowLocal);
  const [reason, setReason] = useState(REASONS[0]);
  const [other, setOther] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title={`Document tubing replacement · ${row.ventilatorRef}`} onClose={onClose}>
      <p className="text-[12px] text-ink-2">
        {row.patient.name} · {row.wardRoom}. Next due will be {intervalDays} days after the time you enter (current policy).
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await documentTubingAction({
            clientId,
            encounterId: row.encounterId,
            installedAt: at,
            reason: reason === "Other" ? other : reason,
            recordedAtDevice: new Date().toISOString(),
          }).catch(() => ({ ok: false as const, error: "Could not reach the server. Nothing was saved — try again." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <ManilaDateTime label="Replacement time" value={at} onChange={setAt} required />
        <label className={labelCls}>
          Reason
          <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        {reason === "Other" && (
          <label className={labelCls}>
            Describe <span className="text-danger">*</span>
            <input className={inputCls} value={other} onChange={(e) => setOther(e.target.value)} maxLength={300} required />
          </label>
        )}
        <FormError error={error} />
        <Buttons pending={pending} submit="Document replacement" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function VoidTubingDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title="Void tubing entry" onClose={onClose}>
      <p className="text-[12px] text-ink-2">The entry stays visible as voided, with your reason, and no longer counts towards the due date.</p>
      <form
        className="mt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const r = await voidTubingAction(id, reason).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <label className={labelCls}>
          Reason <span className="text-danger">*</span>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} minLength={5} required />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Void entry" onCancel={onClose} />
      </form>
    </Modal>
  );
}

export function TubingList({
  rows,
  intervalDays,
  me,
  isChief,
  canDocument,
}: {
  rows: TubingRowView[];
  intervalDays: number;
  me: string;
  isChief: boolean;
  canDocument: boolean;
}) {
  const [replacing, setReplacing] = useState<TubingRowView | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const columns: Column<TubingRowView>[] = [
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: "vent",
      header: "Ventilator / ward",
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.ventilatorRef}</span>
          <span className="block text-[11px] text-ink-3">{r.wardRoom}</span>
        </span>
      ),
    },
    { key: "patient", header: "Patient", cell: (r) => <PatientCell p={r.patient} /> },
    {
      key: "due",
      header: "Next due",
      cell: (r) =>
        r.nextDueIso ? (
          <span>
            <span className="tabular block">{formatDateTime(new Date(r.nextDueIso))}</span>
            <span className={`block text-[11px] ${r.msUntilDue! <= 0 ? "font-semibold text-danger" : "text-ink-3"}`}>
              {r.msUntilDue! <= 0 ? `overdue by ${describeDuration(r.msUntilDue!)}` : `in ${describeDuration(r.msUntilDue!)}`}
            </span>
          </span>
        ) : (
          <span className="text-danger">No documented installation</span>
        ),
      sort: (r) => r.msUntilDue,
    },
    {
      key: "hist",
      header: "History",
      cell: (r) => (
        <details>
          <summary className="cursor-pointer text-[12px] text-accent-ink">{r.history.length} event(s)</summary>
          <ol className="mt-1 space-y-1 text-[11px] text-ink-2">
            {r.history.map((h) => (
              <li key={h.id} className={h.voided ? "text-ink-3" : ""}>
                <span className={h.voided ? "line-through" : ""}>
                  {formatDateTime(new Date(h.installedIso))} · {h.by} · {h.reason}
                </span>
                {h.voided ? <span> · voided: “{h.voidReason}”</span> : null}
                {!h.voided && (h.byId === me || isChief) ? (
                  <button type="button" onClick={() => setVoiding(h.id)} className="ml-1 text-accent-ink underline">
                    void
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ),
    },
    {
      key: "act",
      header: "Action",
      cell: (r) =>
        canDocument ? (
          <button
            type="button"
            onClick={() => setReplacing(r)}
            className="min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[12px] font-semibold text-white hover:bg-accent-hover"
          >
            Document replacement
          </button>
        ) : null,
    },
  ];
  return (
    <>
      {replacing && <ReplaceDialog row={replacing} intervalDays={intervalDays} onClose={() => setReplacing(null)} />}
      {voiding && <VoidTubingDialog id={voiding} onClose={() => setVoiding(null)} />}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.encounterId}
        caption="Chamfecof tubing on active ventilator encounters"
        emptyTitle="No active ventilator encounters"
      />
    </>
  );
}

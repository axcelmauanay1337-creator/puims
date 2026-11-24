"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { disconnectAction, documentTubingAction, hookInAction, ventSettingAction, voidTubingAction, voidVentSettingAction } from "@/app/actions/documentation";
import type { TubingRowView, VentRow, VentSettingView } from "@/components/tables/ModuleTables";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/primitives";
import { describeDuration } from "@/lib/clinical/tubing";
import {
  AIRWAY_LABEL,
  AIRWAY_TYPES,
  DISCONNECT_LABEL,
  DISCONNECT_REASONS,
  REQUIRED_VENT_NUMBERS,
  VENT_MODE_LABEL,
  VENT_MODES,
  VENT_NUMBERS,
  type VentNumberKey,
} from "@/lib/clinical/vent";
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
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
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
          const r = await disconnectAction(row.id, at, reason, note).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <ManilaDateTime label="Disconnection time" value={at} onChange={setAt} required />
        <label className={`${labelCls} mt-3 block`}>
          Reason <span className="text-danger">*</span>
          <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} required>
            <option value="">Choose…</option>
            {DISCONNECT_REASONS.map((r) => (
              <option key={r} value={r}>
                {DISCONNECT_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className={`${labelCls} mt-3 block`}>
          Note {reason === "OTHER" ? <span className="text-danger">*</span> : <span className="text-ink-3">(optional)</span>}
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} required={reason === "OTHER"} />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Record disconnection" onCancel={onClose} />
      </form>
    </Modal>
  );
}

const short = (k: VentNumberKey, v: Record<string, number>) => (v[k] === undefined ? null : v[k]);

export function settingSummary(x: VentSettingView): string {
  const v = x.values;
  const mode = x.mode === "OTHER" ? (x.modeOther ?? "Other") : (VENT_MODE_LABEL[x.mode as keyof typeof VENT_MODE_LABEL] ?? x.mode);
  const parts = [
    mode,
    `FiO₂ ${v.fio2}%`,
    `PEEP ${v.peep}`,
    short("tidalVolume", v) !== null ? `Vt ${v.tidalVolume}` : null,
    short("inspiratoryPressure", v) !== null ? `Pi ${v.inspiratoryPressure}` : null,
    short("pressureSupport", v) !== null ? `PS ${v.pressureSupport}` : null,
    short("setRate", v) !== null ? `RR ${v.setRate}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function SettingsDialog({ row, onClose }: { row: VentRow; onClose: () => void }) {
  const router = useRouter();
  const clientId = useClientId();
  const last = row.settings.find((x) => !x.voided);
  const [at, setAt] = useState(manilaNowLocal);
  const [mode, setMode] = useState<string>(last?.mode ?? "");
  const [modeOther, setModeOther] = useState(last?.modeOther ?? "");
  // Start from the last documented SET values (never the measured ones) so an unchanged setting is quick to confirm.
  const [values, setValues] = useState<Partial<Record<VentNumberKey, string>>>(() =>
    Object.fromEntries(
      (Object.keys(VENT_NUMBERS) as VentNumberKey[])
        .filter((k) => VENT_NUMBERS[k][4] === "set" && last?.values[k] !== undefined)
        .map((k) => [k, String(last!.values[k])]),
    ),
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const field = (k: VentNumberKey) => {
    const [label, min, max, integer] = VENT_NUMBERS[k];
    const required = REQUIRED_VENT_NUMBERS.includes(k);
    return (
      <label key={k} className={labelCls}>
        {label} {required ? <span className="text-danger">*</span> : null}
        <input
          className={inputCls}
          inputMode={integer ? "numeric" : "decimal"}
          placeholder={`${min}–${max}`}
          required={required}
          value={values[k] ?? ""}
          onChange={(e) => setValues((x) => ({ ...x, [k]: e.target.value }))}
        />
      </label>
    );
  };
  const keys = Object.keys(VENT_NUMBERS) as VentNumberKey[];
  return (
    <Modal title={`Ventilator settings · ${row.ventilatorRef}`} onClose={onClose}>
      <p className="text-[12px] text-ink-2">
        {row.patient.name} · {row.wardRoom}. Record what is on the ventilator. Leave blank anything not used in this mode.
        {last ? " Set values are copied from the last entry — check each one." : ""}
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await ventSettingAction({
            clientId,
            encounterId: row.id,
            recordedAt: at,
            mode,
            modeOther,
            values,
            note,
            recordedAtDevice: new Date().toISOString(),
          }).catch(() => ({ ok: false as const, error: "Could not reach the server. Nothing was saved — try again." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ManilaDateTime label="Time" value={at} onChange={setAt} required />
          <label className={labelCls}>
            Mode <span className="text-danger">*</span>
            <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)} required>
              <option value="">Choose…</option>
              {VENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {VENT_MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          {mode === "OTHER" && (
            <label className={labelCls}>
              Mode name <span className="text-danger">*</span>
              <input className={inputCls} value={modeOther} onChange={(e) => setModeOther(e.target.value)} maxLength={40} required />
            </label>
          )}
        </div>
        <fieldset>
          <legend className="mb-1 text-[12px] font-semibold">Set</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{keys.filter((k) => VENT_NUMBERS[k][4] === "set").map(field)}</div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-[12px] font-semibold">Measured / patient</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{keys.filter((k) => VENT_NUMBERS[k][4] === "measured").map(field)}</div>
        </fieldset>
        <label className={labelCls}>
          Note <span className="text-ink-3">(optional)</span>
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Save settings" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function VoidSettingDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title="Void settings entry" onClose={onClose}>
      <p className="text-[12px] text-ink-2">The entry stays visible as voided, with your reason.</p>
      <form
        className="mt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const r = await voidVentSettingAction(id, reason).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
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

function SettingsCell({ row, me, isChief, onVoid }: { row: VentRow; me: string; isChief: boolean; onVoid: (id: string) => void }) {
  const last = row.settings.find((x) => !x.voided);
  if (!row.settings.length) return <span className="text-ink-3">No settings recorded</span>;
  return (
    <div className="text-[12px]">
      {last ? (
        <>
          <span className="block">{settingSummary(last)}</span>
          <span className="block text-[11px] text-ink-3">
            {formatDateTime(new Date(last.atIso))} · {last.by}
          </span>
        </>
      ) : (
        <span className="text-ink-3">All entries voided</span>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-accent-ink">History ({row.settings.length})</summary>
        <ol className="mt-1 space-y-1.5 text-[11px] text-ink-2">
          {row.settings.map((h) => (
            <li key={h.id} className={h.voided ? "text-ink-3" : ""}>
              <span className={h.voided ? "line-through" : ""}>
                {formatDateTime(new Date(h.atIso))} · {settingSummary(h)}
                {(Object.keys(VENT_NUMBERS) as VentNumberKey[])
                  .filter((k) => VENT_NUMBERS[k][4] === "measured" && h.values[k] !== undefined)
                  .map((k) => ` · ${VENT_NUMBERS[k][0].replace(/ \(.*\)$/, "")} ${h.values[k]}`)
                  .join("")}
                {h.note ? ` · “${h.note}”` : ""} · {h.by}
              </span>
              {h.voided ? <span> · voided: “{h.voidReason}”</span> : null}
              {!h.voided && (h.byId === me || isChief) ? (
                <button type="button" onClick={() => onVoid(h.id)} className="ml-1 text-accent-ink underline">
                  void
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function airwayText(a: VentRow["airway"]): string | null {
  if (!a.type) return null;
  return [AIRWAY_LABEL[a.type as keyof typeof AIRWAY_LABEL] ?? a.type, a.size, a.position].filter(Boolean).join(" · ");
}

export function VentilationList({ rows, canDocument, me, isChief }: { rows: VentRow[]; canDocument: boolean; me: string; isChief: boolean }) {
  const [closing, setClosing] = useState<VentRow | null>(null);
  const [setting, setSetting] = useState<VentRow | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const columns: Column<VentRow>[] = [
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} />, sort: (r) => r.status },
    { key: "patient", header: "Patient", cell: (r) => <PatientCell p={r.patient} />, sort: (r) => r.patient.name },
    { key: "vent", header: "Ventilator", cell: (r) => <span className="tabular">{r.ventilatorRef}</span>, sort: (r) => r.ventilatorRef },
    {
      key: "ward",
      header: "Ward / airway",
      cell: (r) => (
        <span>
          <span className="block">{r.wardRoom}</span>
          {airwayText(r.airway) ? <span className="block text-[11px] text-ink-3">{airwayText(r.airway)}</span> : null}
        </span>
      ),
    },
    { key: "set", header: "Latest settings", cell: (r) => <SettingsCell row={r} me={me} isChief={isChief} onVoid={setVoiding} /> },
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
          <span>
            <span className="tabular block whitespace-nowrap">{formatDateTime(new Date(r.disconnectedIso))}</span>
            {r.disconnectReason ? (
              <span className="block text-[11px] text-ink-3">
                {DISCONNECT_LABEL[r.disconnectReason as keyof typeof DISCONNECT_LABEL] ?? r.disconnectReason}
                {r.disconnectNote ? ` · ${r.disconnectNote}` : ""}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { key: "tub", header: "Tubing", cell: (r) => (r.tubingStatus ? <StatusBadge status={r.tubingStatus} /> : <span className="text-ink-3">—</span>) },
    { key: "rt", header: "Responsible RT", cell: (r) => r.responsible, hideOnCard: true },
    {
      key: "act",
      header: "Action",
      cell: (r) => (
        <span className="flex flex-wrap gap-1.5">
          <Link
            href={`/ventilation/${r.id}/flowsheet`}
            className="inline-flex min-h-9 items-center rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover"
          >
            Flowsheet
          </Link>
          {r.status === "ACTIVE" && canDocument ? (
            <span className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSetting(r)}
                className="min-h-9 rounded-[7px] border border-accent bg-accent px-2.5 text-[12px] font-semibold text-white hover:bg-accent-hover"
              >
                Record settings
              </button>
              <button type="button" onClick={() => setClosing(r)} className="min-h-9 rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover">
                Disconnect
              </button>
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <>
      {closing && <DisconnectDialog row={closing} onClose={() => setClosing(null)} />}
      {setting && <SettingsDialog row={setting} onClose={() => setSetting(null)} />}
      {voiding && <VoidSettingDialog id={voiding} onClose={() => setVoiding(null)} />}
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

export function HookInForm({
  intervalDays,
  initialPatient = null,
  units = [],
  boardRequired = false,
}: {
  intervalDays: number;
  /** True once the equipment board has ventilators: then a board unit must be picked (no typed names). */
  boardRequired?: boolean;
  initialPatient?: { id: string; title: string; subtitle: string; wardRoom?: string | null } | null;
  /** Free ventilators on the equipment board. */
  units?: Array<{ id: string; code: string; model: string; rented: boolean }>;
}) {
  const router = useRouter();
  const clientId = useClientId();
  const [patient, setPatient] = useState<{ id: string; title: string; subtitle: string } | null>(initialPatient);
  const [f, setF] = useState({
    equipmentId: "",
    ventilatorRef: "",
    wardRoom: initialPatient?.wardRoom ?? "",
    hookedAt: manilaNowLocal(),
    newCircuitInstalled: false,
    airwayType: "",
    airwaySize: "",
    airwayPosition: "",
  });
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
        {boardRequired && !units.length ? (
          <p role="alert" className="rounded-[10px] bg-warning-soft px-3 py-2 text-[13px] text-warning sm:col-span-2">
            No free ventilator on the Equipment board (all in use, out of service or due for maintenance). Ask the Chief RT to add or release a unit.
          </p>
        ) : null}
        {units.length ? (
          <label className={labelCls}>
            Ventilator (free units) <span className="text-danger">*</span>
            <select className={inputCls} value={f.equipmentId} required={boardRequired} onChange={(e) => setF((x) => ({ ...x, equipmentId: e.target.value }))}>
              <option value="">{boardRequired ? "Choose a machine…" : "Other / not on the board…"}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {u.model}
                  {u.rented ? " (rented)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {!f.equipmentId && !boardRequired ? (
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
        ) : null}
        <label className={labelCls}>
          Ward / room <span className="text-danger">*</span>
          <input className={inputCls} value={f.wardRoom} onChange={(e) => setF((x) => ({ ...x, wardRoom: e.target.value }))} maxLength={60} required />
        </label>
        <ManilaDateTime label="Hook-in time" value={f.hookedAt} onChange={(v) => setF((x) => ({ ...x, hookedAt: v }))} required />
        <label className={labelCls}>
          Airway
          <select className={inputCls} value={f.airwayType} onChange={(e) => setF((x) => ({ ...x, airwayType: e.target.value }))}>
            <option value="">Not recorded</option>
            {AIRWAY_TYPES.map((a) => (
              <option key={a} value={a}>
                {AIRWAY_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        {f.airwayType && f.airwayType !== "NIV_MASK" ? (
          <>
            <label className={labelCls}>
              Size (e.g. 7.5)
              <input className={inputCls} value={f.airwaySize} onChange={(e) => setF((x) => ({ ...x, airwaySize: e.target.value }))} maxLength={20} />
            </label>
            <label className={labelCls}>
              Position (e.g. 22 cm at lip)
              <input className={inputCls} value={f.airwayPosition} onChange={(e) => setF((x) => ({ ...x, airwayPosition: e.target.value }))} maxLength={40} />
            </label>
          </>
        ) : null}
      </div>
      <p className="text-[12px] text-ink-3">After hook-in, use “Record settings” on the Vents / NIV list to document the ventilator settings.</p>
      <label className="flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={f.newCircuitInstalled}
          onChange={(e) => setF((x) => ({ ...x, newCircuitInstalled: e.target.checked }))}
        />
        <span>
          A new ventilator circuit was installed at hook-in
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

export function ReplaceDialog({
  row,
  intervalDays,
  onClose,
  notice,
}: {
  row: TubingRowView;
  intervalDays: number;
  onClose: () => void;
  notice?: React.ReactNode;
}) {
  const router = useRouter();
  const clientId = useClientId();
  const [at, setAt] = useState(manilaNowLocal);
  const [reason, setReason] = useState(REASONS[0]);
  const [other, setOther] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title={`Change of tubing · ${row.ventilatorRef}`} onClose={onClose}>
      <p className="text-[12px] text-ink-2">
        {row.patient.name} · {row.wardRoom}. Next due will be {intervalDays} days after the time you enter (current policy).
      </p>
      {notice ? <div className="mt-3">{notice}</div> : null}
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
        <Buttons pending={pending} submit="Save change of tubing" onCancel={onClose} />
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
            Change tubing
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
        caption="Change of tubing on active ventilator encounters"
        emptyTitle="No active ventilator encounters"
      />
    </>
  );
}

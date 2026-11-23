"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { startNivAction, updatePatientFlagsAction } from "@/app/actions/workspace";
import { Buttons, FormError, inputCls, labelCls, useClientId } from "@/components/clinical/fields";
import { BookAppointmentButton } from "@/components/diagnostics/Scheduling";
import { Modal } from "@/components/ui/Modal";
import {
  NIV_DEVICES,
  NIV_LABELS,
  NIV_SETTING_HINT,
  OWN_SUPPLIES,
  OWN_SUPPLY_LABELS,
  PRECAUTIONS,
  PRECAUTION_LABELS,
  type NivDevice,
} from "@/lib/clinical/flags";
import { FlagBoxes, type FlagsView } from "./Flags";

const unreachable = { ok: false as const, error: "Could not reach the server. Nothing was saved." };

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** Precautions, special endorsement and the patient's own supplies — view and edit. */
export function PatientFlagsCard({ patientId, flags, canEdit }: { patientId: string; flags: FlagsView; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<FlagsView>(flags);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const empty = !flags.precautions.length && !flags.ownSupplies.length && !flags.endorsement;
  return (
    <section aria-labelledby="flags-h" className="mb-4 rounded-[14px] border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="flags-h" className="text-[14px] font-semibold">
          Precautions · special endorsement · own supplies
        </h2>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => (setF(flags), setEditing(true))}
            className="min-h-9 rounded-[7px] border border-line px-3 text-[13px] hover:bg-hover"
          >
            Edit
          </button>
        ) : null}
      </div>
      {!editing ? (
        empty ? (
          <p className="text-[13px] text-ink-3">None recorded.</p>
        ) : (
          <FlagBoxes flags={flags} />
        )
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            const r = await updatePatientFlagsAction(patientId, f).catch(() => unreachable);
            setPending(false);
            if (!r.ok) return setError(r.error);
            setEditing(false);
            router.refresh();
          }}
        >
          <fieldset>
            <legend className={labelCls}>Precautions</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {PRECAUTIONS.map((p) => (
                <label key={p} className="flex min-h-10 items-center gap-2 rounded-[7px] border border-line px-3 text-[13px]">
                  <input type="checkbox" checked={f.precautions.includes(p)} onChange={() => setF({ ...f, precautions: toggle(f.precautions, p) })} />
                  {PRECAUTION_LABELS[p]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className={labelCls}>Patient&apos;s own supplies</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {OWN_SUPPLIES.map((o) => (
                <label key={o} className="flex min-h-10 items-center gap-2 rounded-[7px] border border-line px-3 text-[13px]">
                  <input type="checkbox" checked={f.ownSupplies.includes(o)} onChange={() => setF({ ...f, ownSupplies: toggle(f.ownSupplies, o) })} />
                  {OWN_SUPPLY_LABELS[o]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className={labelCls}>
            Special endorsement <span className="font-normal text-ink-3">(shows on every task for this patient)</span>
            <textarea
              className={`${inputCls} min-h-20 py-2`}
              maxLength={1000}
              value={f.endorsement ?? ""}
              onChange={(e) => setF({ ...f, endorsement: e.target.value })}
            />
          </label>
          <FormError error={error} />
          <Buttons pending={pending} submit="Save" onCancel={() => setEditing(false)} />
        </form>
      )}
    </section>
  );
}

/** "Add for this patient — no retyping": every action starts with this patient already chosen. */
export function PatientQuickActions({
  patient,
  canDocument,
  canOrder,
  canSchedule,
  nivUnits,
  flags,
}: {
  patient: { id: string; title: string; subtitle: string; wardRoom: string | null };
  canDocument: boolean;
  canOrder: boolean;
  canSchedule: boolean;
  nivUnits: Array<{ id: string; code: string; model: string; kind: "HFNC" | "BIPAP" }>;
  flags: FlagsView;
}) {
  const [niv, setNiv] = useState(false);
  const cls = "inline-flex min-h-10 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold hover:bg-hover";
  return (
    <div className="mb-4 flex flex-wrap gap-2" aria-label="Add for this patient">
      {canDocument ? (
        <Link href={`/ventilation/new?patient=${patient.id}`} className={cls}>
          Hook to ventilator
        </Link>
      ) : null}
      {canDocument ? (
        <button type="button" className={cls} onClick={() => setNiv(true)}>
          Start HFNC / NIV
        </button>
      ) : null}
      {canOrder ? (
        <Link href={`/nebulization/orders/new?patient=${patient.id}`} className={cls}>
          Add nebulization order
        </Link>
      ) : (
        <span className="inline-flex min-h-10 items-center rounded-[8px] border border-dashed border-line px-3 text-[12px] text-ink-2">
          Neb orders: sign in with an RT account
        </span>
      )}
      {canSchedule ? (
        <>
          <BookAppointmentButton service="PFT" patient={patient} label="Book PFT" />
          <BookAppointmentButton service="ABG" patient={patient} label="Book ABG" />
          <BookAppointmentButton service="SPUTUM_INDUCTION" patient={patient} label="Book sputum induction" />
        </>
      ) : null}
      {niv ? <StartNivDialog patient={patient} units={nivUnits} flags={flags} onClose={() => setNiv(false)} /> : null}
    </div>
  );
}

export function StartNivDialog({
  patient,
  units,
  flags,
  onClose,
}: {
  patient: { id: string; title: string; subtitle: string; wardRoom: string | null };
  units: Array<{ id: string; code: string; model: string; kind: "HFNC" | "BIPAP" }>;
  flags?: FlagsView;
  onClose: () => void;
}) {
  const router = useRouter();
  const clientId = useClientId();
  const [device, setDevice] = useState<NivDevice>("HFNC");
  const [setting, setSetting] = useState("");
  const [spo2, setSpo2] = useState("92–96%");
  const [unit, setUnit] = useState("");
  const [ward, setWard] = useState(patient.wardRoom ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const free = units.filter((u) => (device === "HFNC" ? u.kind === "HFNC" : u.kind === "BIPAP"));
  return (
    <Modal title="Start HFNC / NIV" onClose={onClose}>
      <p className="mb-3 text-[12px] text-ink-2">
        <b>{patient.title}</b> · {patient.subtitle} · from Patient Master
      </p>
      {flags ? (
        <div className="mb-3">
          <FlagBoxes flags={flags} />
        </div>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await startNivAction({ clientId, patientId: patient.id, device, setting, spo2Target: spo2, equipmentId: unit, wardRoom: ward }).catch(
            () => unreachable,
          );
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <fieldset>
          <legend className={labelCls}>Device</legend>
          <div className="mt-1 flex gap-2">
            {NIV_DEVICES.map((d) => (
              <label
                key={d}
                className={`flex min-h-10 flex-1 items-center justify-center gap-2 rounded-[7px] border px-3 text-[13px] ${device === d ? "border-accent bg-accent-soft font-semibold" : "border-line"}`}
              >
                <input type="radio" name="niv-device" checked={device === d} onChange={() => (setDevice(d), setUnit(""))} />
                {NIV_LABELS[d]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={labelCls}>
          Setting <span className="text-danger">*</span>
          <input
            className={inputCls}
            value={setting}
            onChange={(e) => setSetting(e.target.value)}
            placeholder={NIV_SETTING_HINT[device]}
            required
            maxLength={120}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            SpO₂ target
            <input className={inputCls} value={spo2} onChange={(e) => setSpo2(e.target.value)} maxLength={20} />
          </label>
          <label className={labelCls}>
            Ward / room
            <input className={inputCls} value={ward} onChange={(e) => setWard(e.target.value)} maxLength={60} />
          </label>
        </div>
        <label className={labelCls}>
          Machine (free units)
          <select className={inputCls} value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">{free.length ? "Choose a machine…" : "No free machine on the board"}</option>
            {free.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code} · {u.model}
              </option>
            ))}
          </select>
        </label>
        <FormError error={error} />
        <Buttons pending={pending} submit="Start" onCancel={onClose} />
      </form>
    </Modal>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { endNivAction } from "@/app/actions/workspace";
import { Buttons, FormError, inputCls, labelCls, PatientPicker } from "@/components/clinical/fields";
import { Modal } from "@/components/ui/Modal";
import { NIV_LABELS } from "@/lib/clinical/flags";
import { formatDayTime } from "@/lib/time/zoned";
import type { NivRow } from "@/server/workspace";
import { FlagChips } from "./Flags";
import { StartNivDialog } from "./PatientPanels";

type Unit = { id: string; code: string; model: string; kind: "HFNC" | "BIPAP" };

export function NivSection({ rows, units, canDocument }: { rows: NivRow[]; units: Unit[]; canDocument: boolean }) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [patient, setPatient] = useState<{ id: string; title: string; subtitle: string } | null>(null);
  const [ending, setEnding] = useState<NivRow | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const count = (d: string) => rows.filter((r) => r.device === d).length;
  return (
    <section aria-labelledby="niv-h" className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="niv-h" className="text-[18px] font-semibold">
            HFNC &amp; NIV
          </h2>
          <p className="text-[12px] text-ink-2">
            {rows.length} running · HFNC {count("HFNC")} · BiPAP {count("BIPAP")} · CPAP {count("CPAP")}
          </p>
        </div>
        {canDocument ? (
          <button
            type="button"
            onClick={() => (setPatient(null), setPicking(true))}
            className="inline-flex min-h-9 items-center rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover"
          >
            Start HFNC / NIV
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line bg-surface px-4 py-5 text-center text-[13px] text-ink-2">No patient on HFNC or NIV.</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-[14px] border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/patients/${r.patient.id}`} className="min-w-0 hover:underline">
                  <span className="block text-[14px] font-semibold">{r.patient.name}</span>
                  <span className="block text-[12px] text-ink-2">
                    {r.wardRoom ?? "—"} · since {formatDayTime(new Date(r.startedIso))} · {r.startedBy}
                  </span>
                </Link>
                <span className="rounded-full bg-[#e0f1f4] px-2.5 py-1 text-[12px] font-semibold text-[#155a66]">{NIV_LABELS[r.device]}</span>
              </div>
              <div className="mt-2">
                <FlagChips flags={r.patient} />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 rounded-[10px] bg-canvas p-2.5 text-[13px]">
                <div className="col-span-2">
                  <dt className="text-[11px] text-ink-3">Setting</dt>
                  <dd className="font-semibold">{r.setting}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-3">SpO₂ target</dt>
                  <dd className="font-semibold">{r.spo2Target ?? "—"}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[12px] text-ink-2">{r.equipment ? `Machine: ${r.equipment.code} · ${r.equipment.model}` : "No machine assigned"}</p>
              {canDocument ? (
                <button
                  type="button"
                  onClick={() => (setEnding(r), setReason(""), setError(null))}
                  className="mt-2 min-h-9 rounded-[7px] border border-line px-3 text-[13px] hover:bg-hover"
                >
                  Discontinue
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {picking && !patient ? (
        <Modal title="Start HFNC / NIV: choose patient" onClose={() => setPicking(false)}>
          <PatientPicker value={null} onChange={(h) => setPatient(h)} />
        </Modal>
      ) : null}
      {picking && patient ? (
        <StartNivDialog
          patient={{ ...patient, wardRoom: null }}
          units={units}
          onClose={() => {
            setPicking(false);
            setPatient(null);
          }}
        />
      ) : null}
      {ending ? (
        <Modal title={`Discontinue ${NIV_LABELS[ending.device]}`} onClose={() => setEnding(null)}>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setPending(true);
              setError(null);
              const r = await endNivAction(ending.id, reason).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
              setPending(false);
              if (!r.ok) return setError(r.error);
              setEnding(null);
              router.refresh();
            }}
          >
            <p className="text-[12px] text-ink-2">
              {ending.patient.name} · {ending.setting}. The machine becomes free on the equipment board.
            </p>
            <label className={labelCls}>
              Reason <span className="text-danger">*</span>
              <input
                className={inputCls}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. weaned to nasal cannula"
                required
                maxLength={200}
              />
            </label>
            <FormError error={error} />
            <Buttons pending={pending} submit="Discontinue" onCancel={() => setEnding(null)} />
          </form>
        </Modal>
      ) : null}
    </section>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveEquipmentAction } from "@/app/actions/workspace";
import { Buttons, FormError, inputCls, labelCls } from "@/components/clinical/fields";
import { Modal } from "@/components/ui/Modal";
import { EQUIPMENT_KINDS, EQUIPMENT_KIND_LABELS, NIV_LABELS, type EquipmentKind } from "@/lib/clinical/flags";
import { formatShortDate } from "@/lib/time/zoned";
import type { EquipmentRow } from "@/server/workspace";

const STATUS: Record<EquipmentRow["status"], { label: string; cls: string }> = {
  IN_USE: { label: "In use", cls: "bg-info-soft text-info" },
  AVAILABLE: { label: "Available", cls: "bg-success-soft text-success" },
  PM_DUE: { label: "PM due", cls: "bg-warning-soft text-warning" },
  OUT_OF_SERVICE: { label: "Out of service", cls: "bg-neutral-soft text-ink-2" },
};
const FILTERS = ["All", "In use", "Available", "PM due", "Rented"] as const;

const peso = (n: number) => `₱${n.toLocaleString("en-PH")}`;

export function EquipmentBoard({ rows, canManage }: { rows: EquipmentRow[]; canManage: boolean }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [edit, setEdit] = useState<EquipmentRow | "new" | null>(null);
  const shown = rows.filter((r) =>
    filter === "All"
      ? true
      : filter === "Rented"
        ? !!r.rentedFrom
        : filter === "In use"
          ? r.status === "IN_USE"
          : filter === "Available"
            ? r.status === "AVAILABLE"
            : r.status === "PM_DUE",
  );
  const stat = (k: EquipmentKind) => `${rows.filter((r) => r.kind === k && r.status === "IN_USE").length} / ${rows.filter((r) => r.kind === k).length}`;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Ventilators in use", stat("VENTILATOR")],
          ["Ventilators free", String(rows.filter((r) => r.kind === "VENTILATOR" && r.status === "AVAILABLE").length)],
          ["HFNC in use", stat("HFNC")],
          ["BiPAP / CPAP in use", stat("BIPAP")],
        ].map(([k, v]) => (
          <div key={k} className="rounded-[14px] border border-line bg-surface px-4 py-3">
            <p className="tabular text-[22px] font-bold">{v}</p>
            <p className="text-[12px] text-ink-2">{k}</p>
          </div>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`min-h-9 rounded-full border px-3.5 text-[13px] ${filter === f ? "border-accent bg-accent font-semibold text-white" : "border-line bg-surface"}`}
          >
            {f}
          </button>
        ))}
        {canManage ? (
          <button
            type="button"
            onClick={() => setEdit("new")}
            className="ml-auto min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover"
          >
            Add unit
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line bg-surface px-4 py-6 text-center text-[13px] text-ink-2">
          No machines on the board yet. {canManage ? "Add your ventilators, HFNC and BiPAP units." : "The Chief RT adds them."}
        </p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.map((e) => (
            <li key={e.id} className="rounded-[14px] border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[15px] font-bold">{e.code}</p>
                  <p className="text-[12px] text-ink-2">
                    {EQUIPMENT_KIND_LABELS[e.kind]} · {e.model}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${STATUS[e.status].cls}`}>{STATUS[e.status].label}</span>
                  {e.rentedFrom ? <span className="rounded-full bg-info-soft px-2.5 py-1 text-[12px] font-semibold text-info">Rented</span> : null}
                </div>
              </div>
              <p className="mt-2 text-[13px]">
                {e.assignedTo ? (
                  <Link href={`/patients/${e.assignedTo.patientId}`} className="hover:underline">
                    {e.assignedTo.name} · {e.assignedTo.wardRoom ?? "—"} · {e.assignedTo.use === "VENTILATOR" ? "Ventilator" : NIV_LABELS[e.assignedTo.use]}
                  </Link>
                ) : e.status === "AVAILABLE" ? (
                  "Free to assign"
                ) : (
                  "Not assignable"
                )}
              </p>
              <p className="mt-1 text-[12px] text-ink-2">
                {e.rentedFrom
                  ? `Rented from ${e.rentedFrom}${e.rentedSince ? ` since ${formatShortDate(e.rentedSince)} · day ${e.rentalDays}` : ""} · ${peso(e.rentalRate ?? 0)}/day`
                  : e.pmDueOn
                    ? `${e.pmDue ? "Preventive maintenance due" : "Next PM"}: ${formatShortDate(e.pmDueOn)}`
                    : "No PM date recorded"}
              </p>
              {canManage ? (
                <button type="button" onClick={() => setEdit(e)} className="mt-2 min-h-8 rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover">
                  Edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {edit ? <EquipmentDialog unit={edit === "new" ? null : edit} onClose={() => setEdit(null)} /> : null}
    </>
  );
}

function EquipmentDialog({ unit, onClose }: { unit: EquipmentRow | null; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({
    code: unit?.code ?? "",
    kind: (unit?.kind ?? "VENTILATOR") as EquipmentKind,
    model: unit?.model ?? "",
    pmDueOn: unit?.pmDueOn ?? "",
    outOfService: unit?.outOfService ?? false,
    rented: !!unit?.rentedFrom,
    rentedFrom: unit?.rentedFrom ?? "",
    rentedSince: unit?.rentedSince ?? "",
    rentalRate: unit?.rentalRate != null ? String(unit.rentalRate) : "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={unit ? `Edit ${unit.code}` : "Add a machine"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await saveEquipmentAction({
            id: unit?.id,
            code: f.code,
            kind: f.kind,
            model: f.model,
            pmDueOn: f.pmDueOn,
            outOfService: f.outOfService,
            rentedFrom: f.rented ? f.rentedFrom : "",
            rentedSince: f.rented ? f.rentedSince : "",
            rentalRate: f.rented ? f.rentalRate : "",
          }).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
          setPending(false);
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Code <span className="text-danger">*</span>
            <input className={inputCls} value={f.code} onChange={set("code")} placeholder="VENT-01" required maxLength={20} />
          </label>
          <label className={labelCls}>
            Type
            <select className={inputCls} value={f.kind} onChange={set("kind")}>
              {EQUIPMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {EQUIPMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Model <span className="text-danger">*</span>
            <input className={inputCls} value={f.model} onChange={set("model")} placeholder="e.g. Hamilton C1" required maxLength={60} />
          </label>
          <label className={labelCls}>
            Next preventive maintenance
            <input className={inputCls} type="date" value={f.pmDueOn} onChange={set("pmDueOn")} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={f.outOfService} onChange={(e) => setF({ ...f, outOfService: e.target.checked })} /> Out of service (cannot be
          assigned)
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={f.rented} onChange={(e) => setF({ ...f, rented: e.target.checked })} /> Rented unit
        </label>
        {f.rented ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={labelCls}>
              Vendor
              <input className={inputCls} value={f.rentedFrom} onChange={set("rentedFrom")} required maxLength={80} />
            </label>
            <label className={labelCls}>
              Rented since
              <input className={inputCls} type="date" value={f.rentedSince} onChange={set("rentedSince")} />
            </label>
            <label className={labelCls}>
              Rate per day (₱)
              <input className={inputCls} inputMode="decimal" value={f.rentalRate} onChange={set("rentalRate")} required />
            </label>
          </div>
        ) : null}
        <FormError error={error} />
        <Buttons pending={pending} submit="Save" onCancel={onClose} />
      </form>
    </Modal>
  );
}

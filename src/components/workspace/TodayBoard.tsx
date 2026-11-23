"use client";

import Link from "next/link";
import { useState } from "react";
import { DocumentDoseDialog } from "@/components/clinical/Nebulization";
import { ReplaceDialog } from "@/components/clinical/Ventilation";
import type { TubingRowView } from "@/components/tables/ModuleTables";
import { formatTime } from "@/lib/time/zoned";
import type { TodayTask } from "@/server/workspace";
import { FlagBoxes, FlagChips } from "./Flags";

const KIND: Record<TodayTask["kind"], { label: string; cls: string }> = {
  NEB: { label: "NEB", cls: "bg-info-soft text-info" },
  TUBE: { label: "TUBE", cls: "bg-warning-soft text-warning" },
  TEST: { label: "TEST", cls: "bg-[#eee7f6] text-[#553a80]" },
};
const TONE: Record<TodayTask["tone"], string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
};

export interface DoneItem {
  key: string;
  title: string;
  patient: TodayTask["patient"];
  status: string;
  atIso: string;
  by: string | null;
}

function TaskRow({ t, onOpen, canDocument }: { t: TodayTask; onOpen: (t: TodayTask) => void; canDocument: boolean }) {
  const body = (
    <>
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-[11px] font-bold ${KIND[t.kind].cls}`}>{KIND[t.kind].label}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{t.title}</span>
        <span className="block truncate text-[12px] text-ink-2">
          {t.patient.name} · {t.patient.wardRoom ?? "—"}
        </span>
        <span className="mt-1 block">
          <FlagChips flags={t.patient} />
        </span>
      </span>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${TONE[t.tone]}`}>{t.whenLabel}</span>
    </>
  );
  const cls = "flex w-full items-center gap-3 rounded-[14px] border border-line bg-surface px-3.5 py-3 text-left hover:border-[#c9cec6]";
  if (t.kind === "TEST" || !canDocument)
    return (
      <Link href={t.href} className={cls}>
        {body}
      </Link>
    );
  return (
    <button type="button" className={cls} onClick={() => onOpen(t)}>
      {body}
    </button>
  );
}

export function TodayBoard({
  dueNow,
  later,
  done,
  canDocument,
  intervalDays,
}: {
  dueNow: TodayTask[];
  later: TodayTask[];
  done: DoneItem[];
  canDocument: boolean;
  intervalDays: number;
}) {
  const [open, setOpen] = useState<TodayTask | null>(null);
  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <section aria-labelledby="due-h" className="min-w-0 space-y-2">
          <h2 id="due-h" className="px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-ink-2">
            Due now <span className="font-semibold text-ink-3">({dueNow.length})</span>
          </h2>
          {dueNow.length ? (
            dueNow.map((t) => <TaskRow key={t.key} t={t} onOpen={setOpen} canDocument={canDocument} />)
          ) : (
            <p className="rounded-[14px] border border-dashed border-line bg-surface px-4 py-5 text-center text-[13px] text-ink-2">Nothing due right now.</p>
          )}
        </section>
        <section aria-labelledby="later-h" className="min-w-0 space-y-2">
          <h2 id="later-h" className="px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-ink-2">
            Later this shift <span className="font-semibold text-ink-3">({later.length})</span>
          </h2>
          {later.length ? (
            later.map((t) => <TaskRow key={t.key} t={t} onOpen={setOpen} canDocument={canDocument} />)
          ) : (
            <p className="rounded-[14px] border border-dashed border-line bg-surface px-4 py-5 text-center text-[13px] text-ink-2">Nothing else this shift.</p>
          )}
        </section>
      </div>
      {done.length ? (
        <section aria-labelledby="done-h" className="mt-5 min-w-0 space-y-2">
          <h2 id="done-h" className="px-1 text-[12px] font-bold uppercase tracking-[0.06em] text-ink-2">
            Done this shift <span className="font-semibold text-ink-3">({done.length})</span>
          </h2>
          <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {done.map((d) => (
              <li key={d.key} className="flex items-center gap-3 rounded-[14px] border border-line bg-surface px-3.5 py-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-info-soft text-[10px] font-bold text-info">NEB</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{d.title}</span>
                  <span className="block truncate text-[12px] text-ink-2">
                    {d.patient.name} · {formatTime(new Date(d.atIso))} · {d.by ?? "—"}
                  </span>
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${d.status === "COMPLETED" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
                >
                  {d.status === "COMPLETED" ? "Given" : d.status.replace("_", " ").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {open?.kind === "NEB" && open.neb ? (
        <DocumentDoseDialog
          target={{
            orderId: open.neb.orderId,
            orderReference: open.neb.orderReference,
            medication: open.neb.medication,
            patient: open.patient.name,
            scheduledIso: open.neb.scheduledIso,
          }}
          notice={<FlagBoxes flags={open.patient} />}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "TUBE" && open.encounterId ? (
        <ReplaceDialog
          row={
            {
              encounterId: open.encounterId,
              ventilatorRef: open.ventilatorRef ?? "",
              wardRoom: open.patient.wardRoom ?? "—",
              patient: open.patient,
            } as unknown as TubingRowView
          }
          intervalDays={intervalDays}
          notice={<FlagBoxes flags={open.patient} />}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { acknowledgeHandoverAction, createHandoverAction } from "@/app/actions/clinical";
import type { HandoverDraft } from "@/server/clinical";
import { SHIFT_DEFINITIONS } from "@/lib/time/shifts";
import { formatShortDate } from "@/lib/time/zoned";

const KIND_LABEL = {
  VENTILATOR_ENCOUNTER: "Ventilator",
  NEBULIZATION_ADMIN: "Nebulization",
  NEBULIZATION_ORDER: "Nebulization",
  TUBING: "Tubing",
  DIAGNOSTIC: "Diagnostic",
} as const;

export function HandoverComposer({ draft, isChief }: { draft: HandoverDraft; isChief: boolean }) {
  const router = useRouter();
  const key = (k: string, id: string, slot: string | null = null) => `${k}:${id}:${slot ?? ""}`;
  const [selected, setSelected] = useState<Set<string>>(new Set(draft.candidates.filter((c) => c.problem).map((c) => key(c.kind, c.refId, c.slotAt))));
  const [showRoutine, setShowRoutine] = useState(false);
  const [notes, setNotes] = useState("");
  const [equipment, setEquipment] = useState("");
  const [incoming, setIncoming] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const label = `${SHIFT_DEFINITIONS[draft.shift.shift].label} shift · ${formatShortDate(draft.shift.operationalDate)}`;

  const problems = draft.candidates.filter((c) => c.problem);
  const routine = draft.candidates.filter((c) => !c.problem);
  const itemList = (list: typeof draft.candidates) => (
    <ul className="mt-1 max-h-72 divide-y divide-line-soft overflow-y-auto rounded-[7px] border border-line">
      {list.map((c) => {
        const k = key(c.kind, c.refId, c.slotAt);
        return (
          <li key={k}>
            <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[12px] hover:bg-hover">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={selected.has(k)}
                onChange={(e) =>
                  setSelected((x) => {
                    const n = new Set(x);
                    if (e.target.checked) n.add(k);
                    else n.delete(k);
                    return n;
                  })
                }
              />
              <span>
                <span className="font-semibold">{KIND_LABEL[c.kind]}</span> · {c.summary}
                <span className="block text-ink-3">{c.patient}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );

  if (draft.alreadyWritten) return null;
  if (!draft.rostered && !isChief) {
    return (
      <p className="rounded-[10px] border border-line bg-surface p-4 text-[12px] text-ink-2">
        {label}: no handover written yet. Only an RT rostered on that shift (or the Chief RT) can write it.
      </p>
    );
  }

  return (
    <form
      className="rounded-[10px] border border-line bg-surface p-4"
      aria-label={`Write handover — ${label}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        const items = draft.candidates
          .filter((c) => selected.has(key(c.kind, c.refId, c.slotAt)))
          .map((c) => ({ kind: c.kind, refId: c.refId, slotAt: c.slotAt }));
        const r = await createHandoverAction({
          operationalDate: draft.shift.operationalDate,
          shift: draft.shift.shift,
          incomingStaffId: incoming || null,
          equipmentConcerns: equipment,
          notes,
          items,
        }).catch(() => ({ ok: false as const, error: "Could not reach the server. Nothing was saved." }));
        setPending(false);
        if (!r.ok) setError(r.error);
        else router.refresh();
      }}
    >
      <h2 className="text-[14px] font-semibold">Write handover — {label}</h2>
      <p className="mt-0.5 text-[12px] text-ink-3">
        One handover per shift. Open items are linked to the original records (not copied) and show their live status to the incoming RT.
        {!draft.rostered && isChief ? " You are not rostered on this shift; it will be recorded as written by you." : ""}
      </p>
      <fieldset className="mt-3">
        <legend className="text-[12px] font-semibold text-ink-2">
          Needs attention ({problems.filter((c) => selected.has(key(c.kind, c.refId, c.slotAt))).length} ticked)
        </legend>
        <p className="mt-0.5 text-[11px] text-ink-3">
          Late or missed doses, overdue tubing, new hook-ins and tests not yet done. Untick anything already sorted.
        </p>
        {problems.length === 0 ? <p className="mt-1 text-[12px] text-ink-3">Nothing needs attention.</p> : itemList(problems)}
      </fieldset>
      {routine.length ? (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={showRoutine}
            onClick={() => setShowRoutine((v) => !v)}
            className="min-h-9 rounded-[7px] border border-line px-3 text-[12px] font-medium hover:bg-hover"
          >
            {showRoutine ? "Hide" : "Show"} routine items ({routine.length}) — running ventilators, upcoming doses and tests
          </button>
          {showRoutine ? itemList(routine) : null}
        </div>
      ) : null}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="block text-[12px] font-medium text-ink-2">
          Handover notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={4000}
            rows={4}
            className="mt-1 block w-full rounded-[7px] border border-line px-3 py-2 text-[13px]"
          />
        </label>
        <div className="space-y-3">
          <label className="block text-[12px] font-medium text-ink-2">
            Equipment concerns <span className="font-normal text-ink-3">(optional)</span>
            <textarea
              value={equipment}
              onChange={(e) => setEquipment(e.target.value)}
              maxLength={2000}
              rows={2}
              className="mt-1 block w-full rounded-[7px] border border-line px-3 py-2 text-[13px]"
            />
          </label>
          <label className="block text-[12px] font-medium text-ink-2">
            Incoming RT <span className="font-normal text-ink-3">(optional — from the next shift&apos;s roster)</span>
            <select
              value={incoming}
              onChange={(e) => setIncoming(e.target.value)}
              className="mt-1 block min-h-9 w-full rounded-[7px] border border-line px-2 text-[13px]"
            >
              <option value="">Not specified</option>
              {draft.incomingOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-3 min-h-10 rounded-[7px] border border-accent bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
      >
        {pending ? "Saving…" : "Submit handover"}
      </button>
    </form>
  );
}

export function AcknowledgeButton({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const r = await acknowledgeHandoverAction(id).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
          setPending(false);
          if (!r.ok) setError(r.error);
          else router.refresh();
        }}
        className="min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
      >
        {pending ? "Saving…" : "Acknowledge handover"}
      </button>
      {error && (
        <span role="alert" className="mt-1 text-[11px] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

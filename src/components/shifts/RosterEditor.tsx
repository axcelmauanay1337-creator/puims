"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { assignShiftAction, removeAssignmentAction } from "@/app/actions/clinical";
import { SHIFT_DEFINITIONS, type ShiftCode } from "@/lib/time/shifts";
import { formatCompactDate } from "@/lib/time/zoned";

interface Roster {
  today: string;
  staff: Array<{ id: string; name: string }>;
  dates: Array<{ date: string; shifts: Array<{ shift: ShiftCode; assignments: Array<{ id: string; staffId: string; name: string }> }> }>;
}

export function RosterEditor({ roster }: { roster: Roster }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    setBusy(true);
    setMessage(null);
    const r = await fn().catch(() => ({ ok: false, error: "Could not reach the server." }));
    setBusy(false);
    setMessage(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? "Not saved." });
    if (r.ok) router.refresh();
  }

  return (
    <div>
      <p role="status" aria-live="polite" className={`mb-2 min-h-5 text-[12px] ${message?.ok ? "text-success" : "text-danger"}`}>
        {message ? (message.ok ? `✓ ${message.text}` : message.text) : ""}
      </p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
        <table className="w-full min-w-[820px] border-collapse text-[12px]">
          <caption className="sr-only">Editable shift roster</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-line py-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                Operational date
              </th>
              {(["MORNING", "AFTERNOON", "NIGHT"] as const).map((s) => (
                <th key={s} scope="col" className="border-b border-line px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                  {SHIFT_DEFINITIONS[s].label} <span className="font-normal normal-case">{SHIFT_DEFINITIONS[s].rangeLabel}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roster.dates.map((d) => (
              <tr key={d.date} className={d.date === roster.today ? "bg-accent-soft/50" : ""} data-testid={`roster-${d.date}`}>
                <th scope="row" className="border-b border-line-soft py-2 pr-3 text-left align-top font-medium">
                  {formatCompactDate(d.date)} {d.date === roster.today ? <span className="text-[11px] font-semibold text-accent-ink">· today</span> : null}
                </th>
                {d.shifts.map((s) => {
                  const available = roster.staff.filter((x) => !s.assignments.some((a) => a.staffId === x.id));
                  const label = `${formatCompactDate(d.date)} ${SHIFT_DEFINITIONS[s.shift].label}`;
                  return (
                    <td key={s.shift} className="border-b border-line-soft px-2 py-2 align-top" data-testid={`cell-${d.date}-${s.shift}`}>
                      <ul className="flex flex-wrap gap-1">
                        {s.assignments.map((a) => (
                          <li key={a.id} className="inline-flex items-center gap-1 rounded-[5px] border border-line bg-surface py-0.5 pl-1.5 pr-0.5">
                            {a.name}
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={`Remove ${a.name} from ${label}`}
                              onClick={() => {
                                const reason = prompt(`Remove ${a.name} from ${label}? Optional reason:`);
                                if (reason === null) return;
                                act(() => removeAssignmentAction(a.id, reason), `${a.name} removed from ${label}.`);
                              }}
                              className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-danger-soft hover:text-danger"
                            >
                              ×
                            </button>
                          </li>
                        ))}
                        {s.assignments.length === 0 && <li className="text-ink-3">Unassigned</li>}
                      </ul>
                      {available.length > 0 && (
                        <select
                          aria-label={`Add staff to ${label}`}
                          disabled={busy}
                          value=""
                          onChange={(e) => {
                            const id = e.target.value;
                            const who = roster.staff.find((x) => x.id === id)?.name;
                            if (id) act(() => assignShiftAction(d.date, s.shift, id), `${who} added to ${label}.`);
                          }}
                          className="mt-1 min-h-8 w-full max-w-48 rounded-[6px] border border-line bg-surface px-1.5 text-[12px] text-ink-2"
                        >
                          <option value="">+ Add…</option>
                          {available.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postChargesAction } from "@/app/actions/workspace";
import { FormError } from "@/components/clinical/fields";
import { formatDateTime } from "@/lib/time/zoned";
import type { ChargeGroup } from "@/server/workspace";

const peso = (n: number) => `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function ChargesBoard({ date, groups }: { date: string; groups: ChargeGroup[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingGroups = groups.filter((g) => !g.posted && g.lines.length);
  const total = groups.reduce((a, g) => a + (g.posted ? g.posted.total : g.total), 0);
  const posted = groups.reduce((a, g) => a + (g.posted ? g.posted.total : 0), 0);
  const post = async (ids: string[]) => {
    setPending(true);
    setError(null);
    const r = await postChargesAction(date, ids).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
    setPending(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  };
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-3">
        {[
          ["Total", total],
          ["Not yet posted", total - posted],
          ["Posted to billing", posted],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-[14px] border border-line bg-surface px-4 py-3">
            <p className="tabular text-[22px] font-bold">{peso(v as number)}</p>
            <p className="text-[12px] text-ink-2">{k}</p>
          </div>
        ))}
      </div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          disabled={pending || !pendingGroups.length}
          onClick={() => post(pendingGroups.map((g) => g.patient.id))}
          className="min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Post all to billing
        </button>
      </div>
      <FormError error={error} />
      {groups.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line bg-surface px-4 py-6 text-center text-[13px] text-ink-2">
          No machine in use on this day.
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.patient.id} className="rounded-[14px] border border-line bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
                <Link href={`/patients/${g.patient.id}`} className="hover:underline">
                  <span className="block text-[14px] font-semibold">{g.patient.name}</span>
                  <span className="block text-[12px] text-ink-2">
                    {g.patient.wardRoom ?? "—"} · {g.patient.hospitalId}
                  </span>
                </Link>
                <span className="flex items-center gap-2">
                  <span className="tabular text-[15px] font-bold">{peso(g.posted ? g.posted.total : g.total)}</span>
                  {g.posted ? (
                    <span
                      className="rounded-full bg-success-soft px-2.5 py-1 text-[12px] font-semibold text-success"
                      title={formatDateTime(new Date(g.posted.atIso))}
                    >
                      Posted ✓
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={pending || !g.lines.length}
                      onClick={() => post([g.patient.id])}
                      className="min-h-8 rounded-[7px] border border-line px-3 text-[12px] hover:bg-hover"
                    >
                      Post
                    </button>
                  )}
                </span>
              </div>
              <table className="w-full text-[13px]">
                <caption className="sr-only">Machine charges for {g.patient.name}</caption>
                <tbody>
                  {g.lines.map((l, i) => (
                    <tr key={i} className="border-b border-line-soft last:border-0">
                      <td className="px-4 py-2">{l.description}</td>
                      <td className="tabular px-2 py-2 text-right text-ink-2">× {l.qty}</td>
                      <td className="tabular px-2 py-2 text-right text-ink-2">{peso(l.price)}</td>
                      <td className="tabular px-4 py-2 text-right font-semibold">{peso(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

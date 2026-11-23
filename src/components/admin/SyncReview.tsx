"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { resolveSyncAction } from "@/app/actions/offline";
import { Badge } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import type { SyncReviewItem } from "@/server/offline";

const btn = "min-h-8 rounded-[7px] border border-line px-2.5 text-[12px] hover:bg-hover disabled:opacity-60";

export function SyncReview({ items, myStaffId }: { items: SyncReviewItem[]; myStaffId: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!items.length) return <p className="text-[13px] text-ink-2">No offline entries are waiting for review.</p>;
  return (
    <div>
      {msg ? (
        <p role={msg.ok ? "status" : "alert"} className={`mb-2 text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>
          {msg.text}
        </p>
      ) : null}
      <ul className="divide-y divide-line-soft text-[13px]">
        {items.map((x) => (
          <li key={x.id} className="py-2.5" data-testid="sync-conflict">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={x.outcome === "CONFLICT" ? "warning" : "danger"}>{x.outcome === "CONFLICT" ? "Conflict" : "Rejected"}</Badge>
              <span className="font-medium">{x.summary}</span>
            </p>
            <p className="text-[12px] text-ink-2">
              {x.message} · captured by {x.staff} · device time {x.recordedIso ? formatDateTime(new Date(x.recordedIso)) : "—"} · received{" "}
              {formatDateTime(new Date(x.receivedIso))}
              {x.skewMs !== null && Math.abs(x.skewMs) > 60_000 ? ` · device clock off by ${Math.round(x.skewMs / 60_000)} min` : ""}
            </p>
            {x.resolution ? (
              <p className="text-[12px] text-ink-3">
                Resolved: {x.resolution === "APPLIED" ? "applied" : "not applied"} by {x.resolvedBy}
                {x.resolutionNote ? ` — “${x.resolutionNote}”` : ""}
              </p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-2">
                {x.staffId === myStaffId ? (
                  <button
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={async () => {
                      if (!confirm("Apply this entry now as documentation in your name? Check the times against your notes first.")) return;
                      setBusy(true);
                      const r = await resolveSyncAction(x.id, "APPLIED", "").catch(() => ({ ok: false as const, error: "Could not reach the server." }));
                      setBusy(false);
                      setMsg(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error });
                      if (r.ok) router.refresh();
                    }}
                  >
                    Apply after checking
                  </button>
                ) : null}
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={async () => {
                    const note = prompt("Why is this entry not applied? (e.g. already documented, entered in error)");
                    if (note === null) return;
                    setBusy(true);
                    const r = await resolveSyncAction(x.id, "NOT_APPLIED", note).catch(() => ({ ok: false as const, error: "Could not reach the server." }));
                    setBusy(false);
                    setMsg(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error });
                    if (r.ok) router.refresh();
                  }}
                >
                  Do not apply…
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

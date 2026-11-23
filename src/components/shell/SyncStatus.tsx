"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/time/zoned";
import { CLOCK_SKEW_WARN_MS, MODE_COPY, useConnectivity } from "./Connectivity";

const TONE: Record<string, string> = {
  success: "border-[#cfe3d6] bg-success-soft text-success",
  info: "border-[#d6e3ee] bg-info-soft text-info",
  danger: "border-[#f0d0cc] bg-danger-soft text-danger",
  neutral: "border-line bg-neutral-soft text-ink-2",
};

/** Always-visible status chip + details popover (top bar, all screen sizes). */
export function SyncIndicator() {
  const c = useConnectivity();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const copy = MODE_COPY[c.mode];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const skewWarn = c.clockSkewMs !== null && Math.abs(c.clockSkewMs) > CLOCK_SKEW_WARN_MS;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="sync-indicator"
        data-mode={c.mode}
        className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold ${TONE[copy.tone]}`}
      >
        <span aria-hidden="true">{copy.glyph}</span>
        <span className="hidden sm:inline">{copy.short}</span>
        <span className="sr-only sm:hidden">{copy.label}</span>
        {skewWarn ? <span aria-label="Clock skew warning">⚠</span> : null}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Connection and sync status"
          className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[var(--radius-card)] border border-line bg-surface p-4 text-[12px] shadow-lg"
        >
          <p className="text-[13px] font-semibold text-ink">{copy.label}</p>
          <dl className="mt-3 space-y-2 text-ink-2">
            <Row k="Last server contact" v={c.lastContactIso ? `${formatDateTime(new Date(c.lastContactIso))} (Asia/Manila)` : "None this session"} />
            <Row k="Server profile" v={c.profile ?? "Unknown"} />
            <Row k="Last successful data sync" v="Not applicable — offline sync not enabled on this device" />
            <Row k="Pending offline queue" v="No offline queue on this device" />
            <Row k="Sync conflicts" v="None (no offline queue)" />
            <Row k="Offline patient data" v="Not stored on this device" />
            <Row
              k="Device clock"
              v={
                c.clockSkewMs === null
                  ? "Not yet measured"
                  : skewWarn
                    ? `⚠ ${Math.round(c.clockSkewMs / 1000)}s off server time — check device clock`
                    : `Within ${Math.max(1, Math.round(Math.abs(c.clockSkewMs) / 1000))}s of server`
              }
            />
          </dl>
          {c.lastError && c.mode === "offline" ? <p className="mt-3 text-danger">{c.lastError}</p> : null}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button type="button" onClick={c.checkNow} className="min-h-8 rounded-[var(--radius-control)] border border-line px-2.5 font-medium hover:bg-hover">
              Check connection now
            </button>
            <Link href="/devices" onClick={() => setOpen(false)} className="font-medium text-accent-ink underline-offset-2 hover:underline">
              Devices & sync
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

/** Full-width banner when the server is unreachable. Says exactly what is (un)available. */
export function OfflineBanner() {
  const c = useConnectivity();
  if (c.mode !== "offline") return null;
  return (
    <div role="alert" data-testid="offline-banner" className="border-b border-[#f0d0cc] bg-danger-soft px-4 py-2 text-[12px] text-danger md:px-8">
      <strong>Offline — PUIMS server unreachable.</strong> This device holds no offline patient data and has no offline queue yet, so nothing can be documented
      until the connection returns. Information already on screen may be out of date
      {c.lastContactIso ? ` (last server contact ${formatDateTime(new Date(c.lastContactIso))})` : ""}.{" "}
      <button type="button" onClick={c.checkNow} className="font-semibold underline">
        Retry now
      </button>
    </div>
  );
}

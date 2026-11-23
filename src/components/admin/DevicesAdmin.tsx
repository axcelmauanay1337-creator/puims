"use client";

import { useState } from "react";
import { endSessionAction, revokeDeviceAction, type AdminResult } from "@/app/actions/admin";
import { deviceOfflineAction } from "@/app/actions/offline";
import { Badge, StatusBadge } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { ResultNote, useSensitiveAction } from "./useSensitiveAction";

interface SessionView {
  id: string;
  deviceLabel: string;
  staff: string;
  createdIso: string;
  lastSeenIso: string;
  current: boolean;
}
interface DeviceView {
  id: string;
  label: string;
  createdIso: string;
  lastSeenIso: string;
  status: "ACTIVE" | "REVOKED";
  revokedReason: string | null;
  users: string[];
  current: boolean;
  offlineApproved: boolean;
}

export function SessionsList({ sessions, showStaff }: { sessions: SessionView[]; showStaff: boolean }) {
  const { run, busy, element } = useSensitiveAction();
  const [result, setResult] = useState<AdminResult | null>(null);
  return (
    <>
      {element}
      <ResultNote result={result} />
      <ul className="divide-y divide-line-soft">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-[12px]">
            <span className="min-w-0 flex-1">
              <b className="block text-[13px]">
                {s.deviceLabel} {s.current ? <Badge tone="success">This session</Badge> : null}
              </b>
              {showStaff ? `${s.staff} · ` : ""}signed in {formatDateTime(new Date(s.createdIso))} · last active {formatDateTime(new Date(s.lastSeenIso))}
            </span>
            {!s.current && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => setResult(await run(() => endSessionAction(s.id)))}
                className="min-h-8 rounded-[7px] border border-line px-2.5 hover:bg-hover"
              >
                Sign out this session
              </button>
            )}
          </li>
        ))}
        {sessions.length === 0 && <li className="py-3 text-ink-3">No active sessions.</li>}
      </ul>
    </>
  );
}

export function DeviceList({ devices, canRevoke }: { devices: DeviceView[]; canRevoke: boolean }) {
  const { run, busy, element } = useSensitiveAction();
  const [result, setResult] = useState<AdminResult | null>(null);
  return (
    <>
      {element}
      <ResultNote result={result} />
      <ul className="divide-y divide-line-soft">
        {devices.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-[12px]" data-testid="device-row" data-device-id={d.id}>
            <span className="min-w-0 flex-1">
              <b className="block text-[13px]">
                {d.label} {d.current ? <Badge tone="success">This device</Badge> : null}
              </b>
              Used by {d.users.join(", ") || "—"} · first seen {formatDateTime(new Date(d.createdIso))} · last seen {formatDateTime(new Date(d.lastSeenIso))}
              {d.revokedReason ? ` · revoked: ${d.revokedReason}` : ""}
            </span>
            {d.offlineApproved ? <Badge tone="warning">Offline capture: approved</Badge> : <Badge>Offline capture: not approved</Badge>}
            {canRevoke && d.status === "ACTIVE" ? (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (
                    !d.offlineApproved &&
                    !confirm(
                      "Approve this device for offline capture? Encrypted patient worklists and entries may be stored on it for up to 12 hours. Approve only managed devices that meet hospital policy (U-03).",
                    )
                  )
                    return;
                  setResult(await run(() => deviceOfflineAction(d.id, !d.offlineApproved) as Promise<AdminResult>));
                }}
                className="min-h-8 rounded-[7px] border border-line px-2.5 hover:bg-hover"
              >
                {d.offlineApproved ? "Withdraw offline approval" : "Approve for offline…"}
              </button>
            ) : null}
            <StatusBadge status={d.status === "ACTIVE" ? "ACTIVE" : "DEACTIVATED"} />
            {canRevoke && d.status === "ACTIVE" && !d.current && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const reason = prompt("Reason for revoking this device (e.g. lost, stolen, retired):");
                  if (reason === null) return;
                  setResult(await run(() => revokeDeviceAction(d.id, reason)));
                }}
                className="min-h-8 rounded-[7px] border border-[#f0d0cc] px-2.5 text-danger hover:bg-danger-soft"
              >
                Revoke device
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

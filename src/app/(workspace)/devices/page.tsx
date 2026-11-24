import { ThisDeviceStatus } from "@/components/ThisDeviceStatus";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { DeviceList, SessionsList } from "@/components/admin/DevicesAdmin";
import { Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { SyncReview } from "@/components/admin/SyncReview";
import { Badge } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { listDevices } from "@/server/data";
import { listSyncReview, offlineStatus } from "@/server/offline";
import { guard } from "@/server/guard";

export const metadata = { title: "Devices & Sync" };

const MATRIX: Array<[string, string, string, string]> = [
  // capability, A online, B LAN-only, C full outage (current release)
  ["Open app shell", "Yes", "Yes", "Offline notice page; offline capture page on prepared devices"],
  ["View patients & schedules", "Yes", "Yes (LAN endpoint profile)", "No — only the prepared worklist snapshot, on approved devices, while unlocked"],
  ["Document nebulization doses & tubing replacements", "Yes", "Yes (LAN endpoint profile)", "Approved + prepared devices only: encrypted queue, synced later"],
  ["Other documentation (hook-in, disconnection, diagnostics, PFT form, handover)", "Yes", "Yes (LAN endpoint profile)", "No — online only"],
  ["Enter/discontinue nebulization orders (RTs only)", "Yes", "Yes", "Never offline"],
  ["Register patients", "Yes", "Yes", "Never offline"],
  ["See other devices' new entries", "Yes, via server", "Yes, via LAN server", "No — the snapshot is not updated while offline"],
  ["Conflicts", "Resolved in Sync review", "Same", "Detected at sync; never last-write-wins"],
];

export default async function DevicesPage() {
  const session = await guard("devices:read-own");
  if (!session) return <AccessDenied what="device management" />;
  const { sessions, devices } = await listDevices(session);
  const off = await offlineStatus(session);
  const review = await listSyncReview(session);
  const chief = session.role === "CHIEF_RT_ADMIN";
  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Devices & Sync"
        crumbs={[{ label: "System" }, { label: "Devices & Sync" }]}
        description="What this device can do right now, and which devices are registered. Nothing here claims an offline capability that does not exist."
      />
      <Card className="mb-4" aria-labelledby="this-h">
        <CardHeader id="this-h" title="This device" subtitle="Measured live in your browser" />
        <ThisDeviceStatus />
      </Card>

      <Card className="mb-4" aria-labelledby="matrix-h">
        <CardHeader
          id="matrix-h"
          title="Offline behaviour — current release"
          subtitle="A = internet + LAN · B = LAN/local server only · C = complete network outage"
        />
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
          <table className="w-full min-w-[640px] text-[12px]">
            <caption className="sr-only">Offline behaviour matrix</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Capability
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  A · Online
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  B · LAN only
                </th>
                <th scope="col" className="py-1.5 font-semibold">
                  C · Full outage
                </th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(([cap, a, b, c]) => (
                <tr key={cap} className="border-t border-line-soft align-top">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                    {cap}
                  </th>
                  <td className="py-1.5 pr-3">{a}</td>
                  <td className="py-1.5 pr-3">{b}</td>
                  <td className="py-1.5">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mb-4" aria-labelledby="sess-h">
        <CardHeader
          id="sess-h"
          title={chief ? "Active sessions (unit)" : "My active sessions"}
          subtitle="Signing out a session takes effect immediately on the server — the next request from that browser is refused."
        />
        <SessionsList sessions={sessions} showStaff={chief} />
      </Card>

      <Card className="mb-4" aria-labelledby="reg-h">
        <CardHeader
          id="reg-h"
          title={chief ? "Devices (unit)" : "My devices"}
          subtitle="A device is a browser profile that has signed in. Revoking it ends its sessions and blocks it from signing in again."
        />
        <DeviceList devices={devices} canRevoke={chief} />
      </Card>

      <Card className="mb-4" aria-labelledby="off-h">
        <CardHeader
          id="off-h"
          title="Offline capture on this device"
          subtitle="Interim policy pending hospital approval (U-03): approved devices only · 12-hour lease · encrypted queue"
        />
        <dl className="space-y-1.5 text-[13px]">
          <div>
            <dt className="inline text-ink-3">Device approval: </dt>
            <dd className="inline">
              {off.deviceApproved ? (
                <Badge tone="warning">approved {off.approvedIso ? formatDateTime(new Date(off.approvedIso)) : ""}</Badge>
              ) : (
                <Badge>not approved</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="inline text-ink-3">Your offline lease: </dt>
            <dd className="inline">{off.activeLease ? `active until ${formatDateTime(new Date(off.activeLease.expiresIso))}` : "none"}</dd>
          </div>
          <div>
            <dt className="inline text-ink-3">Last sync from this device: </dt>
            <dd className="inline">{off.lastSyncIso ? formatDateTime(new Date(off.lastSyncIso)) : "never"}</dd>
          </div>
        </dl>
        {off.deviceApproved && session.role === "RESPIRATORY_THERAPIST" ? (
          <p className="mt-3 text-[13px]">
            <a href="/offline-capture.html" className="font-semibold text-accent-ink hover:underline">
              Open offline capture →
            </a>{" "}
            <span className="text-ink-2">
              Prepare it while online; keep the tab open. Entries are encrypted on the device and sent when PUIMS is reachable.
            </span>
          </p>
        ) : (
          <p className="mt-3 text-[12px] text-ink-2">
            {session.role === "CHIEF_RT_ADMIN"
              ? "Approve individual RT devices below."
              : "Ask the Chief RT to approve this device if offline capture is needed."}{" "}
            A revoked device cannot be wiped remotely; its lease and key are refused by the server from then on.
          </p>
        )}
      </Card>

      <Card className="mb-4" aria-labelledby="rev-h">
        <CardHeader
          id="rev-h"
          title={`Sync review${review.length ? ` (${review.length})` : ""}`}
          subtitle="Offline entries the server did not apply automatically: clock differences, entries outside the lease, or a clash with what is already documented. Nothing is overwritten or dropped."
        />
        <SyncReview items={review} myStaffId={session.staffId} />
      </Card>
    </>
  );
}

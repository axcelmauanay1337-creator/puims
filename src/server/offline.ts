import "server-only";
import { randomBytes } from "node:crypto";
import { roleHas } from "@/lib/authz/permissions";
import { decryptSecret, encryptSecret } from "@/lib/auth/tokens";
import { formatDateTime, HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";
import { hasRecentReauth } from "./auth/service";
import { ClinicalError } from "./clinical";
import { getNow } from "./clock";
import { audit, tx, type Tx } from "./db";
import { documentNebulization, documentTubing, type NebDocInput, type TubingInput } from "./documentation";
import { nebRows } from "./nebulization";
import type { Session } from "./session";

/**
 * Milestone 7 — offline capture (interim policy, U-03 open). See docs/OFFLINE_BEHAVIOR_MATRIX.md.
 *
 *  1. The Chief RT approves a specific device (step-up). Default: no device is approved.
 *  2. An RT on that device, while online and signed in, takes a lease (≤ 12 h, never past the session):
 *     a random AES-256 key + a minimal worklist snapshot. The key is stored here encrypted with
 *     PUIMS_DATA_KEY; the browser keeps it in memory only.
 *  3. Offline, entries are sealed with the key into IndexedDB. After going online they are synced:
 *     every entry is recorded in sync_event with an outcome. Clock skew, an expired lease or a clash
 *     with what is already documented becomes a CONFLICT for a person to resolve — never a silent drop,
 *     never last-write-wins.
 */

export const LEASE_HOURS = 12;
export const KEY_RECOVERY_DAYS = 7;
export const MAX_SKEW_MS = 5 * 60_000;
export const MAX_EVENTS_PER_SYNC = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function as<T>(s: Session, fn: (c: Tx) => Promise<T>): Promise<T> {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, fn);
}

// ================================================================= device approval (Chief RT)

export async function setDeviceOffline(s: Session, deviceId: string, approve: boolean): Promise<void> {
  if (s.role !== "CHIEF_RT_ADMIN") throw new ClinicalError("FORBIDDEN", "Only the Chief RT can approve devices for offline use.");
  // Interlock: in hospital deployment profiles offline capture stays off until U-03 is formally approved.
  const profile = process.env.PUIMS_DEPLOYMENT_PROFILE ?? "development";
  if (approve && (profile === "lan" || profile === "cloud") && process.env.PUIMS_OFFLINE_POLICY_APPROVED !== "true")
    throw new ClinicalError("FORBIDDEN", "Offline capture is disabled in this deployment until hospital IT and the DPO approve it (U-03).");
  if (approve && !hasRecentReauth(s)) throw new ClinicalError("REAUTH_REQUIRED", "Confirm your password and authenticator code to approve offline use.");
  if (!UUID_RE.test(deviceId)) throw new ClinicalError("NOT_FOUND", "Device not found.");
  await as(s, async (c) => {
    const r = approve
      ? await c.query(
          "UPDATE device SET offline_phi_allowed = true, offline_approved_at = now(), offline_approved_by = $2 WHERE id = $1 AND status = 'ACTIVE' AND NOT offline_phi_allowed",
          [deviceId, s.staffId],
        )
      : await c.query("UPDATE device SET offline_phi_allowed = false WHERE id = $1 AND offline_phi_allowed", [deviceId]);
    if (!r.rowCount)
      throw new ClinicalError("CONFLICT", approve ? "Device not found, revoked, or already approved." : "Device is not approved for offline use.");
    await audit(c, approve ? "device.offline_approved" : "device.offline_withdrawn", undefined, { table: "device", id: deviceId });
  });
}

// ================================================================= lease + snapshot

export interface OfflineSnapshot {
  takenIso: string;
  nebSlots: Array<{ orderId: string; scheduledIso: string; patient: string; hospitalId: string; ward: string | null; medication: string; frequency: string }>;
  encounters: Array<{ encounterId: string; patient: string; hospitalId: string; ward: string; ventilatorRef: string; lastReplacementIso: string | null }>;
}

async function snapshot(c: Tx, now: Date, until: Date): Promise<OfflineSnapshot> {
  // Minimal scope: still-undocumented expected doses from 2 h ago to lease expiry, and active ventilator encounters.
  const rows = await nebRows(c, { start: new Date(now.getTime() - 2 * 3_600_000), end: until }, now);
  const e = await c.query<{ id: string; full_name: string; hid: string | null; ward_room: string; ventilator_ref: string; last: Date | null }>(
    `SELECT e.id, p.full_name, p.hospital_patient_id AS hid, e.ward_room, e.ventilator_ref,
            (SELECT max(t.installed_at) FROM tubing_event t WHERE t.encounter_id = e.id AND t.voided_at IS NULL) AS last
       FROM vent_encounter e JOIN patient p ON p.id = e.patient_id WHERE e.disconnected_at IS NULL ORDER BY e.ward_room`,
  );
  return {
    takenIso: now.toISOString(),
    nebSlots: rows
      .filter((r) => !r.documented && r.scheduledIso)
      .map((r) => ({
        orderId: r.orderId,
        scheduledIso: r.scheduledIso!,
        patient: r.patient.name,
        hospitalId: r.patient.hospitalId,
        ward: r.patient.wardRoom,
        medication: r.medication,
        frequency: r.frequency,
      })),
    encounters: e.rows.map((x) => ({
      encounterId: x.id,
      patient: x.full_name,
      hospitalId: x.hid ?? "No hospital no.",
      ward: x.ward_room,
      ventilatorRef: x.ventilator_ref,
      lastReplacementIso: x.last ? new Date(x.last).toISOString() : null,
    })),
  };
}

export interface LeaseGrant {
  leaseId: string;
  key: string; // base64, 32 bytes — memory only on the device
  issuedIso: string;
  expiresIso: string;
  staff: string;
  snapshot: OfflineSnapshot;
}

export async function issueLease(s: Session): Promise<LeaseGrant> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  const now = getNow();
  return as(s, async (c) => {
    const d = await c.query<{ offline_phi_allowed: boolean; status: string }>("SELECT offline_phi_allowed, status FROM device WHERE id = $1", [s.deviceId]);
    if (!d.rows[0]?.offline_phi_allowed || d.rows[0].status !== "ACTIVE")
      throw new ClinicalError("FORBIDDEN", "This device is not approved for offline use. Ask the Chief RT (Devices & Sync).");
    const sess = await c.query<{ absolute_expires_at: Date }>("SELECT absolute_expires_at FROM auth_session WHERE id = $1", [s.sessionId]);
    const until = new Date(Math.min(now.getTime() + LEASE_HOURS * 3_600_000, new Date(sess.rows[0].absolute_expires_at).getTime()));
    if (until.getTime() - now.getTime() < 15 * 60_000)
      throw new ClinicalError("CONFLICT", "Your session ends soon. Sign out and in again before preparing offline use.");
    await c.query(
      "UPDATE offline_lease SET revoked_at = now(), revoked_reason = 'replaced by a new lease' WHERE staff_id = $1 AND device_id = $2 AND revoked_at IS NULL",
      [s.staffId, s.deviceId],
    );
    const key = randomBytes(32).toString("base64");
    const r = await c.query<{ id: string; issued_at: Date }>(
      "INSERT INTO offline_lease (staff_id, device_id, session_id, key_enc, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, issued_at",
      [s.staffId, s.deviceId, s.sessionId, encryptSecret(key), until],
    );
    const snap = await snapshot(c, now, until);
    await audit(
      c,
      "offline.lease_issued",
      { neb_slots: snap.nebSlots.length, encounters: snap.encounters.length, expires_at: until.toISOString() },
      { table: "offline_lease", id: r.rows[0].id },
    );
    return {
      leaseId: r.rows[0].id,
      key,
      issuedIso: new Date(r.rows[0].issued_at).toISOString(),
      expiresIso: until.toISOString(),
      staff: s.displayName,
      snapshot: snap,
    };
  });
}

/** Re-releases a lease key to its holder (same staff + device, valid session) so a reloaded page can open its queue. */
export async function leaseKey(s: Session, leaseId: string): Promise<{ key: string; expiresIso: string; revoked: boolean }> {
  if (!UUID_RE.test(leaseId)) throw new ClinicalError("NOT_FOUND", "Lease not found.");
  return as(s, async (c) => {
    const r = await c.query<{ key_enc: string; staff_id: string; device_id: string; expires_at: Date; revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT key_enc, staff_id, device_id, expires_at, revoked_at, revoked_reason FROM offline_lease WHERE id = $1",
      [leaseId],
    );
    const l = r.rows[0];
    if (!l || l.staff_id !== s.staffId || l.device_id !== s.deviceId) throw new ClinicalError("NOT_FOUND", "Lease not found.");
    // A key revoked because of a device revocation or withdrawn approval is never released again.
    if (l.revoked_at && l.revoked_reason !== "replaced by a new lease")
      throw new ClinicalError("FORBIDDEN", `This device's offline lease was revoked (${l.revoked_reason}).`);
    if (getNow().getTime() > new Date(l.expires_at).getTime() + KEY_RECOVERY_DAYS * 86_400_000)
      throw new ClinicalError("FORBIDDEN", "This lease is too old to recover.");
    await audit(c, "offline.lease_key_released", undefined, { table: "offline_lease", id: leaseId });
    return { key: decryptSecret(l.key_enc), expiresIso: new Date(l.expires_at).toISOString(), revoked: !!l.revoked_at };
  });
}

// ================================================================= sync

export type SyncKind = "NEB_DOSE" | "TUBING_REPLACEMENT";
export interface SyncEntry {
  id: string;
  kind: SyncKind;
  recordedAtDevice: string;
  payload: Record<string, unknown>;
}
export interface SyncResult {
  id: string;
  outcome: "ACCEPTED" | "DUPLICATE" | "CONFLICT" | "REJECTED";
  message: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function apply(s: Session, e: SyncEntry): Promise<{ recordId: string; duplicate: boolean }> {
  if (e.kind === "NEB_DOSE") {
    const input: NebDocInput = {
      clientId: e.id,
      orderId: str(e.payload.orderId),
      scheduledAt: e.payload.scheduledAt ? str(e.payload.scheduledAt) : null,
      status: str(e.payload.status),
      actualAt: str(e.payload.actualAt),
      reason: str(e.payload.reason),
      recordedAtDevice: e.recordedAtDevice,
    };
    const r = await documentNebulization(s, input, "OFFLINE_SYNC");
    return { recordId: r.id, duplicate: r.duplicate };
  }
  const input: TubingInput = {
    clientId: e.id,
    encounterId: str(e.payload.encounterId),
    installedAt: str(e.payload.installedAt),
    reason: str(e.payload.reason),
    recordedAtDevice: e.recordedAtDevice,
  };
  const r = await documentTubing(s, input, "OFFLINE_SYNC");
  return { recordId: r.id, duplicate: r.duplicate };
}

/**
 * Synchronizes queued entries. Idempotent: an entry id already received returns its recorded outcome.
 * `deviceNowIso` is the device clock at send time, used only to detect skew (clinical times are never shifted).
 */
export async function syncEntries(
  s: Session,
  leaseId: string,
  deviceNowIso: string,
  entries: SyncEntry[],
): Promise<{ results: SyncResult[]; serverIso: string; skewMs: number }> {
  if (!roleHas(s.role, "clinical:document")) throw new ClinicalError("FORBIDDEN", "Not permitted.");
  if (!Array.isArray(entries) || entries.length > MAX_EVENTS_PER_SYNC)
    throw new ClinicalError("INVALID", `Send at most ${MAX_EVENTS_PER_SYNC} entries at a time.`);
  const now = getNow();
  const deviceNow = new Date(deviceNowIso);
  if (Number.isNaN(deviceNow.getTime())) throw new ClinicalError("INVALID", "Missing device time.");
  const skewMs = now.getTime() - deviceNow.getTime();
  const lease = await as(s, async (c) => {
    const r = await c.query<{ staff_id: string; device_id: string; expires_at: Date; issued_at: Date; revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT staff_id, device_id, expires_at, issued_at, revoked_at, revoked_reason FROM offline_lease WHERE id = $1",
      [leaseId],
    );
    return r.rows[0];
  });
  if (!lease || lease.staff_id !== s.staffId || lease.device_id !== s.deviceId)
    throw new ClinicalError("FORBIDDEN", "This offline lease does not belong to you on this device.");
  if (lease.revoked_at && lease.revoked_reason !== "replaced by a new lease")
    throw new ClinicalError("FORBIDDEN", `Offline lease revoked (${lease.revoked_reason}). Document these entries on paper and tell the Chief RT.`);

  const results: SyncResult[] = [];
  for (const e of entries) {
    if (!e || !UUID_RE.test(e.id) || (e.kind !== "NEB_DOSE" && e.kind !== "TUBING_REPLACEMENT") || typeof e.payload !== "object" || e.payload === null) {
      results.push({ id: String(e?.id ?? ""), outcome: "REJECTED", message: "Malformed entry." });
      continue;
    }
    const prior = await as(s, (c) =>
      c.query<{ staff_id: string; outcome: SyncResult["outcome"]; message: string | null }>("SELECT staff_id, outcome, message FROM sync_event WHERE id = $1", [
        e.id,
      ]),
    );
    if (prior.rows[0]) {
      results.push(
        prior.rows[0].staff_id === s.staffId
          ? { id: e.id, outcome: prior.rows[0].outcome, message: prior.rows[0].message }
          : { id: e.id, outcome: "REJECTED", message: "Entry id already used." },
      );
      continue;
    }
    const recorded = new Date(e.recordedAtDevice);
    let outcome: SyncResult["outcome"];
    let message: string | null = null;
    let recordId: string | null = null;
    if (Number.isNaN(recorded.getTime())) {
      outcome = "REJECTED";
      message = "Missing capture time.";
    } else if (Math.abs(skewMs) > MAX_SKEW_MS) {
      outcome = "CONFLICT";
      message = `Device clock differed from the server by ${Math.round(skewMs / 60_000)} min — times need checking before this is applied.`;
    } else if (
      recorded.getTime() > new Date(lease.expires_at).getTime() + MAX_SKEW_MS ||
      recorded.getTime() < new Date(lease.issued_at).getTime() - MAX_SKEW_MS
    ) {
      outcome = "CONFLICT";
      message = "Captured outside the offline lease period — needs review before it is applied.";
    } else {
      try {
        const r = await apply(s, e);
        outcome = r.duplicate ? "DUPLICATE" : "ACCEPTED";
        recordId = r.recordId;
      } catch (err) {
        if (err instanceof ClinicalError) {
          outcome = err.kind === "CONFLICT" ? "CONFLICT" : "REJECTED";
          message = err.message.slice(0, 400);
        } else throw err;
      }
    }
    await as(s, async (c) => {
      await c.query(
        `INSERT INTO sync_event (id, lease_id, staff_id, device_id, kind, payload, recorded_at_device, clock_skew_ms, outcome, message, record_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
        [
          e.id,
          leaseId,
          s.staffId,
          s.deviceId,
          e.kind,
          JSON.stringify(e.payload),
          Number.isNaN(recorded.getTime()) ? null : recorded,
          Math.max(-2e9, Math.min(2e9, skewMs)),
          outcome,
          message,
          recordId,
        ],
      );
    });
    results.push({ id: e.id, outcome, message });
  }
  await as(s, (c) =>
    audit(
      c,
      "offline.synced",
      {
        entries: entries.length,
        conflicts: results.filter((r) => r.outcome === "CONFLICT").length,
        rejected: results.filter((r) => r.outcome === "REJECTED").length,
        skew_ms: skewMs,
      },
      { table: "offline_lease", id: leaseId },
    ),
  );
  return { results, serverIso: now.toISOString(), skewMs };
}

// ================================================================= review

export interface SyncReviewItem {
  id: string;
  kind: SyncKind;
  staff: string;
  staffId: string;
  receivedIso: string;
  recordedIso: string | null;
  skewMs: number | null;
  outcome: string;
  message: string | null;
  summary: string;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
}

function manilaWall(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return formatDateTime(t);
}

export async function listSyncReview(s: Session, includeResolved = false): Promise<SyncReviewItem[]> {
  return as(s, async (c) => {
    const r = await c.query<{
      id: string;
      kind: SyncKind;
      staff_id: string;
      staff: string;
      received_at: Date;
      recorded_at_device: Date | null;
      clock_skew_ms: number | null;
      outcome: string;
      message: string | null;
      payload: Record<string, string>;
      resolution: string | null;
      resolution_note: string | null;
      resolver: string | null;
      patient: string | null;
    }>(
      `SELECT e.id, e.kind, e.staff_id, st.display_name AS staff, e.received_at, e.recorded_at_device, e.clock_skew_ms, e.outcome, e.message, e.payload,
              e.resolution, e.resolution_note, rs.display_name AS resolver,
              coalesce((SELECT p.full_name FROM neb_order o JOIN patient p ON p.id = o.patient_id WHERE e.kind = 'NEB_DOSE' AND o.id::text = e.payload ->> 'orderId'),
                       (SELECT p.full_name FROM vent_encounter v JOIN patient p ON p.id = v.patient_id WHERE e.kind = 'TUBING_REPLACEMENT' AND v.id::text = e.payload ->> 'encounterId')) AS patient
         FROM sync_event e JOIN staff st ON st.id = e.staff_id LEFT JOIN staff rs ON rs.id = e.resolved_by
        WHERE e.outcome IN ('CONFLICT', 'REJECTED') AND ($1 OR e.resolved_at IS NULL)
        ORDER BY e.received_at DESC LIMIT 200`,
      [includeResolved],
    );
    return r.rows.map((x) => ({
      id: x.id,
      kind: x.kind,
      staff: x.staff,
      staffId: x.staff_id,
      receivedIso: new Date(x.received_at).toISOString(),
      recordedIso: x.recorded_at_device ? new Date(x.recorded_at_device).toISOString() : null,
      skewMs: x.clock_skew_ms,
      outcome: x.outcome,
      message: x.message,
      summary:
        x.kind === "NEB_DOSE"
          ? `${x.patient ?? "Unknown order"} · nebulization ${x.payload.status ?? "?"}${x.payload.scheduledAt ? ` · dose due ${manilaWall(x.payload.scheduledAt)}` : ""}${x.payload.actualAt ? ` · at ${x.payload.actualAt.replace("T", " ")}` : ""}${x.payload.reason ? ` · “${x.payload.reason}”` : ""}`
          : `${x.patient ?? "Unknown encounter"} · tubing replaced at ${(x.payload.installedAt ?? "?").replace("T", " ")}${x.payload.reason ? ` · “${x.payload.reason}”` : ""}`,
      resolution: x.resolution,
      resolutionNote: x.resolution_note,
      resolvedBy: x.resolver,
    }));
  });
}

/** Resolve a conflict: apply it now (as a late, online entry in the author's name) or record why it is not applied. */
export async function resolveSyncEvent(s: Session, id: string, resolution: "APPLIED" | "NOT_APPLIED", note: string): Promise<void> {
  const why = note.trim().replace(/\s+/g, " ");
  if (resolution === "NOT_APPLIED" && (why.length < 5 || why.length > 300)) throw new ClinicalError("INVALID", "Say why it is not applied (5–300 characters).");
  const ev = await as(s, async (c) => {
    const r = await c.query<{
      staff_id: string;
      kind: SyncKind;
      payload: Record<string, unknown>;
      recorded_at_device: Date | null;
      outcome: string;
      resolved_at: Date | null;
    }>("SELECT staff_id, kind, payload, recorded_at_device, outcome, resolved_at FROM sync_event WHERE id = $1", [id]);
    return r.rows[0];
  });
  if (!ev || ev.resolved_at || !["CONFLICT", "REJECTED"].includes(ev.outcome)) throw new ClinicalError("NOT_FOUND", "Open conflict not found.");
  if (ev.staff_id !== s.staffId && s.role !== "CHIEF_RT_ADMIN")
    throw new ClinicalError("FORBIDDEN", "Only the RT who captured it or the Chief RT can resolve this.");
  let recordId: string | null = null;
  if (resolution === "APPLIED") {
    // Only the author can apply: documentation is always in the documenting RT's own name.
    if (ev.staff_id !== s.staffId) throw new ClinicalError("FORBIDDEN", "Only the RT who captured the entry can apply it (documentation is in their name).");
    const r = await apply(s, {
      id,
      kind: ev.kind,
      payload: ev.payload,
      recordedAtDevice: ev.recorded_at_device ? new Date(ev.recorded_at_device).toISOString() : getNow().toISOString(),
    });
    recordId = r.recordId;
  }
  await as(s, async (c) => {
    await c.query(
      "UPDATE sync_event SET resolved_at = now(), resolved_by = $2, resolution = $3, resolution_note = $4, record_id = coalesce($5, record_id) WHERE id = $1",
      [id, s.staffId, resolution, why || null, recordId],
    );
    await audit(c, "offline.conflict_resolved", { resolution }, { table: "sync_event", id });
  });
}

export async function offlineStatus(s: Session) {
  return as(s, async (c) => {
    const d = await c.query<{ offline_phi_allowed: boolean; offline_approved_at: Date | null }>(
      "SELECT offline_phi_allowed, offline_approved_at FROM device WHERE id = $1",
      [s.deviceId],
    );
    const l = await c.query<{ id: string; expires_at: Date }>(
      "SELECT id, expires_at FROM offline_lease WHERE staff_id = $1 AND device_id = $2 AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at DESC LIMIT 1",
      [s.staffId, s.deviceId],
    );
    const open = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM sync_event WHERE outcome IN ('CONFLICT', 'REJECTED') AND resolved_at IS NULL");
    const last = await c.query<{ at: Date | null }>("SELECT max(received_at) AS at FROM sync_event WHERE staff_id = $1 AND device_id = $2", [
      s.staffId,
      s.deviceId,
    ]);
    return {
      deviceApproved: !!d.rows[0]?.offline_phi_allowed,
      approvedIso: d.rows[0]?.offline_approved_at ? new Date(d.rows[0].offline_approved_at).toISOString() : null,
      activeLease: l.rows[0] ? { id: l.rows[0].id, expiresIso: new Date(l.rows[0].expires_at).toISOString() } : null,
      openConflicts: open.rows[0].n,
      lastSyncIso: last.rows[0].at ? new Date(last.rows[0].at).toISOString() : null,
    };
  });
}

/** Manila wall clock "YYYY-MM-DDTHH:MM" (shared helper for tests). */
export function wallOf(d: Date): string {
  const p = toLocalParts(d, HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

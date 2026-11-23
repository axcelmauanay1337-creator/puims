import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyInstant, operationalDayWindow } from "@/lib/time/shifts";
import { getPool, tx } from "@/server/db";
import { enterNebOrder } from "@/server/documentation";
import { nebRows } from "@/server/nebulization";
import { issueLease, leaseKey, listSyncReview, resolveSyncEvent, setDeviceOffline, syncEntries, wallOf } from "@/server/offline";
import type { Session } from "@/server/session";
import { makeSession, owner, reseed } from "./helpers";

let o: pg.Client;
async function sessionFor(username: string, reauth = false, deviceId?: string): Promise<Session> {
  const st = (await o.query("SELECT id, role, display_name FROM staff WHERE username = $1", [username])).rows[0];
  const ids = await makeSession(o, st.id);
  if (deviceId) {
    await o.query("UPDATE auth_session SET device_id = $2 WHERE id = $1", [ids.sessionId, deviceId]);
    ids.deviceId = deviceId;
  }
  return {
    ...ids,
    userId: st.id,
    role: st.role,
    username,
    displayName: st.display_name,
    initials: "XX",
    reauthAt: reauth ? new Date() : null,
    idleExpiresAt: new Date(Date.now() + 900_000),
  };
}

let rt: Session;
let orderId: string;
let encounterId: string;
let leaseId: string;
const ago = (m: number) => new Date(Date.now() - m * 60_000);

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
  rt = await sessionFor("rt.alpha");
  const p = (await o.query("INSERT INTO patient (full_name, category, ward_room) VALUES ('Offline, Seven Synthetic', 'INP', 'ICU-7') RETURNING id")).rows[0].id;
  orderId = randomUUID();
  await enterNebOrder(rt, {
    clientId: orderId,
    patientId: p,
    orderReference: "SYN-M7",
    prescriber: "Dr. Demo M7",
    medicationAsOrdered: "Synthetic medication as written",
    frequency: "ONCE",
    prescribedTimes: wallOf(ago(30)).slice(11),
    startAt: wallOf(ago(120)),
    endAt: "",
  });
  encounterId = (
    await o.query(
      "INSERT INTO vent_encounter (patient_id, ventilator_ref, ward_room, hooked_at, responsible_staff_id) VALUES ($1, 'SYN-VENT-7', 'ICU-7', $2, $3) RETURNING id",
      [p, ago(600), rt.staffId],
    )
  ).rows[0].id;
}, 120_000);
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("offline approval and leases", () => {
  it("no device can take a lease until the Chief RT approves it (with step-up)", async () => {
    await expect(issueLease(rt)).rejects.toThrow(/not approved/);
    await expect(setDeviceOffline(await sessionFor("rt.bravo", true), rt.deviceId, true)).rejects.toThrow(/Chief RT/);
    await expect(setDeviceOffline(await sessionFor("chief.demo"), rt.deviceId, true)).rejects.toMatchObject({ kind: "REAUTH_REQUIRED" });
    // Interlock: a hospital deployment profile refuses approval until U-03 is signed off.
    const prev = process.env.PUIMS_DEPLOYMENT_PROFILE;
    process.env.PUIMS_DEPLOYMENT_PROFILE = "lan";
    await expect(setDeviceOffline(await sessionFor("chief.demo", true), rt.deviceId, true)).rejects.toThrow(/U-03/);
    process.env.PUIMS_DEPLOYMENT_PROFILE = prev;
    await setDeviceOffline(await sessionFor("chief.demo", true), rt.deviceId, true);
    const g = await issueLease(rt);
    leaseId = g.leaseId;
    expect(Buffer.from(g.key, "base64")).toHaveLength(32);
    expect(new Date(g.expiresIso).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3_600_000 + 1000);
    expect(g.snapshot.nebSlots.some((x) => x.orderId === orderId)).toBe(true);
    expect(g.snapshot.encounters.some((x) => x.encounterId === encounterId)).toBe(true);
    const stored = (await o.query("SELECT key_enc FROM offline_lease WHERE id = $1", [leaseId])).rows[0].key_enc;
    expect(stored).not.toContain(g.key);
    const audit = JSON.stringify((await o.query("SELECT before_data, after_data FROM audit_log WHERE table_name = 'offline_lease'")).rows);
    expect(audit).not.toContain("key_enc");
    expect((await leaseKey(rt, leaseId)).key).toBe(g.key);
    await expect(leaseKey(await sessionFor("rt.bravo", false, rt.deviceId), leaseId)).rejects.toThrow(/not found/);
  });
});

describe("sync", () => {
  const doseId = randomUUID();
  const tubeId = randomUUID();

  it("applies entries idempotently and records every outcome", async () => {
    const slot = (
      await tx({ staffId: rt.staffId, sessionId: rt.sessionId, deviceId: rt.deviceId }, (c) =>
        nebRows(c, operationalDayWindow(classifyInstant(new Date()).operationalDate), new Date()),
      )
    ).find((r) => r.orderId === orderId)!;
    const entries = [
      {
        id: doseId,
        kind: "NEB_DOSE" as const,
        recordedAtDevice: new Date().toISOString(),
        payload: { orderId, scheduledAt: slot.scheduledIso, status: "COMPLETED", actualAt: wallOf(ago(20)), reason: "" },
      },
      {
        id: tubeId,
        kind: "TUBING_REPLACEMENT" as const,
        recordedAtDevice: new Date().toISOString(),
        payload: { encounterId, installedAt: wallOf(ago(10)), reason: "Routine (synthetic)" },
      },
      {
        id: randomUUID(),
        kind: "NEB_DOSE" as const,
        recordedAtDevice: new Date().toISOString(),
        payload: { orderId, scheduledAt: null, status: "BOGUS", actualAt: "", reason: "" },
      },
    ];
    const r1 = await syncEntries(rt, leaseId, new Date().toISOString(), entries);
    expect(r1.results.map((r) => r.outcome)).toEqual(["ACCEPTED", "ACCEPTED", "REJECTED"]);
    const src = (await o.query("SELECT source FROM neb_administration WHERE id = $1", [doseId])).rows[0].source;
    expect(src).toBe("OFFLINE_SYNC");
    // Retrying the same batch (e.g. the response was lost) changes nothing.
    const r2 = await syncEntries(rt, leaseId, new Date().toISOString(), entries);
    expect(r2.results.map((r) => r.outcome)).toEqual(["ACCEPTED", "ACCEPTED", "REJECTED"]);
    expect(Number((await o.query("SELECT count(*) FROM neb_administration WHERE id = $1", [doseId])).rows[0].count)).toBe(1);
  });

  it("never overwrites: a dose documented elsewhere becomes a conflict for review", async () => {
    const other = randomUUID();
    const slotIso = (await o.query("SELECT scheduled_at FROM neb_administration WHERE id = $1", [doseId])).rows[0].scheduled_at.toISOString();
    const r = await syncEntries(rt, leaseId, new Date().toISOString(), [
      {
        id: other,
        kind: "NEB_DOSE",
        recordedAtDevice: new Date().toISOString(),
        payload: { orderId, scheduledAt: slotIso, status: "REFUSED", actualAt: "", reason: "Patient refused (synthetic)" },
      },
    ]);
    expect(r.results[0].outcome).toBe("CONFLICT");
    const review = await listSyncReview(rt);
    expect(review.find((x) => x.id === other)?.summary).toContain("Offline, Seven Synthetic");
    await expect(resolveSyncEvent(rt, other, "NOT_APPLIED", "no")).rejects.toThrow(/why/);
    await resolveSyncEvent(rt, other, "NOT_APPLIED", "Already documented as given by the same RT");
    expect((await listSyncReview(rt)).find((x) => x.id === other)).toBeUndefined();
  });

  it("flags device clock skew instead of applying, and the author can apply after checking", async () => {
    const id = randomUUID();
    const r = await syncEntries(rt, leaseId, new Date(Date.now() - 20 * 60_000).toISOString(), [
      {
        id,
        kind: "TUBING_REPLACEMENT",
        recordedAtDevice: new Date().toISOString(),
        payload: { encounterId, installedAt: wallOf(ago(5)), reason: "Circuit soiled (synthetic)" },
      },
    ]);
    expect(r.results[0]).toMatchObject({ outcome: "CONFLICT" });
    expect(r.results[0].message).toMatch(/clock/);
    await expect(resolveSyncEvent(await sessionFor("chief.demo"), id, "APPLIED", "")).rejects.toThrow(/Only the RT who captured/);
    await resolveSyncEvent(rt, id, "APPLIED", "Times checked against the paper chart");
    expect((await o.query("SELECT source FROM tubing_event WHERE id = $1", [id])).rows[0].source).toBe("OFFLINE_SYNC");
  });

  it("a revoked device can neither sync nor recover its key", async () => {
    const chief = await sessionFor("chief.demo", true);
    await o.query("UPDATE device SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'lost (test)' WHERE id = $1", [rt.deviceId]);
    const l = (await o.query("SELECT revoked_reason FROM offline_lease WHERE id = $1", [leaseId])).rows[0];
    expect(l.revoked_reason).toBe("device revoked");
    void chief;
    await expect(leaseKey(rt, leaseId)).rejects.toThrow();
    await expect(syncEntries(rt, leaseId, new Date().toISOString(), [])).rejects.toThrow();
  });
});

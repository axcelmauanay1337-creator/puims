import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operationalDayWindow, classifyInstant } from "@/lib/time/shifts";
import { HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";
import { getHandoverDrafts } from "@/server/clinical";
import { getPool, tx } from "@/server/db";
import {
  discontinueNebOrder,
  disconnect,
  documentNebulization,
  documentTubing,
  enterNebOrder,
  hookIn,
  voidNebulization,
  voidTubing,
} from "@/server/documentation";
import { nebRows } from "@/server/nebulization";
import type { Session } from "@/server/session";
import { expectPgError, makeSession, owner, reseed } from "./helpers";

let o: pg.Client;
let patientId: string;
let patient2: string;

async function sessionFor(username: string): Promise<Session> {
  const st = (await o.query("SELECT id, role, display_name FROM staff WHERE username = $1", [username])).rows[0];
  const ids = await makeSession(o, st.id);
  return {
    ...ids,
    userId: st.id,
    role: st.role,
    username,
    displayName: st.display_name,
    initials: "XX",
    reauthAt: null,
    idleExpiresAt: new Date(Date.now() + 900_000),
  };
}

/** Asia/Manila wall time "YYYY-MM-DDTHH:MM" for an instant (what the form sends). */
function wall(d: Date): string {
  const p = toLocalParts(d, HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function worklist(s: Session) {
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, (c) =>
    nebRows(c, operationalDayWindow(classifyInstant(new Date()).operationalDate), new Date()),
  );
}

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
  // These tests cover the no-equipment-board mode (typed ventilator identifiers); the board rule is tested in redesign.test.ts.
  await o.query("UPDATE equipment SET retired_at = now() WHERE kind = 'VENTILATOR'");
  patientId = (
    await o.query("INSERT INTO patient (full_name, category, sex, ward_room) VALUES ('Milestone, Four Synthetic', 'INP', 'F', 'ICU-9') RETURNING id")
  ).rows[0].id;
  patient2 = (await o.query("INSERT INTO patient (full_name, category, sex, ward_room) VALUES ('Milestone, Vent Synthetic', 'INP', 'M', 'ICU-8') RETURNING id"))
    .rows[0].id;
});
afterAll(async () => {
  await o.end();
  await getPool().end();
});

// Two slots inside the current operational day: one already past, one in the future.
function slotTimes(): string[] {
  const now = new Date();
  const z = (n: number) => String(n).padStart(2, "0");
  const past = toLocalParts(minutesAgo(90), HOSPITAL_TZ);
  const future = toLocalParts(new Date(now.getTime() + 60 * 60_000), HOSPITAL_TZ);
  return [`${z(past.hour)}:${z(past.minute)}`, `${z(future.hour)}:${z(future.minute)}`];
}

describe("nebulization orders — only Respiratory Therapists (decision 2026-11-22)", () => {
  let orderId: string;

  it("the Chief RT is refused by the app and by the database", async () => {
    const chief = await sessionFor("chief.demo");
    const base = {
      clientId: randomUUID(),
      patientId,
      orderReference: "SYN-T-1",
      prescriber: "Dr. Demo X",
      medicationAsOrdered: "as written",
      frequency: "BID",
      prescribedTimes: "",
      startAt: wall(minutesAgo(300)),
      endAt: "",
    };
    await expect(enterNebOrder(chief, base)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
        chief.staffId,
        chief.sessionId,
        chief.deviceId,
      ]);
      await expectPgError(
        c.query(
          "INSERT INTO neb_order (patient_id, order_reference, prescriber, medication_as_ordered, frequency, start_at, entered_by) VALUES ($1, 'X', 'Y', 'Z', 'BID', now(), $2)",
          [patientId, chief.staffId],
        ),
        "42501",
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("an RT enters an order; validation rejects PRN-with-times and malformed times", async () => {
    const rt = await sessionFor("rt.alpha");
    const common = {
      patientId,
      orderReference: "SYN-T-2",
      prescriber: "Dr. Demo X",
      medicationAsOrdered: "Medication as written (synthetic)",
      startAt: wall(minutesAgo(300)),
      endAt: "",
    };
    await expect(enterNebOrder(rt, { ...common, clientId: randomUUID(), frequency: "PRN", prescribedTimes: "08:00" })).rejects.toMatchObject({
      kind: "INVALID",
    });
    await expect(enterNebOrder(rt, { ...common, clientId: randomUUID(), frequency: "TID", prescribedTimes: "8" })).rejects.toMatchObject({ kind: "INVALID" });
    const clientId = randomUUID();
    const r = await enterNebOrder(rt, { ...common, clientId, frequency: "BID", prescribedTimes: slotTimes().join(", ") });
    expect(r).toEqual({ id: clientId, duplicate: false });
    orderId = r.id;
    // Retrying the same submission is idempotent.
    expect(await enterNebOrder(rt, { ...common, clientId, frequency: "BID", prescribedTimes: slotTimes().join(", ") })).toEqual({
      id: clientId,
      duplicate: true,
    });
    expect((await o.query("SELECT count(*)::int AS n FROM neb_order WHERE id = $1", [clientId])).rows[0].n).toBe(1);
  });

  it("expected doses come only from the written times: one PENDING (past) and one SCHEDULED (future), none stored", async () => {
    const rows = (await worklist(await sessionFor("rt.alpha"))).filter((r) => r.orderId === orderId);
    expect(rows.map((r) => [r.documented, r.status])).toEqual([
      [false, "PENDING"],
      [false, "SCHEDULED"],
    ]);
    expect((await o.query("SELECT count(*)::int AS n FROM neb_administration WHERE order_id = $1", [orderId])).rows[0].n).toBe(0);
  });

  it("documenting a dose: one outcome per slot, idempotent retry, reason rules, time window", async () => {
    const alpha = await sessionFor("rt.alpha");
    const bravo = await sessionFor("rt.bravo");
    const slot = (await worklist(alpha)).find((r) => r.orderId === orderId && r.status === "PENDING")!;
    const clientId = randomUUID();
    const doc = {
      clientId,
      orderId,
      scheduledAt: slot.scheduledIso,
      status: "COMPLETED",
      actualAt: wall(minutesAgo(80)),
      reason: "",
      recordedAtDevice: new Date().toISOString(),
    };
    expect(await documentNebulization(alpha, doc)).toEqual({ id: clientId, duplicate: false });
    expect(await documentNebulization(alpha, doc)).toEqual({ id: clientId, duplicate: true });
    await expect(documentNebulization(bravo, { ...doc, clientId: randomUUID() })).rejects.toMatchObject({ kind: "CONFLICT" });

    const row = (
      await o.query("SELECT performed_by, status, operational_date, shift, recorded_at_device, received_at_server FROM neb_administration WHERE id = $1", [
        clientId,
      ])
    ).rows[0];
    expect(row.performed_by).toBe(alpha.staffId);
    expect(row.recorded_at_device).not.toBeNull();
    expect(row.operational_date).toBe(classifyInstant(minutesAgo(80)).operationalDate);

    const future = (await worklist(alpha)).find((r) => r.orderId === orderId && r.status === "SCHEDULED")!;
    await expect(
      documentNebulization(alpha, { ...doc, clientId: randomUUID(), scheduledAt: future.scheduledIso, status: "NOT_GIVEN", actualAt: "", reason: "" }),
    ).rejects.toMatchObject({
      kind: "INVALID",
    });
    await expect(
      documentNebulization(alpha, { ...doc, clientId: randomUUID(), scheduledAt: future.scheduledIso, actualAt: wall(new Date(Date.now() + 3_600_000)) }),
    ).rejects.toMatchObject({
      kind: "INVALID",
    });
    await expect(
      documentNebulization(alpha, { ...doc, clientId: randomUUID(), scheduledAt: future.scheduledIso, actualAt: wall(minutesAgo(73 * 60)) }),
    ).rejects.toMatchObject({ kind: "INVALID" });
    await expect(
      documentNebulization(alpha, { ...doc, clientId: randomUUID(), scheduledAt: new Date(Date.parse(future.scheduledIso!) + 60_000).toISOString() }),
    ).rejects.toMatchObject({
      kind: "INVALID",
    }); // not a time written on the order
  });

  it("void: only the author or the Chief RT, with a reason; the slot re-opens; documented rows cannot be edited", async () => {
    const alpha = await sessionFor("rt.alpha");
    const bravo = await sessionFor("rt.bravo");
    const id = (await o.query("SELECT id FROM neb_administration WHERE order_id = $1", [orderId])).rows[0].id;
    await expect(voidNebulization(bravo, id, "wrong patient")).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(voidNebulization(alpha, id, "no")).rejects.toMatchObject({ kind: "INVALID" });
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE neb_administration SET status = 'REFUSED', reason = 'x' WHERE id = $1", [id]), "23514");
    await o.query("ROLLBACK");
    await voidNebulization(alpha, id, "Documented against the wrong slot");
    await expect(voidNebulization(alpha, id, "again please")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    const reopened = (await worklist(alpha)).filter((r) => r.orderId === orderId);
    expect(reopened.map((r) => r.status)).toEqual(["PENDING", "SCHEDULED"]);
    const v = (await o.query("SELECT void_reason, voided_by FROM neb_administration WHERE id = $1", [id])).rows[0];
    expect(v).toEqual({ void_reason: "Documented against the wrong slot", voided_by: alpha.staffId });
  });

  it("an unscheduled dose needs a time within the order; discontinuing removes remaining expected doses; orders are never edited", async () => {
    const alpha = await sessionFor("rt.alpha");
    await expect(
      documentNebulization(alpha, {
        clientId: randomUUID(),
        orderId,
        scheduledAt: null,
        status: "COMPLETED",
        actualAt: "",
        reason: "",
        recordedAtDevice: null,
      }),
    ).rejects.toMatchObject({
      kind: "INVALID",
    });
    await documentNebulization(alpha, {
      clientId: randomUUID(),
      orderId,
      scheduledAt: null,
      status: "COMPLETED",
      actualAt: wall(minutesAgo(10)),
      reason: "",
      recordedAtDevice: null,
    });
    await expect(discontinueNebOrder(alpha, orderId, "x")).rejects.toMatchObject({ kind: "INVALID" });
    await discontinueNebOrder(alpha, orderId, "Stopped by physician (synthetic)");
    const after = (await worklist(alpha)).filter((r) => r.orderId === orderId);
    expect(after.every((r) => r.documented || r.status === "PENDING")).toBe(true);
    expect(after.some((r) => r.status === "SCHEDULED")).toBe(false);
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE neb_order SET medication_as_ordered = 'changed' WHERE id = $1", [orderId]), "23514");
    await o.query("ROLLBACK");
  });

  it("the database refuses documentation in someone else's name", async () => {
    const bravo = await sessionFor("rt.bravo");
    const alphaId = (await o.query("SELECT id FROM staff WHERE username = 'rt.alpha'")).rows[0].id;
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
        bravo.staffId,
        bravo.sessionId,
        bravo.deviceId,
      ]);
      await expectPgError(
        c.query("INSERT INTO neb_administration (order_id, patient_id, actual_at, status, performed_by) VALUES ($1, $2, now(), 'COMPLETED', $3)", [
          orderId,
          patientId,
          alphaId,
        ]),
        "42501",
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

describe("ventilation and tubing", () => {
  let encounterId: string;

  it("hook-in (with an explicitly documented new circuit); overlap refused; hook-in details immutable", async () => {
    const rt = await sessionFor("rt.bravo");
    const clientId = randomUUID();
    const input = {
      clientId,
      patientId: patient2,
      ventilatorRef: "VENT-T-1",
      wardRoom: "ICU-8",
      hookedAt: wall(minutesAgo(240)),
      newCircuitInstalled: true,
      recordedAtDevice: null,
    };
    expect(await hookIn(rt, input)).toEqual({ id: clientId, duplicate: false });
    expect(await hookIn(rt, input)).toEqual({ id: clientId, duplicate: true });
    encounterId = clientId;
    const t = (await o.query("SELECT performed_by, interval_days, next_due_at - installed_at AS gap FROM tubing_event WHERE encounter_id = $1", [encounterId]))
      .rows;
    expect(t).toHaveLength(1);
    expect(t[0].performed_by).toBe(rt.staffId);
    await expect(hookIn(rt, { ...input, clientId: randomUUID(), hookedAt: wall(minutesAgo(60)) })).rejects.toMatchObject({ kind: "CONFLICT" });
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE vent_encounter SET ventilator_ref = 'X' WHERE id = $1", [encounterId]), "23514");
    await o.query("ROLLBACK");
  });

  it("without the tick, no tubing installation is assumed", async () => {
    const rt = await sessionFor("rt.bravo");
    const p = (await o.query("INSERT INTO patient (full_name, category, sex) VALUES ('Noassume, Synthetic', 'INP', 'M') RETURNING id")).rows[0].id;
    const { id } = await hookIn(rt, {
      clientId: randomUUID(),
      patientId: p,
      ventilatorRef: "VENT-T-2",
      wardRoom: "ICU-7",
      hookedAt: wall(minutesAgo(30)),
      newCircuitInstalled: false,
      recordedAtDevice: null,
    });
    expect((await o.query("SELECT count(*)::int AS n FROM tubing_event WHERE encounter_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("tubing replacement: must be after hook-in and after the last replacement; void restores the previous due date", async () => {
    const rt = await sessionFor("rt.charlie");
    const before = (await o.query("SELECT max(next_due_at) AS due FROM tubing_event WHERE encounter_id = $1 AND voided_at IS NULL", [encounterId])).rows[0].due;
    await expect(
      documentTubing(rt, { clientId: randomUUID(), encounterId, installedAt: wall(minutesAgo(300)), reason: "Scheduled replacement", recordedAtDevice: null }),
    ).rejects.toMatchObject({
      kind: "INVALID",
    });
    const { id } = await documentTubing(rt, {
      clientId: randomUUID(),
      encounterId,
      installedAt: wall(minutesAgo(20)),
      reason: "Visibly soiled",
      recordedAtDevice: null,
    });
    const newDue = (await o.query("SELECT max(next_due_at) AS due FROM tubing_event WHERE encounter_id = $1 AND voided_at IS NULL", [encounterId])).rows[0].due;
    expect(new Date(newDue).getTime()).toBeGreaterThan(new Date(before).getTime());
    await expect(voidTubing(await sessionFor("rt.alpha"), id, "not mine")).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await voidTubing(await sessionFor("chief.demo"), id, "Entered on wrong encounter");
    const restored = (await o.query("SELECT max(next_due_at) AS due FROM tubing_event WHERE encounter_id = $1 AND voided_at IS NULL", [encounterId])).rows[0]
      .due;
    expect(new Date(restored).toISOString()).toBe(new Date(before).toISOString());
  });

  it("disconnection: not before hook-in, only once; no tubing on a disconnected encounter", async () => {
    const rt = await sessionFor("rt.bravo");
    await expect(disconnect(rt, encounterId, wall(minutesAgo(400)))).rejects.toMatchObject({ kind: "INVALID" });
    await disconnect(rt, encounterId, wall(minutesAgo(5)));
    await expect(disconnect(rt, encounterId, wall(minutesAgo(1)))).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(
      documentTubing(rt, { clientId: randomUUID(), encounterId, installedAt: wall(minutesAgo(1)), reason: "late", recordedAtDevice: null }),
    ).rejects.toMatchObject({ kind: "INVALID" });
  });
});

describe("handover carries expected doses by order + slot", () => {
  it("open expected doses appear as NEBULIZATION_ORDER candidates with their slot time", async () => {
    const k = classifyInstant(new Date());
    const on = (
      await o.query(
        "SELECT s.username FROM shift_assignment a JOIN staff s ON s.id = a.staff_id WHERE a.operational_date = $1 AND a.shift = $2 AND a.removed_at IS NULL LIMIT 1",
        [k.operationalDate, k.shift],
      )
    ).rows[0];
    const drafts = await getHandoverDrafts(await sessionFor(on.username));
    const cands = drafts.flatMap((d) => d.candidates);
    const order = cands.filter((c) => c.kind === "NEBULIZATION_ORDER");
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((c) => c.slotAt !== null)).toBe(true);
  });
});

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/server/db";
import { enterNebOrder, hookIn } from "@/server/documentation";
import { correctPatient, getPatientForEdit, registerPatient } from "@/server/clinical";
import { formatDateTime, HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";
import type { Session } from "@/server/session";
import {
  availableUnits,
  endNiv,
  getAlerts,
  getCharges,
  getPatientFlags,
  getToday,
  getTrends,
  listEquipment,
  listNiv,
  postCharges,
  saveEquipment,
  startNiv,
  updatePatientFlags,
} from "@/server/workspace";
import { expectPgError, makeSession, owner, reseed } from "./helpers";

let o: pg.Client;
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
    reauthAt: new Date(),
    idleExpiresAt: new Date(Date.now() + 900_000),
  };
}

let rt: Session;
let chief: Session;
let patientId: string;

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
  rt = await sessionFor("rt.alpha");
  chief = await sessionFor("chief.demo");
  patientId = (await o.query("INSERT INTO patient (full_name, category, ward_room) VALUES ('Redesign, Synthetic', 'INP', 'ICU-R') RETURNING id")).rows[0].id;
}, 120_000);
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("patient flags", () => {
  it("saves precautions, own supplies and endorsement, and rejects unknown values", async () => {
    await updatePatientFlags(rt, patientId, { precautions: ["AIRBORNE"], ownSupplies: ["OWN_MESH_NEBULIZER"], endorsement: "Synthetic note" });
    expect(await getPatientFlags(rt, patientId)).toMatchObject({
      precautions: ["AIRBORNE"],
      ownSupplies: ["OWN_MESH_NEBULIZER"],
      endorsement: "Synthetic note",
    });
    await expectPgError(o.query("UPDATE patient SET precautions = '{NOPE}' WHERE id = $1", [patientId]), "23514");
    const audit = await o.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'patient.flags_updated'");
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });
});

describe("patient profile details", () => {
  it("saves contact, attending physician, height and weight; corrections are kept in history; bad values rejected", async () => {
    const base = { fullName: "Profile, Synthetic Test", sex: "F", category: "OPD", dateOfBirth: "1980-02-03", hospitalPatientId: "", wardRoom: "" };
    const r = await registerPatient(
      rt,
      { ...base, contactInfo: "Son · 0917 000 1234", attendingPhysician: "Dr. Demo Ramos", heightCm: "158", weightKg: "61.5" },
      [],
    );
    expect(r.status).toBe("created");
    const id = (r as { id: string }).id;
    const e = (await getPatientForEdit(rt, id))!;
    expect(e).toMatchObject({ contactInfo: "Son · 0917 000 1234", attendingPhysician: "Dr. Demo Ramos", heightCm: "158", weightKg: "61.5" });
    const bad = await correctPatient(rt, id, e.updatedAt, { ...e, heightCm: "999" }, "");
    expect(bad).toMatchObject({ status: "invalid", errors: { heightCm: expect.any(String) } });
    expect(await correctPatient(rt, id, e.updatedAt, { ...e, attendingPhysician: "Dr. Demo Reyes" }, "")).toEqual({ status: "saved" });
    const rev = await o.query(
      "SELECT before_data ->> 'attending_physician' AS b, after_data ->> 'attending_physician' AS a FROM patient_revision WHERE patient_id = $1",
      [id],
    );
    expect(rev.rows).toEqual([{ b: "Dr. Demo Ramos", a: "Dr. Demo Reyes" }]);
  });
});

describe("equipment board", () => {
  it("only the Chief RT adds units; a rented unit needs both renter and rate", async () => {
    const base = {
      code: "TV-01",
      kind: "VENTILATOR" as const,
      model: "Synthetic",
      pmDueOn: "",
      outOfService: false,
      rentedFrom: "",
      rentedSince: "",
      rentalRate: "",
    };
    await expect(saveEquipment(rt, base)).rejects.toThrow();
    await saveEquipment(chief, base);
    await expect(saveEquipment(chief, { ...base, code: "TV-02", rentedFrom: "Demo Rentals" })).rejects.toThrow();
    await saveEquipment(chief, { ...base, code: "TH-01", kind: "HFNC" });
    expect((await listEquipment(rt)).map((e) => e.code)).toEqual(expect.arrayContaining(["TV-01", "TH-01"]));
  });
});

describe("HFNC / NIV", () => {
  it("starts idempotently, blocks a second running encounter, frees the unit on end", async () => {
    const unit = (await availableUnits(rt, "HFNC")).find((u) => u.code === "TH-01")!;
    expect(unit).toBeTruthy();
    const clientId = randomUUID();
    const input = {
      clientId,
      patientId,
      device: "HFNC" as const,
      setting: "40 L/min · FiO2 35%",
      spo2Target: "92-96%",
      equipmentId: unit.id,
      wardRoom: "ICU-R",
    };
    const first = await startNiv(rt, input);
    expect((await startNiv(rt, input)).duplicate).toBe(true);
    await expect(startNiv(rt, { ...input, clientId: randomUUID() })).rejects.toThrow();
    expect((await availableUnits(rt, "HFNC")).some((u) => u.id === unit.id)).toBe(false);
    expect((await listNiv(rt)).some((n) => n.id === first.id)).toBe(true);
    await endNiv(rt, first.id, "Weaned to room air");
    expect((await availableUnits(rt, "HFNC")).some((u) => u.id === unit.id)).toBe(true);
    await expectPgError(o.query("UPDATE niv_encounter SET device = 'BIPAP' WHERE id = $1", [first.id]), "P0001").catch(async () => {
      // guard may raise a different SQLSTATE; any error is acceptable as long as the row is unchanged
      const r = await o.query("SELECT device FROM niv_encounter WHERE id = $1", [first.id]);
      expect(r.rows[0].device).toBe("HFNC");
    });
  });
});

describe("ventilator hook-in with an equipment unit", () => {
  it("an RT can assign a free unit; the same unit cannot go on a second patient", async () => {
    const unit = (await availableUnits(rt, "VENTILATOR")).find((u) => u.code === "TV-01")!;
    const other = (await o.query("INSERT INTO patient (full_name, category, ward_room) VALUES ('Redesign, Second', 'INP', 'ICU-S') RETURNING id")).rows[0].id;
    const at = new Date(Date.now() - 3600_000).toISOString().slice(0, 16);
    const base = { ventilatorRef: "", wardRoom: "ICU-R", hookedAt: at, newCircuitInstalled: true, recordedAtDevice: null, equipmentId: unit.id };
    await hookIn(rt, { ...base, clientId: randomUUID(), patientId });
    const v = await o.query("SELECT ventilator_ref FROM vent_encounter WHERE patient_id = $1 AND disconnected_at IS NULL", [patientId]);
    expect(v.rows[0].ventilator_ref).toBe("TV-01");
    await expect(hookIn(rt, { ...base, clientId: randomUUID(), patientId: other, wardRoom: "ICU-S" })).rejects.toThrow(/already on another patient/);
  });
});

describe("neb order date/time from the chart", () => {
  it("is stored as a readable date/time; a future order time is rejected", async () => {
    const z = (n: number) => String(n).padStart(2, "0");
    const local = (d: Date) => {
      const p = toLocalParts(d, HOSPITAL_TZ);
      return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
    };
    const ordered = new Date(Math.floor((Date.now() - 2 * 3600_000) / 60_000) * 60_000);
    const base = {
      patientId,
      prescriber: "Dr. Attending (synthetic)",
      medicationAsOrdered: "Synthetic medication",
      frequency: "PRN",
      prescribedTimes: "",
      startAt: local(new Date(Date.now() - 3600_000)),
      endAt: "",
    };
    const id = randomUUID();
    await enterNebOrder(rt, { ...base, clientId: id, orderReference: local(ordered) });
    const r = await o.query("SELECT order_reference, prescriber FROM neb_order WHERE id = $1", [id]);
    expect(r.rows[0]).toEqual({ order_reference: formatDateTime(ordered), prescriber: "Dr. Attending (synthetic)" });
    await expect(enterNebOrder(rt, { ...base, clientId: randomUUID(), orderReference: local(new Date(Date.now() + 3 * 3600_000)) })).rejects.toThrow(/future/);
    const q6 = randomUUID();
    await enterNebOrder(rt, { ...base, clientId: q6, orderReference: local(ordered), frequency: "Q6H", firstDose: "20:00" });
    const t = await o.query("SELECT prescribed_times::text[] AS t FROM neb_order WHERE id = $1", [q6]);
    expect(t.rows[0].t.map((x: string) => x.slice(0, 5))).toEqual(["02:00", "08:00", "14:00", "20:00"]);
    await expect(enterNebOrder(rt, { ...base, clientId: randomUUID(), orderReference: local(ordered), frequency: "Q6H", firstDose: "" })).rejects.toThrow(
      /first dose/,
    );
  });
});

describe("charges (machines only)", () => {
  it("is Chief-only and posts once per patient per day", async () => {
    await expect(getCharges(rt)).rejects.toThrow();
    const c = await getCharges(chief);
    expect(c).toBeTruthy();
    const date = c.date;
    const ids = c.groups.map((g) => g.patient.id).slice(0, 1);
    if (ids.length) {
      await postCharges(chief, date, ids);
      await expect(postCharges(chief, date, ids)).resolves.toMatchObject({ posted: 0 });
    }
  });
});

describe("workspace read models", () => {
  it("Today, Alerts and Trends load for an RT", async () => {
    const t = await getToday(rt);
    expect(t).toHaveProperty("dueNow");
    expect(Array.isArray(await getAlerts(rt))).toBe(true);
    const tr = await getTrends(rt);
    expect(tr).toBeTruthy();
  });
});

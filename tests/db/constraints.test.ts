import type pg from "pg";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { expectPgError, owner, reseed } from "./helpers";

/** Clinical integrity rules enforced by the database itself (owner connection; each test rolled back). */
let o: pg.Client;
beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
});
afterAll(() => o.end());
beforeEach(() => o.query("BEGIN"));
afterEach(() => o.query("ROLLBACK"));

const one = async (sql: string) => (await o.query(sql)).rows[0];

describe("nebulization", () => {
  it("not-given / refused / delayed / cancelled require a reason", async () => {
    const ord = await one("SELECT id, patient_id FROM neb_order LIMIT 1");
    await expectPgError(
      o.query("INSERT INTO neb_administration (order_id, patient_id, scheduled_at, status) VALUES ($1, $2, now(), 'NOT_GIVEN')", [ord.id, ord.patient_id]),
      "23514",
    );
  });

  it("completed requires an actual time and a performer", async () => {
    const ord = await one("SELECT id, patient_id FROM neb_order LIMIT 1");
    await expectPgError(
      o.query("INSERT INTO neb_administration (order_id, patient_id, scheduled_at, status) VALUES ($1, $2, now(), 'COMPLETED')", [ord.id, ord.patient_id]),
      "23514",
    );
  });

  it("an administration must belong to the order's patient", async () => {
    const ord = await one("SELECT id, patient_id FROM neb_order LIMIT 1");
    const other = await one(`SELECT id FROM patient WHERE id <> '${ord.patient_id}' LIMIT 1`);
    await expectPgError(
      o.query("INSERT INTO neb_administration (order_id, patient_id, scheduled_at, status) VALUES ($1, $2, now(), 'SCHEDULED')", [ord.id, other.id]),
      "23514",
    );
  });

  it("PRN orders cannot carry scheduled times (no inferred schedules)", async () => {
    const p = await one("SELECT id FROM patient LIMIT 1");
    await expectPgError(
      o.query(
        "INSERT INTO neb_order (patient_id, order_reference, prescriber, medication_as_ordered, frequency, prescribed_times, start_at) VALUES ($1, 'T', 'Dr. Demo', 'as ordered', 'PRN', '{08:00}', now())",
        [p.id],
      ),
      "23514",
    );
  });
});

describe("ventilation and tubing", () => {
  it("disconnection cannot precede hook-in", async () => {
    const p = await one("SELECT id FROM patient WHERE id NOT IN (SELECT patient_id FROM vent_encounter) LIMIT 1");
    await expectPgError(
      o.query(
        "INSERT INTO vent_encounter (patient_id, hooked_at, disconnected_at, ventilator_ref, ward_room) VALUES ($1, now(), now() - interval '1 hour', 'V', 'W')",
        [p.id],
      ),
      "23514",
    );
  });

  it("a patient cannot have overlapping ventilator encounters", async () => {
    const e = await one("SELECT patient_id FROM vent_encounter WHERE disconnected_at IS NULL LIMIT 1");
    await expectPgError(
      o.query("INSERT INTO vent_encounter (patient_id, hooked_at, ventilator_ref, ward_room) VALUES ($1, now(), 'V2', 'W')", [e.patient_id]),
      "23P01",
    );
  });

  it("next due is computed by the database from the documented installation and the interval in force", async () => {
    const e = await one("SELECT id, hooked_at FROM vent_encounter WHERE disconnected_at IS NULL LIMIT 1");
    const s = await one("SELECT id FROM staff WHERE username = 'rt.alpha'");
    const r = await o.query(
      "INSERT INTO tubing_event (encounter_id, installed_at, interval_days, next_due_at, performed_by, reason) VALUES ($1, $2::timestamptz + interval '1 hour', 7, '1999-01-01', $3, 'test') RETURNING installed_at, next_due_at",
      [e.id, e.hooked_at, s.id],
    );
    expect(new Date(r.rows[0].next_due_at).getTime() - new Date(r.rows[0].installed_at).getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("tubing cannot be installed before the encounter began", async () => {
    const e = await one("SELECT id, hooked_at FROM vent_encounter LIMIT 1");
    const s = await one("SELECT id FROM staff WHERE username = 'rt.alpha'");
    await expectPgError(
      o.query(
        "INSERT INTO tubing_event (encounter_id, installed_at, interval_days, next_due_at, performed_by, reason) VALUES ($1, $2::timestamptz - interval '1 day', 7, now(), $3, 'x')",
        [e.id, e.hooked_at, s.id],
      ),
      "23514",
    );
  });
});

describe("identity, settings, handover", () => {
  it("there can be only one Chief RT", async () => {
    await expectPgError(
      o.query("INSERT INTO staff (username, display_name, role, status) VALUES ('second.chief', 'Second', 'CHIEF_RT_ADMIN', 'INVITED')"),
      "23505",
    );
  });

  it("usernames are unique case-insensitively and well-formed", async () => {
    await expectPgError(o.query("INSERT INTO staff (username, display_name, role) VALUES ('RT.ALPHA', 'x', 'RESPIRATORY_THERAPIST')"), "23514");
    await o.query("ROLLBACK");
    await o.query("BEGIN");
    await expectPgError(o.query("INSERT INTO staff (username, display_name, role) VALUES ('rt.alpha', 'x', 'RESPIRATORY_THERAPIST')"), "23505");
  });

  it("settings outside the allowed range are rejected by the database", async () => {
    await expectPgError(o.query("UPDATE setting SET value = '0' WHERE key = 'tubing.interval_days'"), "23514");
    await o.query("ROLLBACK");
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE setting SET value = '7.5' WHERE key = 'tubing.interval_days'"), "23514");
  });

  it("no device may be flagged for offline PHI yet (ADR-0003)", async () => {
    await expectPgError(o.query("INSERT INTO device (label, offline_phi_allowed) VALUES ('x', true)"), "23514");
  });

  it("handover items must reference an existing record", async () => {
    const h = await one("SELECT id FROM shift_handover LIMIT 1");
    await expectPgError(
      o.query("INSERT INTO handover_item (handover_id, kind, ref_id, summary) VALUES ($1, 'VENTILATOR_ENCOUNTER', gen_random_uuid(), 'ghost')", [h.id]),
      "23503",
    );
  });

  it("hospital numbers are unique when present but optional", async () => {
    const p = await one("SELECT hospital_patient_id FROM patient LIMIT 1");
    await o.query("INSERT INTO patient (full_name, category) VALUES ('No Number, Synthetic', 'OPD')");
    await expectPgError(
      o.query("INSERT INTO patient (hospital_patient_id, full_name, category) VALUES ($1, 'Dup', 'OPD')", [` ${p.hospital_patient_id.toLowerCase()} `]),
      "23505",
    );
  });
});

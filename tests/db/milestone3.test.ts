import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyInstant, previousShift, nextShift } from "@/lib/time/shifts";
import {
  acknowledgeHandover,
  assignShift,
  correctPatient,
  createHandover,
  getHandoverDrafts,
  getPatientForEdit,
  getPatientRevisions,
  registerPatient,
  removeAssignment,
} from "@/server/clinical";
import { getPool } from "@/server/db";
import type { Session } from "@/server/session";
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
    reauthAt: null,
    idleExpiresAt: new Date(Date.now() + 15 * 60_000),
  };
}

const base = { fullName: "", sex: "M", category: "OPD", dateOfBirth: "", hospitalPatientId: "", wardRoom: "" };

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
});
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("patient registration (U-07 sex M/F only, U-13 hospital number optional)", () => {
  it("registers a patient with no hospital number", async () => {
    const rt = await sessionFor("rt.alpha");
    const r = await registerPatient(rt, { ...base, fullName: "Newpatient, Synthetic Uno" }, []);
    expect(r.status).toBe("created");
    const row = (await o.query("SELECT hospital_patient_id, sex, created_by FROM patient WHERE full_name = 'Newpatient, Synthetic Uno'")).rows[0];
    expect(row).toEqual({ hospital_patient_id: null, sex: "M", created_by: rt.staffId });
  });

  it("accepts only Male or Female", async () => {
    const rt = await sessionFor("rt.alpha");
    for (const sex of ["", "X", "UNKNOWN", "m"]) {
      const r = await registerPatient(rt, { ...base, fullName: "Sexcheck, Synthetic", sex }, []);
      expect(r).toMatchObject({ status: "invalid", errors: { sex: "Select Male or Female." } });
    }
  });

  it("the database also rejects any other sex value (NULL = not recorded is allowed)", async () => {
    await o.query("BEGIN");
    await expectPgError(o.query("INSERT INTO patient (full_name, category, sex) VALUES ('X, Y', 'OPD', 'X')"), "23514");
    await o.query("ROLLBACK");
    await o.query("BEGIN");
    await o.query("INSERT INTO patient (full_name, category, sex) VALUES ('Import, Pending', 'OPD', NULL)");
    await o.query("ROLLBACK");
  });

  it("flags a same-name patient (any word order) for review instead of creating it; confirming creates it and is audited", async () => {
    const rt = await sessionFor("rt.alpha");
    const existing = (await o.query("SELECT id, full_name FROM patient WHERE hospital_patient_id IS NOT NULL ORDER BY full_name LIMIT 1")).rows[0];
    const [family, given] = existing.full_name.split(", ");
    const input = { ...base, fullName: `${given} ${family}` };
    const first = await registerPatient(rt, input, []);
    expect(first.status).toBe("review");
    if (first.status !== "review") return;
    expect(first.candidates.map((c) => c.id)).toContain(existing.id);
    expect(first.candidates.find((c) => c.id === existing.id)?.match).toBe("SAME_NAME");
    const second = await registerPatient(
      rt,
      input,
      first.candidates.map((c) => c.id),
    );
    expect(second.status).toBe("created");
    if (second.status !== "created") return;
    const a = await o.query("SELECT detail FROM audit_log WHERE action = 'patient.registered' AND record_id = $1", [second.id]);
    expect(a.rows[0].detail.reviewed_distinct_from).toContain(existing.id);
  });

  it("flags same date of birth + a shared name word", async () => {
    const rt = await sessionFor("rt.alpha");
    const p = (await o.query("SELECT full_name, date_of_birth FROM patient WHERE date_of_birth IS NOT NULL LIMIT 1")).rows[0];
    const surname = p.full_name.split(", ")[0];
    const r = await registerPatient(rt, { ...base, fullName: `${surname}, Different Person`, dateOfBirth: p.date_of_birth }, []);
    expect(r.status).toBe("review");
    if (r.status === "review") expect(r.candidates.some((c) => c.match === "SAME_DOB_SHARED_NAME")).toBe(true);
  });

  it("refuses a hospital number that is already registered (points to the existing record)", async () => {
    const rt = await sessionFor("rt.alpha");
    const p = (await o.query("SELECT id, hospital_patient_id FROM patient WHERE hospital_patient_id IS NOT NULL LIMIT 1")).rows[0];
    const r = await registerPatient(rt, { ...base, fullName: "Totally Different", hospitalPatientId: ` ${p.hospital_patient_id.toLowerCase()} ` }, []);
    expect(r).toEqual({ status: "exists", existingId: p.id });
  });
});

describe("patient corrections", () => {
  it("identity changes need a reason; the revision keeps who, why, before and after", async () => {
    const rt = await sessionFor("rt.bravo");
    const id = (await o.query("SELECT id FROM patient WHERE full_name = 'Newpatient, Synthetic Uno'")).rows[0].id;
    const cur = (await getPatientForEdit(rt, id))!;
    const noReason = await correctPatient(rt, id, cur.updatedAt, { ...cur, fullName: "Newpatient, Synthetic Una" }, "");
    expect(noReason).toMatchObject({ status: "invalid", errors: { reason: expect.any(String) } });
    const ok = await correctPatient(rt, id, cur.updatedAt, { ...cur, fullName: "Newpatient, Synthetic Una", sex: "F" }, "Misspelled at registration");
    expect(ok).toEqual({ status: "saved" });
    const revs = await getPatientRevisions(rt, id);
    expect(revs[0]).toMatchObject({ reason: "Misspelled at registration", by: "RT Bravo (Demo)" });
    expect(revs[0].changes).toEqual(
      expect.arrayContaining([
        { field: "full_name", from: "Newpatient, Synthetic Uno", to: "Newpatient, Synthetic Una" },
        { field: "sex", from: "M", to: "F" },
      ]),
    );
  });

  it("a ward move needs no reason but is still kept in history", async () => {
    const rt = await sessionFor("rt.bravo");
    const id = (await o.query("SELECT id FROM patient WHERE full_name = 'Newpatient, Synthetic Una'")).rows[0].id;
    const cur = (await getPatientForEdit(rt, id))!;
    expect(await correctPatient(rt, id, cur.updatedAt, { ...cur, category: "INP", wardRoom: "Ward 3A-01" }, "")).toEqual({ status: "saved" });
    expect((await getPatientRevisions(rt, id))[0].changes.map((c) => c.field).sort()).toEqual(["category", "ward_room"]);
  });

  it("a stale form cannot overwrite someone else's newer change", async () => {
    const rt = await sessionFor("rt.bravo");
    const id = (await o.query("SELECT id FROM patient WHERE full_name = 'Newpatient, Synthetic Una'")).rows[0].id;
    const cur = (await getPatientForEdit(rt, id))!;
    await correctPatient(rt, id, cur.updatedAt, { ...cur, wardRoom: "Ward 3A-02" }, "");
    await expect(correctPatient(rt, id, cur.updatedAt, { ...cur, wardRoom: "Ward 9Z" }, "")).rejects.toMatchObject({ kind: "CONFLICT" });
  });

  it("the database refuses an identity change without a reason, even for the owner, and revisions are append-only", async () => {
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE patient SET full_name = 'Sneaky, Change' WHERE full_name = 'Newpatient, Synthetic Una'"), "23514");
    await o.query("ROLLBACK");
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE patient_revision SET reason = 'x'"), "42501");
    await o.query("ROLLBACK");
  });
});

describe("roster editing (Chief RT only, removals kept)", () => {
  const date = () => classifyInstant(new Date()).operationalDate;

  it("an RT cannot change assignments", async () => {
    const rt = await sessionFor("rt.alpha");
    await expect(assignShift(rt, date(), "MORNING", rt.staffId)).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("the Chief RT adds, is told about duplicates, removes (soft) and can re-add", async () => {
    const chief = await sessionFor("chief.demo");
    const target = (await o.query("SELECT id FROM staff WHERE username = 'rt.charlie'")).rows[0].id;
    const d = (await o.query("SELECT ($1::date + 30)::text AS d", [date()])).rows[0].d;
    await assignShift(chief, d, "NIGHT", target);
    await expect(assignShift(chief, d, "NIGHT", target)).rejects.toMatchObject({ kind: "CONFLICT" });
    const a = (
      await o.query("SELECT id FROM shift_assignment WHERE operational_date = $1 AND shift = 'NIGHT' AND staff_id = $2 AND removed_at IS NULL", [d, target])
    ).rows[0];
    await removeAssignment(chief, a.id, "swap");
    const kept = (await o.query("SELECT removed_at IS NOT NULL AS removed, removal_reason FROM shift_assignment WHERE id = $1", [a.id])).rows[0];
    expect(kept).toEqual({ removed: true, removal_reason: "swap" });
    await assignShift(chief, d, "NIGHT", target);
  });

  it("refuses inactive staff and dates outside the editable range", async () => {
    const chief = await sessionFor("chief.demo");
    const foxtrot = (await o.query("SELECT id FROM staff WHERE username = 'rt.foxtrot'")).rows[0].id;
    await expect(assignShift(chief, date(), "MORNING", foxtrot)).rejects.toMatchObject({ kind: "INVALID" });
    const far = (await o.query("SELECT ($1::date + 90)::text AS d", [date()])).rows[0].d;
    const alpha = (await o.query("SELECT id FROM staff WHERE username = 'rt.alpha'")).rows[0].id;
    await expect(assignShift(chief, far, "MORNING", alpha)).rejects.toMatchObject({ kind: "INVALID" });
  });
});

describe("shift handover (one per shift, U-11)", () => {
  const now = () => classifyInstant(new Date());
  let rosteredUser: string;
  let otherUser: string;

  beforeAll(async () => {
    const k = now();
    const on = await o.query(
      "SELECT s.username FROM shift_assignment a JOIN staff s ON s.id = a.staff_id WHERE a.operational_date = $1 AND a.shift = $2 AND a.removed_at IS NULL AND s.status = 'ACTIVE' ORDER BY s.username",
      [k.operationalDate, k.shift],
    );
    rosteredUser = on.rows[0].username;
    otherUser = (
      await o.query(
        "SELECT username FROM staff WHERE status = 'ACTIVE' AND role = 'RESPIRATORY_THERAPIST' AND NOT (username = ANY($1)) ORDER BY username LIMIT 1",
        [on.rows.map((r) => r.username)],
      )
    ).rows[0].username;
  });

  it("an RT not rostered on the shift cannot write its handover", async () => {
    const s = await sessionFor(otherUser);
    const k = now();
    await expect(
      createHandover(s, { operationalDate: k.operationalDate, shift: k.shift, incomingStaffId: null, equipmentConcerns: "", notes: "x", items: [] }),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });

  it("future shifts and arbitrary item references are refused", async () => {
    const s = await sessionFor(rosteredUser);
    const k = now();
    const future = nextShift(k.operationalDate, k.shift);
    await expect(createHandover(s, { ...future, incomingStaffId: null, equipmentConcerns: "", notes: "x", items: [] })).rejects.toMatchObject({
      kind: "INVALID",
    });
    await expect(
      createHandover(s, {
        operationalDate: k.operationalDate,
        shift: k.shift,
        incomingStaffId: null,
        equipmentConcerns: "",
        notes: "x",
        items: [{ kind: "DIAGNOSTIC", refId: "00000000-0000-4000-8000-000000000000" }],
      }),
    ).rejects.toMatchObject({ kind: "INVALID" });
  });

  it("the rostered RT writes it with items gathered from live records; a second handover for the shift is refused", async () => {
    const s = await sessionFor(rosteredUser);
    const k = now();
    const drafts = await getHandoverDrafts(s);
    const current = drafts.find((d) => d.shift.operationalDate === k.operationalDate && d.shift.shift === k.shift)!;
    expect(current.rostered).toBe(true);
    expect(current.candidates.length).toBeGreaterThan(0);
    const items = current.candidates.slice(0, 4).map((c) => ({ kind: c.kind, refId: c.refId }));
    const { id } = await createHandover(s, {
      operationalDate: k.operationalDate,
      shift: k.shift,
      incomingStaffId: null,
      equipmentConcerns: "",
      notes: "Synthetic test handover",
      items,
    });
    expect((await o.query("SELECT count(*)::int AS n FROM handover_item WHERE handover_id = $1", [id])).rows[0].n).toBe(items.length);
    const chief = await sessionFor("chief.demo");
    await expect(
      createHandover(chief, { operationalDate: k.operationalDate, shift: k.shift, incomingStaffId: null, equipmentConcerns: "", notes: "again", items: [] }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
    });
  });

  it("the author cannot acknowledge; someone else can, once; then the handover is frozen", async () => {
    const k = now();
    const h = (await o.query("SELECT id FROM shift_handover WHERE operational_date = $1 AND shift = $2", [k.operationalDate, k.shift])).rows[0];
    await expect(acknowledgeHandover(await sessionFor(rosteredUser), h.id)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    const other = await sessionFor(otherUser);
    await acknowledgeHandover(other, h.id);
    const row = (await o.query("SELECT acknowledged_by FROM shift_handover WHERE id = $1", [h.id])).rows[0];
    expect(row.acknowledged_by).toBe(other.staffId);
    await expect(acknowledgeHandover(await sessionFor("chief.demo"), h.id)).rejects.toMatchObject({ kind: "CONFLICT" });

    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE shift_handover SET notes = 'rewritten' WHERE id = $1", [h.id]), "23514");
    await o.query("ROLLBACK");
    await o.query("BEGIN");
    const v = (await o.query("SELECT id FROM vent_encounter LIMIT 1")).rows[0].id;
    await expectPgError(
      o.query("INSERT INTO handover_item (handover_id, kind, ref_id, summary) VALUES ($1, 'VENTILATOR_ENCOUNTER', $2, 'late')", [h.id, v]),
      "23514",
    );
    await o.query("ROLLBACK");
  });

  it("the database refuses a handover written in someone else's name", async () => {
    const prev = previousShift(now().operationalDate, now().shift);
    const victim = (await o.query("SELECT id FROM staff WHERE username = 'chief.demo'")).rows[0].id;
    const s = await sessionFor(otherUser);
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
        s.staffId,
        s.sessionId,
        s.deviceId,
      ]);
      await expectPgError(
        c.query("INSERT INTO shift_handover (operational_date, shift, outgoing_staff_id, notes) VALUES ($1::date - 400, $2, $3, 'forged')", [
          prev.operationalDate,
          prev.shift,
          victim,
        ]),
        "42501",
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

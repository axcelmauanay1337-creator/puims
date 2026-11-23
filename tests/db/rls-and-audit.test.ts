import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyInstant } from "@/lib/time/shifts";
import { app, asCtx, expectPgError, makeSession, owner, staffId, reseed } from "./helpers";

let o: pg.Client;
let a: pg.Client;
let rt: { staffId: string; sessionId: string; deviceId: string };
let chief: { staffId: string; sessionId: string; deviceId: string };

beforeAll(async () => {
  reseed();
  o = owner();
  a = app();
  await o.connect();
  await a.connect();
  rt = await makeSession(o, await staffId(o, "rt.alpha"));
  chief = await makeSession(o, await staffId(o, "chief.demo"));
});
afterAll(async () => {
  await o.end();
  await a.end();
});

const count = async (table: string) => Number((await a.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

describe("database-side shift classification (ADR-0004) matches the application", () => {
  const walls = ["05:59:59", "06:00:00", "13:59:59", "14:00:00", "21:59:59", "22:00:00", "23:59:59", "00:00:00", "03:30:00"];
  it.each(walls)("Manila %s on 2026-11-22/23", async (t) => {
    const day = t < "06:00:00" ? "2026-11-23" : "2026-11-22";
    const instant = new Date(`${day}T${t}+08:00`);
    const r = await o.query("SELECT (classify_shift($1)).*", [instant]);
    const js = classifyInstant(instant);
    expect({ operational_date: r.rows[0].operational_date, shift: r.rows[0].shift }).toEqual({ operational_date: js.operationalDate, shift: js.shift });
  });

  it("operational_day_bounds is [06:00, 06:00 next day) Manila", async () => {
    const r = await o.query("SELECT start_at, end_at FROM operational_day_bounds('2026-11-22')");
    expect(new Date(r.rows[0].start_at).toISOString()).toBe("2026-11-21T22:00:00.000Z");
    expect(new Date(r.rows[0].end_at).toISOString()).toBe("2026-11-22T22:00:00.000Z");
  });

  it("clients cannot choose the shift: the trigger overwrites supplied values", async () => {
    const r = await o.query(
      `UPDATE diagnostic_appointment SET operational_date = '2000-01-01', shift = 'MORNING'
        WHERE id = (SELECT id FROM diagnostic_appointment LIMIT 1) RETURNING operational_date, shift, scheduled_at`,
    );
    const js = classifyInstant(new Date(r.rows[0].scheduled_at));
    expect(r.rows[0].operational_date).toBe(js.operationalDate);
    expect(r.rows[0].shift).toBe(js.shift);
  });
});

describe("row-level security: no valid session → no data", () => {
  it("app role with no context sees no patients, staff, clinical rows or settings", async () => {
    await asCtx(a, {}, async () => {
      for (const t of ["patient", "staff", "neb_administration", "vent_encounter", "diagnostic_appointment", "setting", "audit_log", "service_event_v"]) {
        expect(await count(t), t).toBe(0);
      }
    });
  });

  it("a valid MFA-verified session for an ACTIVE RT sees the unit's patients", async () => {
    await asCtx(a, rt, async () => expect(await count("patient")).toBe(48));
  });

  it("forged staff id without a matching session sees nothing", async () => {
    await asCtx(a, { staffId: chief.staffId, sessionId: rt.sessionId, deviceId: rt.deviceId }, async () => expect(await count("patient")).toBe(0));
  });

  it("session pending MFA sees nothing", async () => {
    const pending = await makeSession(o, rt.staffId, { mfa: false });
    await asCtx(a, pending, async () => expect(await count("patient")).toBe(0));
  });

  it("revoked session sees nothing", async () => {
    const s = await makeSession(o, rt.staffId);
    await o.query("UPDATE auth_session SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [s.sessionId]);
    await asCtx(a, s, async () => expect(await count("patient")).toBe(0));
  });

  it("idle-expired session sees nothing", async () => {
    const s = await makeSession(o, rt.staffId);
    await o.query("UPDATE auth_session SET idle_expires_at = now() - interval '1 second' WHERE id = $1", [s.sessionId]);
    await asCtx(a, s, async () => expect(await count("patient")).toBe(0));
  });

  it("revoked device sees nothing", async () => {
    const s = await makeSession(o, rt.staffId);
    await o.query("UPDATE device SET status = 'REVOKED', revoked_at = now() WHERE id = $1", [s.deviceId]);
    await asCtx(a, s, async () => expect(await count("patient")).toBe(0));
  });

  it("a DEACTIVATED account sees nothing even with an unrevoked session", async () => {
    const s = await makeSession(o, await staffId(o, "rt.foxtrot")); // seeded as DEACTIVATED
    await asCtx(a, s, async () => expect(await count("patient")).toBe(0));
  });

  it("the 'auth' context reaches identity tables but never clinical data", async () => {
    await asCtx(a, { auth: true }, async () => {
      expect(await count("staff")).toBeGreaterThan(0);
      expect(await count("patient")).toBe(0);
      expect(await count("neb_administration")).toBe(0);
    });
  });

  it("clinical sessions cannot read credentials or tokens", async () => {
    await asCtx(a, chief, async () => {
      expect(await count("auth_credential")).toBe(0);
      expect(await count("auth_token")).toBe(0);
    });
  });
});

describe("row-level security: role boundaries", () => {
  it("an RT cannot create staff accounts", async () => {
    await asCtx(a, rt, () =>
      expectPgError(a.query("INSERT INTO staff (username, display_name, role) VALUES ('rt.sneaky', 'Sneaky', 'RESPIRATORY_THERAPIST')"), "42501"),
    );
  });

  it("an RT cannot promote anyone (staff update affects 0 rows)", async () => {
    await asCtx(a, rt, async () => {
      const r = await a.query("UPDATE staff SET display_name = 'x' WHERE id = $1", [rt.staffId]);
      expect(r.rowCount).toBe(0);
    });
  });

  it("nobody — not even the Chief RT — can create a second Chief RT through the app role", async () => {
    await asCtx(a, chief, () =>
      expectPgError(a.query("INSERT INTO staff (username, display_name, role) VALUES ('chief.two', 'Second', 'CHIEF_RT_ADMIN')"), "42501"),
    );
  });

  it("an RT cannot change settings or shift assignments; the Chief RT can change settings", async () => {
    await asCtx(a, rt, async () => {
      expect((await a.query("UPDATE setting SET value = '9' WHERE key = 'tubing.interval_days'")).rowCount).toBe(0);
    });
    await asCtx(a, rt, () =>
      expectPgError(a.query("INSERT INTO shift_assignment (operational_date, shift, staff_id) VALUES ('2030-01-01', 'MORNING', $1)", [rt.staffId]), "42501"),
    );
    await asCtx(a, chief, async () => {
      expect((await a.query("UPDATE setting SET value = '9' WHERE key = 'tubing.interval_days'")).rowCount).toBe(1);
    });
  });

  it("only the Chief RT can read the audit log", async () => {
    await asCtx(a, rt, async () => expect(await count("audit_log")).toBe(0));
    await asCtx(a, chief, async () => expect(await count("audit_log")).toBeGreaterThan(0));
  });

  it("the app role has no DELETE privilege on clinical tables", async () => {
    await asCtx(a, chief, () => expectPgError(a.query("DELETE FROM patient WHERE id = (SELECT id FROM patient LIMIT 1)"), "42501"));
  });
});

describe("audit log is append-only, attributed and redacted", () => {
  it("the app role cannot UPDATE, DELETE or TRUNCATE audit rows", async () => {
    await asCtx(a, chief, () => expectPgError(a.query("UPDATE audit_log SET action = 'x'"), "42501"));
    await asCtx(a, chief, () => expectPgError(a.query("DELETE FROM audit_log"), "42501"));
    await asCtx(a, chief, () => expectPgError(a.query("TRUNCATE audit_log"), "42501"));
  });

  it("even the schema owner is blocked by the immutability trigger", async () => {
    await o.query("BEGIN");
    await expectPgError(o.query("UPDATE audit_log SET action = 'tampered' WHERE id = (SELECT min(id) FROM audit_log)"), "42501");
    await o.query("ROLLBACK");
    await o.query("BEGIN");
    await expectPgError(o.query("DELETE FROM audit_log WHERE id = (SELECT min(id) FROM audit_log)"), "42501");
    await o.query("ROLLBACK");
  });

  it("actor, session, device and time are stamped from context — forged values are overwritten", async () => {
    await a.query("BEGIN");
    await a.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
      rt.staffId,
      rt.sessionId,
      rt.deviceId,
    ]);
    // An RT may append but not read back (no RETURNING): audit is Chief-RT-readable only.
    await expectPgError(a.query("INSERT INTO audit_log (action) VALUES ('test.readback') RETURNING id"), "42501");
    await a.query("ROLLBACK");
    await a.query("BEGIN");
    await a.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
      rt.staffId,
      rt.sessionId,
      rt.deviceId,
    ]);
    await a.query("INSERT INTO audit_log (action, actor_id, occurred_at) VALUES ('test.forge', $1, '2000-01-01')", [chief.staffId]);
    await a.query("COMMIT");
    const r = await o.query("SELECT actor_id, session_id, device_id, occurred_at FROM audit_log WHERE action = 'test.forge' ORDER BY id DESC LIMIT 1");
    expect(r.rows[0].actor_id).toBe(rt.staffId);
    expect(r.rows[0].session_id).toBe(rt.sessionId);
    expect(r.rows[0].device_id).toBe(rt.deviceId);
    expect(new Date(r.rows[0].occurred_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("clinical changes are audited with before/after state and actor", async () => {
    const p = (await o.query("SELECT id, ward_room FROM patient WHERE category = 'INP' LIMIT 1")).rows[0];
    await a.query("BEGIN");
    await a.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
      rt.staffId,
      rt.sessionId,
      rt.deviceId,
    ]);
    await a.query("UPDATE patient SET ward_room = 'ICU-TEST', updated_by = $2 WHERE id = $1", [p.id, rt.staffId]);
    await a.query("COMMIT");
    const log = await o.query(
      "SELECT actor_id, device_id, before_data->>'ward_room' AS before, after_data->>'ward_room' AS after FROM audit_log WHERE action = 'patient.update' AND record_id = $1 ORDER BY id DESC LIMIT 1",
      [p.id],
    );
    expect(log.rows[0]).toEqual({ actor_id: rt.staffId, device_id: rt.deviceId, before: p.ward_room, after: "ICU-TEST" });
  });

  it("secrets never reach the audit log", async () => {
    const r = await o.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE (before_data ? 'password_hash') OR (after_data ? 'password_hash') OR (after_data ? 'totp_secret_enc') OR (after_data ? 'token_hash')",
    );
    expect(r.rows[0].n).toBe(0);
    const creds = await o.query("SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'auth_credential'");
    expect(creds.rows[0].n).toBeGreaterThan(0); // credential changes ARE audited, just redacted
  });
});

describe("hardening (migration 0015)", () => {
  it("no public-schema function is executable by PUBLIC, and every one pins its search_path", async () => {
    const r = await o.query(
      `SELECT count(*) FILTER (WHERE has_function_privilege('public', p.oid, 'EXECUTE'))::int AS public_exec,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'))::int AS no_path
         FROM pg_proc p JOIN pg_roles ro ON ro.oid = p.proowner
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND ro.rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ public_exec: 0, no_path: 0 });
  });

  it("schema_migrations is protected by row-level security", async () => {
    const r = await o.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'schema_migrations'::regclass");
    expect(r.rows[0].relrowsecurity).toBe(true);
  });
});

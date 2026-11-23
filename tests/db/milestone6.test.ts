import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyInstant } from "@/lib/time/shifts";
import { getPool } from "@/server/db";
import { exportReport, getPeriodReport } from "@/server/reports";
import type { Session } from "@/server/session";
import { makeSession, owner, reseed } from "./helpers";

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
    idleExpiresAt: new Date(Date.now() + 900_000),
  };
}

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
}, 120_000);
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("period reports", () => {
  const today = classifyInstant(new Date()).operationalDate;

  it("are Chief-only", async () => {
    await expect(getPeriodReport(await sessionFor("rt.alpha"), "week", "operational", today)).rejects.toThrow(/Not permitted/);
    await expect(exportReport(await sessionFor("rt.alpha"), "summary", "week", "operational", today)).rejects.toThrow(/Chief RT/);
  });

  it("per-day counts add up to the period's service counts", async () => {
    const s = await sessionFor("chief.demo");
    for (const period of ["week", "month"] as const) {
      const r = await getPeriodReport(s, period, "operational", today);
      const total = Object.values(r.metrics.serviceCounts).reduce((a, b) => a + b, 0);
      expect(r.perDay.reduce((a, d) => a + d.events, 0)).toBe(total);
      expect(r.perDay).toHaveLength(r.perDay.length);
      expect(r.workload.reduce((a, w) => a + w.events, 0)).toBe(total);
    }
  });

  it("diagnostic rates use only closed outcomes and never divide by zero", async () => {
    const r = await getPeriodReport(await sessionFor("chief.demo"), "year", "calendar", today);
    for (const d of r.diagnostics) {
      const closed = d.completed + d.noShow + d.cancelled;
      if (closed === 0) expect(d.completedRate).toBeNull();
      else expect((d.completedRate ?? 0) + (d.noShowRate ?? 0) + (d.cancelledRate ?? 0)).toBeCloseTo(100, 0);
    }
    expect(r.monthlyTrend).toHaveLength(12);
  });

  it("tubing compliance classifies on-time, late and undocumented replacements", async () => {
    const chief = await sessionFor("chief.demo");
    const p = (await o.query("INSERT INTO patient (full_name, category) VALUES ('Report, Tubing Synthetic', 'INP') RETURNING id")).rows[0].id;
    const rt = (await o.query("SELECT id FROM staff WHERE username = 'rt.alpha'")).rows[0].id;
    const before = (await getPeriodReport(chief, "year", "operational", today)).tubing;
    // installs at -20d (due -13d; next install -14d → on time), -14d (due -7d; next -5d → late), -5d (due +2d → not yet due)
    const d = (days: number) => new Date(Date.now() + days * 86_400_000);
    const e = (
      await o.query(
        "INSERT INTO vent_encounter (patient_id, ventilator_ref, ward_room, hooked_at, responsible_staff_id) VALUES ($1, 'SYN-VENT-R', 'ICU-R', $2, $3) RETURNING id",
        [p, d(-20), rt],
      )
    ).rows[0].id;
    for (const at of [-20, -14, -5])
      await o.query(
        "INSERT INTO tubing_event (encounter_id, tubing_type, installed_at, interval_days, next_due_at, performed_by, reason) VALUES ($1, 'Ventilator circuit', $2, 7, $2, $3, 'ROUTINE')",
        [e, d(at), rt],
      );
    const after = (await getPeriodReport(chief, "year", "operational", today)).tubing;
    expect(after.due - before.due).toBe(2);
    expect(after.onTime - before.onTime).toBe(1);
    expect(after.late - before.late).toBe(1);
    expect(after.notDocumented).toBe(before.notDocumented);
  });

  it("exports are audited, formula-safe, and flag patient-data exports", async () => {
    const chief = await sessionFor("chief.demo");
    await o.query("SELECT set_config('app.change_reason', 'test formula injection', false)");
    await o.query(
      'UPDATE patient SET full_name = \'=HYPERLINK("http://x","y")\' WHERE id = (SELECT patient_id FROM diagnostic_appointment WHERE voided_at IS NULL ORDER BY scheduled_at DESC LIMIT 1)',
    );
    const sum = await exportReport(chief, "summary", "year", "calendar", today);
    expect(sum.csv).toMatch(/^PUIMS summary export/);
    expect(sum.csv).not.toMatch(/SYN-1\d{5}/); // aggregates only
    const appts = await exportReport(chief, "appointments", "year", "calendar", today);
    expect(appts.rows).toBeGreaterThan(0);
    expect(appts.csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(appts.csv).not.toMatch(/(^|,)=HYPERLINK/m);
    const a = await o.query("SELECT detail FROM audit_log WHERE action = 'report.exported' ORDER BY id DESC LIMIT 1");
    expect(a.rows[0].detail).toMatchObject({ kind: "appointments", contains_patient_data: true });
  });
});

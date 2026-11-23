import { describe, expect, it } from "vitest";
import { roleHas, ROLE_PERMISSIONS } from "@/lib/authz/permissions";
import { generateSyntheticDataset } from "@/lib/demo/synthetic";
import { activeVentilatorsAt, completedEventsIn, monthlyTrend, serviceCounts, uniquePatientsServed } from "@/lib/metrics/metrics";
import { classifyInstant, operationalDayWindow } from "@/lib/time/shifts";
import { calendarDayWindow } from "@/lib/time/zoned";

const now = new Date("2026-11-22T19:30:00+08:00");
const anchor = classifyInstant(now).operationalDate;
const ds = generateSyntheticDataset(anchor, now);

describe("synthetic dataset invariants (no real data, internally consistent)", () => {
  it("is deterministic for the same anchor", () => {
    const again = generateSyntheticDataset(anchor, now);
    expect(again.patients.map((p) => p.hospitalPatientId)).toEqual(ds.patients.map((p) => p.hospitalPatientId));
  });

  it("uses only reserved synthetic identifiers and labelled staff/providers", () => {
    const ids = ds.patients.map((p) => p.hospitalPatientId).filter((x): x is string => x !== null);
    expect(ids.every((h) => /^SYN-\d{6}$/.test(h))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThan(ds.patients.length); // some patients have no hospital number (optional)
    expect(ds.patients.every((p) => p.sex === "M" || p.sex === "F")).toBe(true);
    expect(ds.staff.every((s) => s.displayName.includes("(Demo)"))).toBe(true);
    expect(ds.diagnostics.every((d) => d.requestingPhysician.startsWith("Dr. Demo"))).toBe(true);
  });

  it("has exactly one Chief RT administrator", () => {
    expect(ds.staff.filter((s) => s.role === "CHIEF_RT_ADMIN")).toHaveLength(1);
  });

  it("every roster slot has two distinct active RTs", () => {
    const active = new Set(ds.staff.filter((s) => s.accountStatus === "ACTIVE").map((s) => s.id));
    const slots = new Map<string, string[]>();
    for (const a of ds.assignments) {
      expect(active.has(a.staffId)).toBe(true);
      const k = `${a.operationalDate}|${a.shift}`;
      slots.set(k, [...(slots.get(k) ?? []), a.staffId]);
    }
    for (const ids of slots.values()) expect(new Set(ids).size).toBe(2);
  });

  it("all foreign references resolve", () => {
    const patients = new Set(ds.patients.map((p) => p.id));
    const orders = new Set(ds.nebOrders.map((o) => o.id));
    const encounters = new Set(ds.encounters.map((e) => e.id));
    expect(ds.nebAdministrations.every((a) => orders.has(a.orderId) && patients.has(a.patientId))).toBe(true);
    expect(ds.tubing.every((t) => encounters.has(t.encounterId))).toBe(true);
    expect(ds.diagnostics.every((d) => patients.has(d.patientId))).toBe(true);
    const diagIds = new Set(ds.diagnostics.map((d) => d.id));
    expect(ds.diagnostics.every((d) => !d.reschedulesId || diagIds.has(d.reschedulesId))).toBe(true);
  });

  it("never invents administrations: PRN orders have no scheduled times; reasons accompany not-given statuses", () => {
    for (const o of ds.nebOrders.filter((o) => o.frequency === "PRN")) {
      expect(o.prescribedTimes).toEqual([]);
      expect(ds.nebAdministrations.filter((a) => a.orderId === o.id).every((a) => a.scheduledAt === null)).toBe(true);
    }
    for (const a of ds.nebAdministrations.filter((a) => ["NOT_GIVEN", "REFUSED", "DELAYED", "CANCELLED"].includes(a.status))) {
      expect(a.reason).toBeTruthy();
    }
    expect(ds.nebAdministrations.filter((a) => a.status === "COMPLETED").every((a) => a.actualAt && a.performedBy)).toBe(true);
  });

  it("future items are never shown as completed", () => {
    expect(ds.diagnostics.filter((d) => Date.parse(d.scheduledAt) > now.getTime()).every((d) => d.status !== "COMPLETED")).toBe(true);
    expect(ds.activity.every((a) => Date.parse(a.occurredAt) <= now.getTime())).toBe(true);
  });

  it("ventilator encounters never end before they start", () => {
    expect(ds.encounters.every((e) => !e.disconnectedAt || e.disconnectedAt >= e.hookedAt)).toBe(true);
  });
});

describe("metrics", () => {
  it("unique patients ≤ completed events, and counts only completed statuses", () => {
    const w = operationalDayWindow(anchor);
    const events = completedEventsIn(ds.activity, w);
    expect(uniquePatientsServed(ds.activity, w).size).toBeLessThanOrEqual(events.length);
    expect(Object.values(serviceCounts(ds.activity, w)).reduce((a, b) => a + b, 0)).toBe(events.length);
  });

  it("operational-day and calendar-day totals differ by the 00:00–06:00 offset, not by double counting", () => {
    const op = completedEventsIn(ds.activity, operationalDayWindow("2026-11-21")).length;
    const cal = completedEventsIn(ds.activity, calendarDayWindow("2026-11-21")).length;
    const early21 = completedEventsIn(ds.activity, { start: calendarDayWindow("2026-11-21").start, end: operationalDayWindow("2026-11-21").start }).length;
    const early22 = completedEventsIn(ds.activity, { start: calendarDayWindow("2026-11-22").start, end: operationalDayWindow("2026-11-22").start }).length;
    expect(op).toBe(cal - early21 + early22);
  });

  it("active ventilator census at an instant", () => {
    expect(activeVentilatorsAt(ds.encounters, now).length).toBe(ds.encounters.filter((e) => e.status === "ACTIVE").length);
  });

  it("monthly trend covers 12 months and has no future events", () => {
    const m = monthlyTrend(ds.activity, 2026);
    expect(m).toHaveLength(12);
    expect(m[11].total).toBe(0); // December 2026 is in the future
  });
});

describe("role permissions", () => {
  it("RTs cannot manage staff, read audit, import, or change settings", () => {
    for (const p of ["staff:manage", "audit:read", "import:manage", "settings:manage", "activity:read-all", "reports:export"] as const) {
      expect(roleHas("RESPIRATORY_THERAPIST", p)).toBe(false);
    }
  });
  it("Chief RT holds every RT permission except order entry, plus admin permissions", () => {
    for (const p of ROLE_PERMISSIONS.RESPIRATORY_THERAPIST) expect(roleHas("CHIEF_RT_ADMIN", p)).toBe(p !== "orders:enter");
    expect(roleHas("RESPIRATORY_THERAPIST", "orders:enter")).toBe(true);
    expect(roleHas("CHIEF_RT_ADMIN", "staff:manage")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { periodBounds, rate, shiftPeriod } from "@/lib/metrics/periods";

describe("reporting periods (Asia/Manila)", () => {
  it("operational day = 06:00 → 06:00 next day", () => {
    const b = periodBounds("day", "operational", "2026-11-22");
    expect(b.start.toISOString()).toBe("2026-11-21T22:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-11-22T22:00:00.000Z");
  });
  it("calendar day = 00:00 → 24:00", () => {
    const b = periodBounds("day", "calendar", "2026-11-22");
    expect(b.start.toISOString()).toBe("2026-11-21T16:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-11-22T16:00:00.000Z");
  });
  it("weeks start on Monday and have 7 days", () => {
    const b = periodBounds("week", "operational", "2026-11-22"); // a Sunday
    expect([b.firstDay, b.lastDay, b.days]).toEqual(["2026-11-16", "2026-11-22", 7]);
    expect(periodBounds("week", "calendar", "2026-11-16").firstDay).toBe("2026-11-16");
  });
  it("months and years cover every day, including leap years", () => {
    expect(periodBounds("month", "calendar", "2028-02-10")).toMatchObject({ firstDay: "2028-02-01", lastDay: "2028-02-29", days: 29 });
    expect(periodBounds("month", "operational", "2026-12-31")).toMatchObject({ firstDay: "2026-12-01", lastDay: "2026-12-31", days: 31 });
    expect(periodBounds("year", "calendar", "2028-06-01").days).toBe(366);
    // operational year ends at 06:00 on 1 January of the next year
    expect(periodBounds("year", "operational", "2026-06-01").end.toISOString()).toBe("2026-12-31T22:00:00.000Z");
  });
  it("steps between periods", () => {
    expect(shiftPeriod("month", "2026-01-15", -1)).toBe("2025-12-01");
    expect(shiftPeriod("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftPeriod("week", "2026-11-22", 1)).toBe("2026-11-29");
    expect(shiftPeriod("year", "2026-11-22", -1)).toBe("2025-01-01");
  });
  it("never reports a rate over an empty denominator", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(1, 3)).toBe(33.3);
  });
});

import { describe, expect, it } from "vitest";
import { classifyInstant, nextShift, operationalDayWindow, previousShift, shiftForLocalHour, shiftWindow, isWithin } from "@/lib/time/shifts";
import { addDays, calendarDayWindow, parseIsoDate, zonedWallTimeToUtc } from "@/lib/time/zoned";

/** Build an instant from a Manila wall time (UTC+08:00, no DST). */
const manila = (iso: string) => new Date(`${iso}+08:00`);

describe("SECURITY_AND_ACCEPTANCE_CHECKLIST §E — exact shift boundaries (Asia/Manila)", () => {
  const cases: Array<[string, string, string, string]> = [
    // local wall time         shift        operational   calendar
    ["2026-11-22T05:59:59", "NIGHT", "2026-11-21", "2026-11-22"],
    ["2026-11-22T06:00:00", "MORNING", "2026-11-22", "2026-11-22"],
    ["2026-11-22T13:59:59", "MORNING", "2026-11-22", "2026-11-22"],
    ["2026-11-22T14:00:00", "AFTERNOON", "2026-11-22", "2026-11-22"],
    ["2026-11-22T21:59:59", "AFTERNOON", "2026-11-22", "2026-11-22"],
    ["2026-11-22T22:00:00", "NIGHT", "2026-11-22", "2026-11-22"],
    ["2026-11-22T23:59:59", "NIGHT", "2026-11-22", "2026-11-22"],
    ["2026-11-23T00:00:00", "NIGHT", "2026-11-22", "2026-11-23"],
    ["2026-11-23T03:30:00", "NIGHT", "2026-11-22", "2026-11-23"],
  ];
  it.each(cases)("%s → %s / op %s / cal %s", (wall, shift, op, cal) => {
    const c = classifyInstant(manila(wall));
    expect(c.shift).toBe(shift);
    expect(c.operationalDate).toBe(op);
    expect(c.calendarDate).toBe(cal);
    expect(c.timeZone).toBe("Asia/Manila");
  });

  it("uses the hospital timezone, not the host or UTC date", () => {
    // 2026-11-22T21:30Z is 05:30 Manila on Nov 23 → night shift of Nov 22.
    const c = classifyInstant(new Date("2026-11-22T21:30:00Z"));
    expect(c).toMatchObject({ shift: "NIGHT", operationalDate: "2026-11-22", calendarDate: "2026-11-23", localTime: "05:30:00" });
  });

  it("handles month, year and leap-day rollovers after midnight", () => {
    expect(classifyInstant(manila("2027-01-01T02:00:00")).operationalDate).toBe("2026-12-31");
    expect(classifyInstant(manila("2028-03-01T05:00:00")).operationalDate).toBe("2028-02-29");
    expect(classifyInstant(manila("2027-03-01T05:00:00")).operationalDate).toBe("2027-02-28");
  });

  it("rejects invalid instants", () => {
    expect(() => classifyInstant(new Date("not a date"))).toThrow(RangeError);
  });
});

describe("operational-day and calendar-day windows are independent", () => {
  it("operational day is [06:00, 06:00 next day) Manila", () => {
    const w = operationalDayWindow("2026-11-22");
    expect(w.start.toISOString()).toBe("2026-11-21T22:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-22T22:00:00.000Z");
  });

  it("calendar day is [00:00, 24:00) Manila", () => {
    const w = calendarDayWindow("2026-11-22");
    expect(w.start.toISOString()).toBe("2026-11-21T16:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-22T16:00:00.000Z");
  });

  it("an event at 02:00 is in calendar day N+1 but operational day N", () => {
    const e = manila("2026-11-23T02:00:00");
    expect(isWithin(e, operationalDayWindow("2026-11-22"))).toBe(true);
    expect(isWithin(e, calendarDayWindow("2026-11-22"))).toBe(false);
    expect(isWithin(e, calendarDayWindow("2026-11-23"))).toBe(true);
  });

  it("boundary instants are half-open (06:00 belongs to the new day only)", () => {
    const six = manila("2026-11-23T06:00:00");
    expect(isWithin(six, operationalDayWindow("2026-11-22"))).toBe(false);
    expect(isWithin(six, operationalDayWindow("2026-11-23"))).toBe(true);
  });

  it("the three shift windows tile the operational day exactly", () => {
    const day = operationalDayWindow("2026-11-22");
    const m = shiftWindow("2026-11-22", "MORNING");
    const a = shiftWindow("2026-11-22", "AFTERNOON");
    const n = shiftWindow("2026-11-22", "NIGHT");
    expect(m.start).toEqual(day.start);
    expect(m.end).toEqual(a.start);
    expect(a.end).toEqual(n.start);
    expect(n.end).toEqual(day.end);
    expect(n.start.toISOString()).toBe("2026-11-22T14:00:00.000Z"); // 22:00 Manila
  });

  it("classification agrees with windows for every minute of a day", () => {
    const { start } = operationalDayWindow("2026-11-22");
    for (let i = 0; i < 24 * 60; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      const c = classifyInstant(t);
      expect(c.operationalDate).toBe("2026-11-22");
      expect(isWithin(t, shiftWindow("2026-11-22", c.shift))).toBe(true);
    }
  });
});

describe("shift sequencing for handover", () => {
  it("next and previous shift wrap across the operational day", () => {
    expect(nextShift("2026-11-22", "NIGHT")).toEqual({ operationalDate: "2026-11-23", shift: "MORNING" });
    expect(previousShift("2026-11-23", "MORNING")).toEqual({ operationalDate: "2026-11-22", shift: "NIGHT" });
    expect(nextShift("2026-11-22", "MORNING")).toEqual({ operationalDate: "2026-11-22", shift: "AFTERNOON" });
  });
  it("rejects out-of-range hours", () => {
    expect(() => shiftForLocalHour(24)).toThrow(RangeError);
    expect(() => shiftForLocalHour(-1)).toThrow(RangeError);
  });
});

describe("timezone primitives are correct for DST zones too", () => {
  it("America/New_York spring-forward day is 23h; operational window honours wall-clock 06:00", () => {
    const w = calendarDayWindow("2026-03-08", "America/New_York");
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(23);
    const op = operationalDayWindow("2026-03-08", "America/New_York");
    expect(op.start.toISOString()).toBe("2026-03-08T10:00:00.000Z"); // 06:00 EDT (UTC-4)
  });
  it("fall-back repeated hour resolves to the earlier instant", () => {
    const t = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York");
    expect(t.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("ISO date helpers", () => {
  it("rejects impossible dates instead of rolling them over", () => {
    expect(() => parseIsoDate("2026-02-30")).toThrow(RangeError);
    expect(() => parseIsoDate("2026-13-01")).toThrow(RangeError);
    expect(() => parseIsoDate("26-1-1")).toThrow(RangeError);
  });
  it("adds days across month/year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});

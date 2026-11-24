import { describe, expect, it } from "vitest";
import { dosesFromFirst, expectedSlots, orderEnd, parsePrescribedTimes } from "@/lib/clinical/nebSlots";
import { operationalDayWindow } from "@/lib/time/shifts";

const manila = (iso: string) => new Date(`${iso}+08:00`);
const iso = (ds: Date[]) => ds.map((d) => d.toISOString());

describe("expected nebulization slots come only from the times written on the order", () => {
  const day = operationalDayWindow("2026-11-22"); // 22 Nov 06:00 → 23 Nov 06:00 Manila

  it("a Q6H order written as 06:00, 12:00, 18:00, 00:00 yields four slots; 00:00 is the next calendar day", () => {
    const slots = expectedSlots(
      { prescribedTimes: ["06:00", "12:00", "18:00", "00:00"], startAt: manila("2026-11-20T00:00:00"), endAt: null, discontinuedAt: null },
      day,
    );
    expect(iso(slots)).toEqual(
      iso([manila("2026-11-22T06:00:00"), manila("2026-11-22T12:00:00"), manila("2026-11-22T18:00:00"), manila("2026-11-23T00:00:00")]),
    );
  });

  it("05:59 belongs to this operational day; 06:00 next day does not", () => {
    const slots = expectedSlots({ prescribedTimes: ["05:59", "06:00"], startAt: manila("2026-11-01T00:00:00"), endAt: null, discontinuedAt: null }, day);
    expect(iso(slots)).toEqual(iso([manila("2026-11-22T06:00:00"), manila("2026-11-23T05:59:00")]));
  });

  it("no written times (e.g. PRN, or BID without times) → no slots — nothing is inferred from frequency", () => {
    expect(expectedSlots({ prescribedTimes: [], startAt: manila("2026-11-01T00:00:00"), endAt: null, discontinuedAt: null }, day)).toEqual([]);
  });

  it("respects the order's start, end and discontinuation", () => {
    const o = {
      prescribedTimes: ["08:00", "14:00", "20:00"],
      startAt: manila("2026-11-22T10:00:00"),
      endAt: null,
      discontinuedAt: manila("2026-11-22T20:00:00"),
    };
    expect(iso(expectedSlots(o, day))).toEqual(iso([manila("2026-11-22T14:00:00")]));
    expect(orderEnd({ endAt: manila("2026-11-25T00:00:00"), discontinuedAt: manila("2026-11-23T00:00:00") })).toEqual(manila("2026-11-23T00:00:00"));
  });

  it("parses written times strictly", () => {
    expect(parsePrescribedTimes("20:00, 08:00 14:00 08:00")).toEqual({ ok: true, times: ["08:00", "14:00", "20:00"] });
    expect(parsePrescribedTimes("")).toEqual({ ok: true, times: [] });
    expect(parsePrescribedTimes("8am")).toEqual({ ok: true, times: ["08:00"] });
    expect(parsePrescribedTimes("8:00 AM, 2:00 PM, 8:00 PM")).toEqual({ ok: true, times: ["08:00", "14:00", "20:00"] });
    expect(parsePrescribedTimes("12 MN, 6 AM, 12 NN, 6 PM")).toEqual({ ok: true, times: ["00:00", "06:00", "12:00", "18:00"] });
    expect(parsePrescribedTimes("12:00 AM 12:30 PM")).toEqual({ ok: true, times: ["00:00", "12:30"] });
    expect(parsePrescribedTimes("8")).toMatchObject({ ok: false });
    expect(parsePrescribedTimes("13 PM")).toMatchObject({ ok: false });
    expect(parsePrescribedTimes("8:00")).toMatchObject({ ok: false });
    expect(parsePrescribedTimes("24:00")).toMatchObject({ ok: false });
    expect(parsePrescribedTimes("12:60")).toMatchObject({ ok: false });
  });
});

describe("dose times counted from the first dose", () => {
  it("Q6H from 8:00 PM gives four times a day", () => {
    expect(dosesFromFirst("Q6H", "20:00")).toEqual(["02:00", "08:00", "14:00", "20:00"]);
  });
  it("BID / TID / Q4H / Q12H", () => {
    expect(dosesFromFirst("BID", "09:00")).toEqual(["09:00", "21:00"]);
    expect(dosesFromFirst("TID", "06:30")).toEqual(["06:30", "14:30", "22:30"]);
    expect(dosesFromFirst("Q4H", "00:00")).toEqual(["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]);
    expect(dosesFromFirst("Q12H", "10:15")).toEqual(["10:15", "22:15"]);
  });
  it("QID = every 6 h; STAT and ONCE are a single dose", () => {
    expect(dosesFromFirst("QID", "08:00")).toEqual(["02:00", "08:00", "14:00", "20:00"]);
    expect(dosesFromFirst("STAT", "10:42")).toEqual(["10:42"]);
    expect(dosesFromFirst("ONCE", "21:00")).toEqual(["21:00"]);
  });
  it("PRN has no times; a bad first dose is rejected", () => {
    expect(dosesFromFirst("PRN", "08:00")).toEqual([]);
    expect(dosesFromFirst("Q6H", "8")).toBeNull();
  });
});

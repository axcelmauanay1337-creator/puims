import { describe, expect, it } from "vitest";
import { expectedSlots, orderEnd, parsePrescribedTimes } from "@/lib/clinical/nebSlots";
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
    expect(parsePrescribedTimes("8am")).toMatchObject({ ok: false });
    expect(parsePrescribedTimes("24:00")).toMatchObject({ ok: false });
    expect(parsePrescribedTimes("12:60")).toMatchObject({ ok: false });
  });
});

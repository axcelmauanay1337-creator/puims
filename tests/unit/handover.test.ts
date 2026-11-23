import { describe, expect, it } from "vitest";
import { handoverableShifts, isHandoverable, receivingShift } from "@/lib/time/handover";

const manila = (iso: string) => new Date(`${iso}+08:00`);

describe("which shift may be handed over (Asia/Manila)", () => {
  it("05:59 → the night shift of the PREVIOUS operational date, and the afternoon before it", () => {
    expect(handoverableShifts(manila("2026-11-23T05:59:00"))).toEqual([
      { operationalDate: "2026-11-22", shift: "NIGHT" },
      { operationalDate: "2026-11-22", shift: "AFTERNOON" },
    ]);
  });

  it("06:00 → the new day's morning shift, and the night shift that just ended", () => {
    expect(handoverableShifts(manila("2026-11-23T06:00:00"))).toEqual([
      { operationalDate: "2026-11-23", shift: "MORNING" },
      { operationalDate: "2026-11-22", shift: "NIGHT" },
    ]);
  });

  it("00:30 after midnight still belongs to the night shift that began the previous evening", () => {
    expect(handoverableShifts(manila("2026-11-23T00:30:00"))[0]).toEqual({ operationalDate: "2026-11-22", shift: "NIGHT" });
  });

  it("refuses future and stale shifts", () => {
    const now = manila("2026-11-22T15:00:00");
    expect(isHandoverable({ operationalDate: "2026-11-22", shift: "AFTERNOON" }, now)).toBe(true);
    expect(isHandoverable({ operationalDate: "2026-11-22", shift: "MORNING" }, now)).toBe(true);
    expect(isHandoverable({ operationalDate: "2026-11-22", shift: "NIGHT" }, now)).toBe(false);
    expect(isHandoverable({ operationalDate: "2026-11-21", shift: "NIGHT" }, now)).toBe(false);
  });

  it("a night handover is received by the next operational date's morning shift", () => {
    expect(receivingShift({ operationalDate: "2026-11-22", shift: "NIGHT" })).toEqual({ operationalDate: "2026-11-23", shift: "MORNING" });
  });
});

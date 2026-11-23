import { describe, expect, it } from "vitest";
import { assessTubing, computeNextDue, DEFAULT_TUBING_POLICY, validatePolicy } from "@/lib/clinical/tubing";

const manila = (iso: string) => new Date(`${iso}+08:00`);

describe("Chamfecof tubing due status", () => {
  const installed = manila("2026-11-15T10:00:00");

  it("next due is installed_at + 7 days by default", () => {
    expect(computeNextDue(installed, 7).toISOString()).toBe(manila("2026-11-22T10:00:00").toISOString());
  });

  it("an active encounter without a documented installation is NO_RECORD, never assumed current", () => {
    expect(assessTubing(null, manila("2026-11-20T10:00:00")).status).toBe("NO_RECORD");
  });

  it("CURRENT when due is beyond the upcoming window", () => {
    expect(assessTubing(installed, manila("2026-11-17T10:00:00")).status).toBe("CURRENT");
  });

  it("UPCOMING inside the 48h window but on a later operational day", () => {
    expect(assessTubing(installed, manila("2026-11-20T12:00:00")).status).toBe("UPCOMING");
  });

  it("DUE when the due instant falls later in the current 06:00–06:00 operational day", () => {
    expect(assessTubing(installed, manila("2026-11-22T06:00:00")).status).toBe("DUE");
    expect(assessTubing(installed, manila("2026-11-22T09:59:00")).status).toBe("DUE");
  });

  it("a due time at 03:00 counts as due during the previous evening's operational day", () => {
    const i = manila("2026-11-16T03:00:00"); // due 2026-11-23 03:00 → operational date 2026-11-22
    expect(assessTubing(i, manila("2026-11-22T23:00:00")).status).toBe("DUE");
    expect(assessTubing(i, manila("2026-11-22T05:00:00")).status).toBe("UPCOMING");
  });

  it("OVERDUE once the due instant passes, with a negative remaining time", () => {
    const a = assessTubing(installed, manila("2026-11-22T10:00:00"));
    expect(a.status).toBe("OVERDUE");
    const b = assessTubing(installed, manila("2026-11-24T10:00:00"));
    expect(b.status).toBe("OVERDUE");
    expect(b.msUntilDue).toBe(-2 * 24 * 3_600_000);
  });

  it("honours a configured interval", () => {
    const a = assessTubing(installed, manila("2026-11-22T11:00:00"), { ...DEFAULT_TUBING_POLICY, intervalDays: 10 });
    expect(a.status).toBe("CURRENT");
  });

  it("rejects unsafe policy values", () => {
    expect(() => validatePolicy({ intervalDays: 0, upcomingWindowHours: 48 })).toThrow();
    expect(() => validatePolicy({ intervalDays: 7.5, upcomingWindowHours: 48 })).toThrow();
    expect(() => validatePolicy({ intervalDays: 7, upcomingWindowHours: -1 })).toThrow();
  });
});

/**
 * Expected nebulization slots, derived ONLY from the times written on the order.
 * No times are ever inferred from the frequency (PRODUCT_REQUIREMENTS §5): an order
 * without written times (e.g. PRN, or BID with no times on the order) has no slots.
 * Slots are NOT stored; a row is written only when an RT documents what happened.
 */
import { calendarDateOf, addDays, HOSPITAL_TZ, parseIsoDate, zonedWallTimeToUtc } from "@/lib/time/zoned";

export interface OrderTiming {
  prescribedTimes: string[]; // "HH:MM" or "HH:MM:SS", Asia/Manila wall times
  startAt: Date;
  endAt: Date | null;
  discontinuedAt: Date | null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;

/** Parses "08:00, 14:00 20:00" → ["08:00","14:00","20:00"] (sorted, unique) or an error message. */
export function parsePrescribedTimes(raw: string): { ok: true; times: string[] } | { ok: false; error: string } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const bad = parts.find((p) => !TIME_RE.test(p));
  if (bad) return { ok: false, error: `“${bad}” is not a 24-hour time like 08:00.` };
  const times = [...new Set(parts.map((p) => p.slice(0, 5)))].sort();
  if (times.length > 24) return { ok: false, error: "At most 24 times." };
  return { ok: true, times };
}

/** Effective end of an order: the earlier of its written end and its discontinuation. */
export function orderEnd(o: Pick<OrderTiming, "endAt" | "discontinuedAt">): Date | null {
  if (o.endAt && o.discontinuedAt) return o.endAt < o.discontinuedAt ? o.endAt : o.discontinuedAt;
  return o.endAt ?? o.discontinuedAt;
}

/** Expected slot instants of `order` inside the half-open window [start, end). */
export function expectedSlots(order: OrderTiming, window: { start: Date; end: Date }, tz: string = HOSPITAL_TZ): Date[] {
  if (!order.prescribedTimes.length) return [];
  const end = orderEnd(order);
  const out: Date[] = [];
  const firstDay = calendarDateOf(window.start, tz);
  const lastDay = calendarDateOf(new Date(window.end.getTime() - 1), tz);
  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) {
    const { year, month, day } = parseIsoDate(d);
    for (const t of order.prescribedTimes) {
      const m = TIME_RE.exec(t);
      if (!m) continue;
      const at = zonedWallTimeToUtc({ year, month, day, hour: Number(m[1]), minute: Number(m[2]) }, tz);
      if (at < window.start || at >= window.end) continue;
      if (at < order.startAt) continue;
      if (end && at >= end) continue;
      out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

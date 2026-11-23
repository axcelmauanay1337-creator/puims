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

const H24_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;
const H12_RE = /^(\d{1,2})(?::([0-5]\d))?\s*(AM|PM|A\.M\.?|P\.M\.?|NN|MN)$/i;

/** Frequencies offered when entering an order, and the interval in hours for the scheduled ones. */
export const ORDER_FREQUENCIES = ["Q4H", "Q6H", "Q8H", "Q12H", "BID", "TID", "PRN"] as const;
export const FREQUENCY_HOURS: Record<string, number> = { Q4H: 4, Q6H: 6, Q8H: 8, Q12H: 12, BID: 12, TID: 8 };

/**
 * Dose times for one day, counted from the first dose: Q6H from 8:00 PM → 02:00, 08:00, 14:00, 20:00.
 * Returns [] for PRN or an unknown frequency, and null when the first-dose time is not valid.
 */
export function dosesFromFirst(frequency: string, firstDose: string): string[] | null {
  const h = FREQUENCY_HOURS[frequency];
  if (!h) return [];
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(firstDose.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const out = Array.from({ length: Math.round(24 / h) }, (_, i) => `${String((start + i * h) % 24).padStart(2, "0")}:${m[2]}`);
  return [...new Set(out)].sort();
}

/** One written time → "HH:MM", or null. Accepts 8:00 AM, 8 PM, 8pm, 12 NN, 12 MN and 24-hour 20:00. */
export function parseOneTime(text: string): string | null {
  const t = text.trim();
  if (H24_RE.test(t)) return t.slice(0, 5);
  const m = H12_RE.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ?? "00";
  const mer = m[3].toUpperCase().replace(/\./g, "");
  if (h < 1 || h > 12) return null;
  if ((mer === "NN" || mer === "MN") && (h !== 12 || min !== "00")) return null;
  const h24 = mer === "MN" ? 0 : mer === "NN" ? 12 : mer === "AM" ? h % 12 : (h % 12) + 12;
  return `${String(h24).padStart(2, "0")}:${min}`;
}

/** Parses "8:00 AM, 2 PM, 20:00" → ["08:00","14:00","20:00"] (sorted, unique) or an error message. */
export function parsePrescribedTimes(raw: string): { ok: true; times: string[] } | { ok: false; error: string } {
  const out: string[] = [];
  for (const chunk of raw
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const whole = parseOneTime(chunk);
    if (whole) {
      out.push(whole);
      continue;
    }
    // "08:00 14:00 20:00" or "8AM 2PM": several times separated only by spaces.
    const tokens = chunk.replace(/\s+(AM|PM|A\.M\.?|P\.M\.?|NN|MN)\b/gi, "$1").split(/\s+/);
    for (const tok of tokens) {
      const one = parseOneTime(tok);
      if (!one) {
        const hint = /^\d{1,2}(:\d{2})?$/.test(tok) ? " Add AM or PM (e.g. 8:00 AM)." : " Use a time like 8:00 AM or 2:00 PM.";
        return { ok: false, error: `“${tok}” is not a time.${hint}` };
      }
      out.push(one);
    }
  }
  const times = [...new Set(out)].sort();
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
      const m = H24_RE.exec(t);
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

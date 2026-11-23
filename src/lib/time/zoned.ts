/**
 * Timezone primitives. All stored timestamps are UTC instants; every
 * hospital-facing interpretation (shift, operational date, calendar date)
 * is computed in an explicit IANA timezone — by default `Asia/Manila`.
 *
 * No third-party date library: `Intl.DateTimeFormat` carries the tz database,
 * and these helpers are small enough to test exhaustively.
 */

export const HOSPITAL_TZ = "Asia/Manila";

/** Calendar date in `YYYY-MM-DD` form. Never contains a time or offset. */
export type IsoDate = string;

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function assertValidInstant(instant: Date): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError("Invalid instant");
  }
}

/** Wall-clock parts of `instant` as observed in `tz`. */
export function toLocalParts(instant: Date, tz: string = HOSPITAL_TZ): LocalParts {
  assertValidInstant(instant);
  const out: Partial<Record<string, number>> = {};
  for (const p of partsFormatter(tz).formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour === 24 ? 0 : out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (Manila = +8h). */
export function tzOffsetMs(instant: Date, tz: string = HOSPITAL_TZ): number {
  const p = toLocalParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/**
 * Converts a wall-clock time in `tz` to a UTC instant.
 * For wall times skipped by a DST transition the later valid instant is used;
 * for repeated wall times the earlier instant is used. Asia/Manila has no DST,
 * but the function is correct for any IANA zone (see unit tests).
 */
export function zonedWallTimeToUtc(parts: Pick<LocalParts, "year" | "month" | "day"> & Partial<LocalParts>, tz: string = HOSPITAL_TZ): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  const offset1 = tzOffsetMs(new Date(wall), tz);
  let candidate = wall - offset1;
  const offset2 = tzOffsetMs(new Date(candidate), tz);
  if (offset2 !== offset1) {
    const alt = wall - offset2;
    // Prefer the candidate whose local wall time round-trips exactly.
    const roundTrips = (t: number) => {
      const p = toLocalParts(new Date(t), tz);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wall;
    };
    if (roundTrips(alt) && (!roundTrips(candidate) || alt < candidate)) candidate = alt;
    else if (!roundTrips(candidate)) candidate = Math.max(candidate, alt);
  }
  return new Date(candidate);
}

export function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid ISO date: ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`Impossible calendar date: ${date}`);
  }
  return { year, month, day };
}

export function formatIsoDate(p: { year: number; month: number; day: number }): IsoDate {
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Pure calendar arithmetic (no timezone involved). */
export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatIsoDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function calendarDateOf(instant: Date, tz: string = HOSPITAL_TZ): IsoDate {
  return formatIsoDate(toLocalParts(instant, tz));
}

/** Half-open window [start, end) for a calendar day in `tz`. */
export function calendarDayWindow(date: IsoDate, tz: string = HOSPITAL_TZ): { start: Date; end: Date } {
  const start = zonedWallTimeToUtc(parseIsoDate(date), tz);
  const end = zonedWallTimeToUtc(parseIsoDate(addDays(date, 1)), tz);
  return { start, end };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/*
 * Formatting is built from numeric parts rather than locale strings so the
 * server and every browser produce byte-identical output (no ICU drift, no
 * hydration mismatch). 24-hour clock, hospital timezone always explicit.
 */

/** e.g. "22 Nov 2026, 14:05" */
export function formatDateTime(instant: Date, tz: string = HOSPITAL_TZ): string {
  const p = toLocalParts(instant, tz);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** e.g. "14:05" */
export function formatTime(instant: Date, tz: string = HOSPITAL_TZ): string {
  const p = toLocalParts(instant, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** e.g. "22 Nov, 14:05" */
export function formatDayTime(instant: Date, tz: string = HOSPITAL_TZ): string {
  const p = toLocalParts(instant, tz);
  return `${p.day} ${MONTHS[p.month - 1]}, ${pad2(p.hour)}:${pad2(p.minute)}`;
}

function weekdayOf(date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** e.g. "Sunday, 22 November 2026" */
export function formatLongDate(date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return `${weekdayOf(date)}, ${day} ${MONTHS_LONG[month - 1]} ${year}`;
}

/** e.g. "22 Nov 2026" */
export function formatShortDate(date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** e.g. "Sun 22 Nov" */
export function formatCompactDate(date: IsoDate): string {
  const { month, day } = parseIsoDate(date);
  return `${weekdayOf(date).slice(0, 3)} ${day} ${MONTHS[month - 1]}`;
}

export function monthShortName(month: number): string {
  return MONTHS[month - 1];
}

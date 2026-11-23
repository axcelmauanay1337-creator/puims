/**
 * Reporting periods (PRODUCT_REQUIREMENTS §13). A period is a run of whole days; each day is either an
 * operational day (06:00–06:00) or a calendar day (00:00–24:00) in Asia/Manila. Weeks start on Monday.
 * Pure: the same rules are used by the report screen, CSV exports and tests.
 */
import { operationalDayWindow } from "@/lib/time/shifts";
import { addDays, calendarDayWindow, formatIsoDate, parseIsoDate, type IsoDate } from "@/lib/time/zoned";

export type Period = "day" | "week" | "month" | "year";
export type DayMode = "operational" | "calendar";
export const PERIODS: readonly Period[] = ["day", "week", "month", "year"];

export interface PeriodBounds {
  period: Period;
  mode: DayMode;
  firstDay: IsoDate;
  lastDay: IsoDate; // inclusive
  days: number;
  start: Date;
  end: Date; // exclusive
  label: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function weekday0Mon(d: IsoDate): number {
  const { year, month, day } = parseIsoDate(d);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}
function daysBetween(a: IsoDate, b: IsoDate): number {
  const x = parseIsoDate(a);
  const y = parseIsoDate(b);
  return Math.round((Date.UTC(y.year, y.month - 1, y.day) - Date.UTC(x.year, x.month - 1, x.day)) / 86_400_000);
}

export function dayWindow(mode: DayMode, d: IsoDate) {
  return mode === "operational" ? operationalDayWindow(d) : calendarDayWindow(d);
}

export function periodBounds(period: Period, mode: DayMode, anchor: IsoDate): PeriodBounds {
  const { year, month } = parseIsoDate(anchor);
  let firstDay: IsoDate;
  let lastDay: IsoDate;
  let label: string;
  switch (period) {
    case "day":
      firstDay = lastDay = anchor;
      label = anchor;
      break;
    case "week":
      firstDay = addDays(anchor, -weekday0Mon(anchor));
      lastDay = addDays(firstDay, 6);
      label = `Week of ${firstDay}`;
      break;
    case "month":
      firstDay = formatIsoDate({ year, month, day: 1 });
      lastDay = addDays(month === 12 ? formatIsoDate({ year: year + 1, month: 1, day: 1 }) : formatIsoDate({ year, month: month + 1, day: 1 }), -1);
      label = `${MONTHS[month - 1]} ${year}`;
      break;
    case "year":
      firstDay = formatIsoDate({ year, month: 1, day: 1 });
      lastDay = formatIsoDate({ year, month: 12, day: 31 });
      label = String(year);
      break;
  }
  return {
    period,
    mode,
    firstDay,
    lastDay,
    days: daysBetween(firstDay, lastDay) + 1,
    start: dayWindow(mode, firstDay).start,
    end: dayWindow(mode, lastDay).end,
    label: `${label} · ${mode === "operational" ? "operational days (06:00–06:00)" : "calendar days (00:00–24:00)"}`,
  };
}

/** The anchor for the previous / next period. */
export function shiftPeriod(period: Period, anchor: IsoDate, dir: -1 | 1): IsoDate {
  const { year, month } = parseIsoDate(anchor);
  switch (period) {
    case "day":
      return addDays(anchor, dir);
    case "week":
      return addDays(anchor, 7 * dir);
    case "month": {
      const m = month + dir;
      return formatIsoDate({ year: m < 1 ? year - 1 : m > 12 ? year + 1 : year, month: ((m + 11) % 12) + 1, day: 1 });
    }
    case "year":
      return formatIsoDate({ year: year + dir, month: 1, day: 1 });
  }
}

/** Rate as a percentage with one decimal, or null when the denominator is zero (never shown as 0%). */
export function rate(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

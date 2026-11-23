/**
 * Shift and operational-day rules (ARCHITECTURE_AND_OFFLINE_DESIGN.md §9).
 *
 *   Morning    06:00 (incl) – 14:00 (excl)
 *   Afternoon  14:00 (incl) – 22:00 (excl)
 *   Night      22:00 (incl) – 06:00 next day (excl)
 *
 * The operational date changes at 06:00 local time. An event at 00:00–05:59
 * belongs to the night shift of the PREVIOUS operational date.
 *
 * The server is authoritative for classification. Clients may show the same
 * computation as a provisional label and must reconcile on sync.
 */
import { HOSPITAL_TZ, type IsoDate, addDays, formatIsoDate, parseIsoDate, toLocalParts, zonedWallTimeToUtc } from "./zoned";

export type ShiftCode = "MORNING" | "AFTERNOON" | "NIGHT";

export const SHIFT_ORDER: readonly ShiftCode[] = ["MORNING", "AFTERNOON", "NIGHT"] as const;

export const OPERATIONAL_DAY_START_HOUR = 6;

export const SHIFT_DEFINITIONS: Record<ShiftCode, { label: string; startHour: number; endHour: number; rangeLabel: string }> = {
  MORNING: { label: "Morning", startHour: 6, endHour: 14, rangeLabel: "06:00–14:00" },
  AFTERNOON: { label: "Afternoon", startHour: 14, endHour: 22, rangeLabel: "14:00–22:00" },
  NIGHT: { label: "Night", startHour: 22, endHour: 6, rangeLabel: "22:00–06:00" },
};

export interface InstantClassification {
  shift: ShiftCode;
  /** 06:00–06:00 reporting day the event belongs to. */
  operationalDate: IsoDate;
  /** Ordinary midnight-to-midnight local date. */
  calendarDate: IsoDate;
  /** Local wall-clock time, `HH:MM:SS`. */
  localTime: string;
  timeZone: string;
}

export function shiftForLocalHour(hour: number): ShiftCode {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError(`Invalid hour: ${hour}`);
  if (hour >= 6 && hour < 14) return "MORNING";
  if (hour >= 14 && hour < 22) return "AFTERNOON";
  return "NIGHT";
}

export function classifyInstant(instant: Date, tz: string = HOSPITAL_TZ): InstantClassification {
  const p = toLocalParts(instant, tz);
  const calendarDate = formatIsoDate(p);
  const operationalDate = p.hour < OPERATIONAL_DAY_START_HOUR ? addDays(calendarDate, -1) : calendarDate;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    shift: shiftForLocalHour(p.hour),
    operationalDate,
    calendarDate,
    localTime: `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`,
    timeZone: tz,
  };
}

/** Half-open window [start, end) for an operational day: 06:00 → 06:00 next day. */
export function operationalDayWindow(operationalDate: IsoDate, tz: string = HOSPITAL_TZ): { start: Date; end: Date } {
  const d = parseIsoDate(operationalDate);
  const next = parseIsoDate(addDays(operationalDate, 1));
  return {
    start: zonedWallTimeToUtc({ ...d, hour: OPERATIONAL_DAY_START_HOUR }, tz),
    end: zonedWallTimeToUtc({ ...next, hour: OPERATIONAL_DAY_START_HOUR }, tz),
  };
}

/** Half-open window [start, end) for one shift of an operational date. */
export function shiftWindow(operationalDate: IsoDate, shift: ShiftCode, tz: string = HOSPITAL_TZ): { start: Date; end: Date } {
  const def = SHIFT_DEFINITIONS[shift];
  const d = parseIsoDate(operationalDate);
  const next = parseIsoDate(addDays(operationalDate, 1));
  const start = zonedWallTimeToUtc({ ...d, hour: def.startHour }, tz);
  const endDay = shift === "NIGHT" ? next : d;
  const end = zonedWallTimeToUtc({ ...endDay, hour: def.endHour }, tz);
  return { start, end };
}

export function isWithin(instant: Date, window: { start: Date; end: Date }): boolean {
  const t = instant.getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

/** The shift that follows `shift` (used for handover). */
export function nextShift(operationalDate: IsoDate, shift: ShiftCode): { operationalDate: IsoDate; shift: ShiftCode } {
  if (shift === "MORNING") return { operationalDate, shift: "AFTERNOON" };
  if (shift === "AFTERNOON") return { operationalDate, shift: "NIGHT" };
  return { operationalDate: addDays(operationalDate, 1), shift: "MORNING" };
}

export function previousShift(operationalDate: IsoDate, shift: ShiftCode): { operationalDate: IsoDate; shift: ShiftCode } {
  if (shift === "NIGHT") return { operationalDate, shift: "AFTERNOON" };
  if (shift === "AFTERNOON") return { operationalDate, shift: "MORNING" };
  return { operationalDate: addDays(operationalDate, -1), shift: "NIGHT" };
}

export { formatIsoDate };

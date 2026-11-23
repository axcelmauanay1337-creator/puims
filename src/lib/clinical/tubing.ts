/**
 * Change of tubing (ventilator circuit) due-status (PRODUCT_REQUIREMENTS.md §7).
 *
 * The software only computes when the NEXT replacement is due from an
 * explicitly documented installation/replacement event. It never marks a
 * replacement as completed — that requires an authenticated RT to document it.
 *
 * POLICY-PENDING (see docs/00-MILESTONE-0-PLAN.md, U-04): the 7-day interval and
 * the "upcoming" / "due" windows below are placeholders until infection
 * prevention, manufacturer instructions and hospital policy confirm them.
 */
import { classifyInstant } from "@/lib/time/shifts";
import { HOSPITAL_TZ } from "@/lib/time/zoned";

export interface TubingPolicy {
  /** Replacement interval in days. Default 7; configurable only by Chief RT admin. */
  intervalDays: number;
  /** Hours before the due instant at which an item becomes "upcoming". */
  upcomingWindowHours: number;
}

export const DEFAULT_TUBING_POLICY: TubingPolicy = {
  intervalDays: 7,
  upcomingWindowHours: 48,
};

/**
 *  NO_RECORD – active encounter with no documented installation (needs attention)
 *  CURRENT   – next due is beyond the upcoming window
 *  UPCOMING  – due within `upcomingWindowHours`, but on a later operational day
 *  DUE       – due later in the CURRENT operational day (06:00–06:00)
 *  OVERDUE   – the due instant has passed with no newer documented replacement
 */
export type TubingStatus = "NO_RECORD" | "CURRENT" | "UPCOMING" | "DUE" | "OVERDUE";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function validatePolicy(policy: TubingPolicy): void {
  if (!Number.isInteger(policy.intervalDays) || policy.intervalDays < 1 || policy.intervalDays > 60) {
    throw new RangeError("intervalDays must be an integer between 1 and 60");
  }
  if (!Number.isFinite(policy.upcomingWindowHours) || policy.upcomingWindowHours < 0) {
    throw new RangeError("upcomingWindowHours must be >= 0");
  }
}

/**
 * next_due = installed_at + interval_days × 24h. This matches the starter
 * schema's generated column for a fixed-offset zone such as Asia/Manila.
 */
export function computeNextDue(installedAt: Date, intervalDays: number): Date {
  if (!Number.isInteger(intervalDays) || intervalDays < 1) throw new RangeError("intervalDays must be a positive integer");
  return new Date(installedAt.getTime() + intervalDays * DAY);
}

export interface TubingAssessment {
  status: TubingStatus;
  nextDueAt: Date | null;
  /** Positive = time remaining; negative = time overdue. */
  msUntilDue: number | null;
}

export function assessTubing(
  lastInstalledAt: Date | null,
  now: Date,
  policy: TubingPolicy = DEFAULT_TUBING_POLICY,
  tz: string = HOSPITAL_TZ,
): TubingAssessment {
  validatePolicy(policy);
  return assessFromDue(lastInstalledAt ? computeNextDue(lastInstalledAt, policy.intervalDays) : null, now, policy, tz);
}

/**
 * Status from a stored due instant (the database keeps next_due_at per documented
 * event, using the interval in force when it was documented).
 */
export function assessFromDue(nextDueAt: Date | null, now: Date, policy: TubingPolicy = DEFAULT_TUBING_POLICY, tz: string = HOSPITAL_TZ): TubingAssessment {
  validatePolicy(policy);
  if (!nextDueAt) return { status: "NO_RECORD", nextDueAt: null, msUntilDue: null };
  const msUntilDue = nextDueAt.getTime() - now.getTime();
  let status: TubingStatus;
  if (msUntilDue <= 0) status = "OVERDUE";
  else if (classifyInstant(nextDueAt, tz).operationalDate === classifyInstant(now, tz).operationalDate) status = "DUE";
  else if (msUntilDue <= policy.upcomingWindowHours * HOUR) status = "UPCOMING";
  else status = "CURRENT";
  return { status, nextDueAt, msUntilDue };
}

export function describeDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / HOUR);
  const minutes = Math.floor((abs % HOUR) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

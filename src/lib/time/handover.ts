import { classifyInstant, nextShift, previousShift, type ShiftCode } from "./shifts";
import type { IsoDate } from "./zoned";

export interface ShiftRef {
  operationalDate: IsoDate;
  shift: ShiftCode;
}

/**
 * Shifts a handover may be written for at `now`: the CURRENT shift (written near
 * its end) and the shift that JUST ENDED (written late, e.g. after a busy change-over).
 * Never a future shift, never older ones. One handover per shift (decision U-11).
 */
export function handoverableShifts(now: Date): ShiftRef[] {
  const c = classifyInstant(now);
  return [{ operationalDate: c.operationalDate, shift: c.shift }, previousShift(c.operationalDate, c.shift)];
}

export function isHandoverable(ref: ShiftRef, now: Date): boolean {
  return handoverableShifts(now).some((s) => s.operationalDate === ref.operationalDate && s.shift === ref.shift);
}

/** The shift that receives the handover written for `ref`. */
export function receivingShift(ref: ShiftRef): ShiftRef {
  return nextShift(ref.operationalDate, ref.shift);
}

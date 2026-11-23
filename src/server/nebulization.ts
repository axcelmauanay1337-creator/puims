import "server-only";
import { expectedSlots, orderEnd } from "@/lib/clinical/nebSlots";
import type { NebulizationStatus, PatientCategory } from "@/lib/clinical/vocabulary";
import type { Tx } from "./db";

/**
 * The nebulization worklist for a window: documented outcomes (stored) merged with
 * expected slots derived from the times written on active orders (NOT stored).
 * An expected slot is "SCHEDULED" until its time, then "PENDING" (awaiting documentation).
 */

export interface NebRow {
  key: string;
  documented: boolean;
  id: string | null; // neb_administration id when documented
  orderId: string;
  orderReference: string;
  medication: string;
  frequency: string;
  prescriber: string;
  scheduledIso: string | null;
  actualIso: string | null;
  status: NebulizationStatus;
  performedBy: string | null;
  performedById: string | null;
  reason: string | null;
  patient: { id: string; name: string; hospitalId: string; category: PatientCategory; wardRoom: string | null };
}

interface OrderRow {
  id: string;
  order_reference: string;
  medication: string;
  frequency: string;
  prescriber: string;
  prescribed_times: string[];
  start_at: Date;
  end_at: Date | null;
  discontinued_at: Date | null;
  p_id: string;
  p_name: string;
  p_hid: string | null;
  p_cat: PatientCategory;
  p_ward: string | null;
}

export async function nebRows(c: Tx, window: { start: Date; end: Date }, now: Date): Promise<NebRow[]> {
  const orders = await c.query<OrderRow>(
    `SELECT o.id, o.order_reference, o.medication_as_ordered AS medication, o.frequency, o.prescriber, o.prescribed_times::text[] AS prescribed_times,
            o.start_at, o.end_at, o.discontinued_at,
            p.id AS p_id, p.full_name AS p_name, p.hospital_patient_id AS p_hid, p.category AS p_cat, p.ward_room AS p_ward
       FROM neb_order o JOIN patient p ON p.id = o.patient_id
      WHERE p.voided_at IS NULL AND o.start_at < $2
        AND coalesce(least(o.end_at, o.discontinued_at), o.end_at, o.discontinued_at, 'infinity'::timestamptz) > $1`,
    [window.start, window.end],
  );
  const docs = await c.query<{
    id: string;
    order_id: string;
    scheduled_at: Date | null;
    actual_at: Date | null;
    status: NebulizationStatus;
    performed_by: string | null;
    by_name: string | null;
    reason: string | null;
    order_reference: string;
    medication: string;
    frequency: string;
    prescriber: string;
    p_id: string;
    p_name: string;
    p_hid: string | null;
    p_cat: PatientCategory;
    p_ward: string | null;
  }>(
    `SELECT a.id, a.order_id, a.scheduled_at, a.actual_at, a.status, a.performed_by, st.display_name AS by_name, a.reason,
            o.order_reference, o.medication_as_ordered AS medication, o.frequency, o.prescriber,
            p.id AS p_id, p.full_name AS p_name, p.hospital_patient_id AS p_hid, p.category AS p_cat, p.ward_room AS p_ward
       FROM neb_administration a JOIN neb_order o ON o.id = a.order_id JOIN patient p ON p.id = a.patient_id
       LEFT JOIN staff st ON st.id = a.performed_by
      WHERE a.voided_at IS NULL AND coalesce(a.scheduled_at, a.actual_at) >= $1 AND coalesce(a.scheduled_at, a.actual_at) < $2`,
    [window.start, window.end],
  );
  const patient = (r: { p_id: string; p_name: string; p_hid: string | null; p_cat: PatientCategory; p_ward: string | null }) => ({
    id: r.p_id,
    name: r.p_name,
    hospitalId: r.p_hid ?? "No hospital no.",
    category: r.p_cat,
    wardRoom: r.p_ward,
  });
  const rows: NebRow[] = docs.rows.map((d) => ({
    key: d.id,
    documented: true,
    id: d.id,
    orderId: d.order_id,
    orderReference: d.order_reference,
    medication: d.medication,
    frequency: d.frequency,
    prescriber: d.prescriber,
    scheduledIso: d.scheduled_at ? new Date(d.scheduled_at).toISOString() : null,
    actualIso: d.actual_at ? new Date(d.actual_at).toISOString() : null,
    status: d.status,
    performedBy: d.by_name,
    performedById: d.performed_by,
    reason: d.reason,
    patient: patient(d),
  }));
  const documentedSlots = new Set(docs.rows.filter((d) => d.scheduled_at).map((d) => `${d.order_id}|${new Date(d.scheduled_at!).toISOString()}`));
  for (const o of orders.rows) {
    const slots = expectedSlots(
      {
        prescribedTimes: o.prescribed_times,
        startAt: new Date(o.start_at),
        endAt: o.end_at ? new Date(o.end_at) : null,
        discontinuedAt: o.discontinued_at ? new Date(o.discontinued_at) : null,
      },
      window,
    );
    for (const at of slots) {
      const iso = at.toISOString();
      if (documentedSlots.has(`${o.id}|${iso}`)) continue;
      rows.push({
        key: `${o.id}|${iso}`,
        documented: false,
        id: null,
        orderId: o.id,
        orderReference: o.order_reference,
        medication: o.medication,
        frequency: o.frequency,
        prescriber: o.prescriber,
        scheduledIso: iso,
        actualIso: null,
        status: at.getTime() > now.getTime() ? "SCHEDULED" : "PENDING",
        performedBy: null,
        performedById: null,
        reason: null,
        patient: patient(o),
      });
    }
  }
  return rows.sort((a, b) => (a.scheduledIso ?? a.actualIso ?? "").localeCompare(b.scheduledIso ?? b.actualIso ?? ""));
}

export function isOrderActive(o: { end_at: Date | null; discontinued_at: Date | null }, now: Date): boolean {
  const end = orderEnd({ endAt: o.end_at, discontinuedAt: o.discontinued_at });
  return !end || end > now;
}

"use server";

import { revalidatePath } from "next/cache";
import { ClinicalError, requireSession } from "@/server/clinical";
import { AuthenticationError } from "@/server/session";
import {
  discontinueAllNebs,
  endNiv,
  postCharges,
  saveEquipment,
  setPatientMgh,
  startNiv,
  updatePatientFlags,
  type EquipmentInput,
  type NivInput,
  type PatientFlags,
} from "@/server/workspace";

export type WsResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function wrap<T>(fn: () => Promise<T>, paths: string[]): Promise<WsResult<T>> {
  try {
    const data = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ClinicalError) return { ok: false, error: e.message };
    if (e instanceof AuthenticationError) return { ok: false, error: "Your session has ended. Sign in again." };
    return { ok: false, error: "Could not save. Nothing was changed." };
  }
}

export async function updatePatientFlagsAction(patientId: string, flags: PatientFlags) {
  return wrap(
    async () => updatePatientFlags(await requireSession(), patientId, flags),
    ["/", "/patients", `/patients/${patientId}`, "/nebulization", "/handover"],
  );
}
export async function startNivAction(input: NivInput) {
  return wrap(async () => startNiv(await requireSession(), input), ["/", "/ventilation", "/equipment", `/patients/${input.patientId}`]);
}
export async function endNivAction(id: string, reason: string) {
  return wrap(async () => endNiv(await requireSession(), id, reason), ["/", "/ventilation", "/equipment"]);
}
export async function saveEquipmentAction(input: EquipmentInput) {
  return wrap(async () => saveEquipment(await requireSession(), input), ["/equipment", "/charges"]);
}
export async function postChargesAction(date: string, patientIds: string[]) {
  return wrap(async () => postCharges(await requireSession(), date, patientIds), ["/charges"]);
}

export async function setPatientMghAction(patientId: string, mgh: boolean) {
  return wrap(
    async () => setPatientMgh(await requireSession(), patientId, mgh),
    ["/", "/patients", `/patients/${patientId}`, "/nebulization", "/notifications", "/handover"],
  );
}
export async function discontinueAllNebsAction(patientId: string, reason: string) {
  return wrap(
    async () => discontinueAllNebs(await requireSession(), patientId, reason),
    ["/", `/patients/${patientId}`, "/nebulization", "/notifications", "/handover"],
  );
}

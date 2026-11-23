"use server";

import { revalidatePath } from "next/cache";
import { ClinicalError, requireSession } from "@/server/clinical";
import {
  discontinueNebOrder,
  disconnect,
  recordVentSetting,
  voidVentSetting,
  type VentSettingInput,
  documentNebulization,
  documentTubing,
  enterNebOrder,
  hookIn,
  voidNebulization,
  voidTubing,
  type HookInInput,
  type NebDocInput,
  type NebOrderInput,
  type TubingInput,
  type WriteResult,
} from "@/server/documentation";
import { AuthenticationError } from "@/server/session";

export type DocResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function wrap<T>(fn: () => Promise<T>, paths: string[]): Promise<DocResult<T>> {
  try {
    const data = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ClinicalError) return { ok: false, error: e.message };
    if (e instanceof AuthenticationError) return { ok: false, error: "Your session has ended. Sign in again — nothing was saved." };
    return { ok: false, error: "Could not save. Nothing was recorded." };
  }
}

const NEB = ["/nebulization", "/", "/activities", "/handover"];
const VENT = ["/ventilation", "/tubing", "/", "/activities", "/handover"];

export async function enterNebOrderAction(input: NebOrderInput): Promise<DocResult<WriteResult>> {
  return wrap(async () => enterNebOrder(await requireSession(), input), NEB);
}
export async function discontinueNebOrderAction(orderId: string, reason: string): Promise<DocResult> {
  return wrap(async () => discontinueNebOrder(await requireSession(), orderId, reason), NEB);
}
export async function documentNebulizationAction(input: NebDocInput): Promise<DocResult<WriteResult>> {
  return wrap(async () => documentNebulization(await requireSession(), input), NEB);
}
export async function voidNebulizationAction(id: string, reason: string): Promise<DocResult> {
  return wrap(async () => voidNebulization(await requireSession(), id, reason), NEB);
}
export async function hookInAction(input: HookInInput): Promise<DocResult<WriteResult>> {
  return wrap(async () => hookIn(await requireSession(), input), VENT);
}
export async function disconnectAction(encounterId: string, at: string, reason?: string, note?: string): Promise<DocResult> {
  return wrap(async () => disconnect(await requireSession(), encounterId, at, reason, note), VENT);
}
export async function documentTubingAction(input: TubingInput): Promise<DocResult<WriteResult>> {
  return wrap(async () => documentTubing(await requireSession(), input), VENT);
}
export async function voidTubingAction(id: string, reason: string): Promise<DocResult> {
  return wrap(async () => voidTubing(await requireSession(), id, reason), VENT);
}

export async function ventSettingAction(input: VentSettingInput): Promise<DocResult<WriteResult>> {
  return wrap(async () => recordVentSetting(await requireSession(), input), VENT);
}
export async function voidVentSettingAction(id: string, reason: string): Promise<DocResult> {
  return wrap(async () => voidVentSetting(await requireSession(), id, reason), VENT);
}

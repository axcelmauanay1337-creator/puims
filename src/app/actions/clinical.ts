"use server";

import { revalidatePath } from "next/cache";
import {
  acknowledgeHandover,
  assignShift,
  ClinicalError,
  correctPatient,
  createHandover,
  registerPatient,
  requireSession,
  removeAssignment,
  type CorrectResult,
  type HandoverInput,
  type PatientInput,
  type RegisterResult,
} from "@/server/clinical";
import { AuthenticationError } from "@/server/session";

export type ActionResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function wrap<T>(fn: () => Promise<T>, paths: string[]): Promise<ActionResult<T>> {
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

export async function registerPatientAction(input: PatientInput, confirmedDistinctFrom: string[]): Promise<ActionResult<RegisterResult>> {
  return wrap(() => requireSession().then((s) => registerPatient(s, input, confirmedDistinctFrom)), ["/patients"]);
}

export async function correctPatientAction(id: string, expectedUpdatedAt: string, input: PatientInput, reason: string): Promise<ActionResult<CorrectResult>> {
  return wrap(() => requireSession().then((s) => correctPatient(s, id, expectedUpdatedAt, input, reason)), ["/patients", `/patients/${id}`]);
}

export async function assignShiftAction(date: string, shift: string, staffId: string): Promise<ActionResult> {
  return wrap(() => requireSession().then((s) => assignShift(s, date, shift, staffId)), ["/shifts", "/"]);
}

export async function removeAssignmentAction(id: string, reason: string): Promise<ActionResult> {
  return wrap(() => requireSession().then((s) => removeAssignment(s, id, reason)), ["/shifts", "/"]);
}

export async function createHandoverAction(input: HandoverInput): Promise<ActionResult<{ id: string }>> {
  return wrap(() => requireSession().then((s) => createHandover(s, input)), ["/handover", "/"]);
}

export async function acknowledgeHandoverAction(id: string): Promise<ActionResult> {
  return wrap(() => requireSession().then((s) => acknowledgeHandover(s, id)), ["/handover", "/"]);
}

"use server";

import { revalidatePath } from "next/cache";
import type { DiagnosticStatus } from "@/lib/clinical/vocabulary";
import { ClinicalError, requireSession } from "@/server/clinical";
import {
  bookAppointment,
  correctAppointment,
  rescheduleAppointment,
  updateAppointmentStatus,
  voidAppointment,
  type BookingInput,
  type CorrectionInput,
} from "@/server/diagnostics";
import {
  acceptCleanRows,
  commitBatch,
  decideRow,
  discardBatch,
  dryRun,
  rowCandidates,
  updateMapping,
  updateOptions,
  voidBatch,
  type RowDecision,
} from "@/server/importer";
import {
  addSignatory,
  completeSignatory,
  decideProposal,
  amendPft,
  createPftForm,
  createTemplateVersion,
  deactivateSignatory,
  finalizePft,
  savePftDraft,
  signPftAsRt,
  voidPftForm,
  type PftDraft,
} from "@/server/pft";
import { hasRecentReauth } from "@/server/auth/service";
import { AuthenticationError } from "@/server/session";

/** Compatible with AdminResult so the step-up dialog (useSensitiveAction) can drive these actions. */
export type ActResult<T = undefined> = { ok: true; message?: string; data?: T } | { ok: false; reauth?: boolean; error: string; detail?: unknown };

async function wrap<T>(fn: () => Promise<T>, paths: string[], message?: string): Promise<ActResult<T>> {
  try {
    const data = await fn();
    for (const p of paths) revalidatePath(p, "layout");
    return { ok: true, data, message };
  } catch (e) {
    if (e instanceof ClinicalError) return { ok: false, reauth: e.kind === "REAUTH_REQUIRED", error: e.message, detail: e.detail };
    if (e instanceof AuthenticationError) return { ok: false, error: "Your session has ended. Sign in again — nothing was saved." };
    return { ok: false, error: "Could not save. Nothing was recorded." };
  }
}

const DX = ["/diagnostics", "/", "/handover"];

// ---------------------------------------------------------------- scheduling
export async function bookAction(input: BookingInput) {
  return wrap(async () => bookAppointment(await requireSession(), input), DX, "Appointment booked.");
}
export async function statusAction(id: string, status: DiagnosticStatus, reason: string) {
  return wrap(async () => updateAppointmentStatus(await requireSession(), id, { status, reason }), DX, "Status updated.");
}
export async function rescheduleAction(id: string, clientId: string, scheduledAt: string, reason: string) {
  return wrap(async () => rescheduleAppointment(await requireSession(), id, { clientId, scheduledAt, reason }), DX, "Rescheduled.");
}
export async function correctAppointmentAction(id: string, input: CorrectionInput) {
  return wrap(async () => correctAppointment(await requireSession(), id, input), DX, "Appointment corrected.");
}
export async function voidAppointmentAction(id: string, reason: string) {
  return wrap(async () => voidAppointment(await requireSession(), id, reason), DX, "Appointment voided.");
}

// ---------------------------------------------------------------- PFT form
export async function createPftAction(clientId: string, appointmentId: string) {
  return wrap(async () => createPftForm(await requireSession(), { clientId, appointmentId }), DX);
}
export async function savePftAction(id: string, expectedUpdatedIso: string, draft: Partial<PftDraft>) {
  return wrap(async () => savePftDraft(await requireSession(), id, expectedUpdatedIso, draft), [`/diagnostics/pft/forms/${id}`], "Draft saved.");
}
export async function signPftAction(id: string, expectedUpdatedIso: string) {
  return wrap(async () => signPftAsRt(await requireSession(), id, expectedUpdatedIso), DX, "Signed. The form content is now locked.");
}
export async function finalizePftAction(
  id: string,
  pulmoSignatoryId: string,
  interpretation: string,
  attestWetSignature: boolean,
  method: "WET_SIGNATURE_ON_PRINTED_COPY" | "E_SIGNATURE_APPLIED_BY_RT" = "WET_SIGNATURE_ON_PRINTED_COPY",
) {
  return wrap(
    async () => finalizePft(await requireSession(), id, { pulmoSignatoryId, interpretation, attestWetSignature, method }),
    DX,
    "Finalized as the official record.",
  );
}
export async function amendPftAction(id: string, clientId: string, section: string, text: string, reason: string) {
  return wrap(async () => amendPft(await requireSession(), id, { clientId, section, text, reason }), [`/diagnostics/pft/forms/${id}`], "Amendment added.");
}
export async function voidPftAction(id: string, reason: string) {
  return wrap(async () => voidPftForm(await requireSession(), id, reason), DX, "Form voided.");
}
export async function templateAction(form: FormData) {
  return wrap(
    async () => {
      const f = form.get("logo");
      const remove = form.get("removeLogo") === "on";
      const logo = f instanceof File && f.size > 0 ? Buffer.from(await f.arrayBuffer()) : remove ? "remove" : "keep";
      return createTemplateVersion(await requireSession(), {
        facilityHeader: String(form.get("facilityHeader") ?? ""),
        facilityAddress: String(form.get("facilityAddress") ?? ""),
        formRevision: String(form.get("formRevision") ?? ""),
        bronchodilatorNote: String(form.get("bronchodilatorNote") ?? ""),
        hospitalConfirmed: form.get("hospitalConfirmed") === "on",
        logo,
      });
    },
    ["/settings"],
    "New template version saved. New forms use it; existing forms keep theirs.",
  );
}

export async function addSignatoryAction(form: FormData) {
  return wrap(
    async () => {
      const f = form.get("signature");
      await addSignatory(await requireSession(), {
        kind: String(form.get("kind") ?? ""),
        displayName: String(form.get("displayName") ?? ""),
        credentials: String(form.get("credentials") ?? ""),
        staffId: String(form.get("staffId") ?? ""),
        signature: f instanceof File && f.size > 0 ? Buffer.from(await f.arrayBuffer()) : null,
      });
    },
    ["/settings"],
    "Signatory added.",
  );
}
export async function completeSignatoryAction(id: string, form: FormData) {
  return wrap(
    async () => {
      const f = form.get("signature");
      await completeSignatory(await requireSession(), id, {
        signature: f instanceof File && f.size > 0 ? Buffer.from(await f.arrayBuffer()) : null,
        staffId: String(form.get("staffId") ?? "") || undefined,
      });
    },
    ["/settings"],
    "Signatory updated.",
  );
}
export async function decideProposalAction(id: string, accept: boolean, extra: { displayName?: string; credentials?: string; staffId?: string }) {
  return wrap(
    async () => decideProposal(await requireSession(), id, { accept, ...extra }),
    ["/settings"],
    accept ? "Added to the approved directory." : "Dismissed.",
  );
}
/** Generic step-up check used before uploads that go through API routes. */
export async function confirmStepUpAction() {
  return wrap(async () => {
    const s = await requireSession();
    if (!hasRecentReauth(s)) throw new ClinicalError("REAUTH_REQUIRED", "Confirm your password and authenticator code to continue.");
  }, []);
}
export async function deactivateSignatoryAction(id: string) {
  return wrap(async () => deactivateSignatory(await requireSession(), id), ["/settings"], "Signatory deactivated.");
}

// ---------------------------------------------------------------- import
export async function mappingAction(batchId: string, sheet: string, mapping: Record<string, string>) {
  return wrap(
    async () => updateMapping(await requireSession(), batchId, sheet, mapping),
    ["/import"],
    "Mapping saved; rows re-checked. Decisions on this sheet were reset.",
  );
}
export async function optionsAction(batchId: string, o: { dateOrder: string; workbookYear: string; times24h: boolean; categoryWhenMissing: string }) {
  return wrap(async () => updateOptions(await requireSession(), batchId, o), ["/import"], "Declarations saved; all rows re-checked. Decisions were reset.");
}
export async function decideRowAction(rowId: string, d: RowDecision) {
  return wrap(async () => decideRow(await requireSession(), rowId, d), ["/import"], "Saved.");
}
export async function candidatesAction(rowId: string) {
  return wrap(async () => rowCandidates(await requireSession(), rowId), []);
}
export async function bulkAcceptAction(batchId: string, sheet: string | null) {
  return wrap(async () => acceptCleanRows(await requireSession(), batchId, sheet ?? undefined), ["/import"]);
}
export async function dryRunAction(batchId: string) {
  return wrap(async () => dryRun(await requireSession(), batchId), ["/import"]);
}
export async function commitAction(batchId: string) {
  return wrap(async () => commitBatch(await requireSession(), batchId), ["/import", ...DX, "/patients"], "Import committed.");
}
export async function reverseImportAction(batchId: string, reason: string) {
  return wrap(async () => voidBatch(await requireSession(), batchId, reason), ["/import", ...DX, "/patients"], "Import reversed.");
}
export async function discardImportAction(batchId: string, reason: string) {
  return wrap(async () => discardBatch(await requireSession(), batchId, reason), ["/import"], "Staged batch discarded and its staged values erased.");
}

/** Step-up check before downloading a retained original workbook (the download link itself re-checks). */
export async function confirmOriginalDownloadAction() {
  return wrap(async () => {
    const s = await requireSession();
    if (s.role !== "CHIEF_RT_ADMIN") throw new ClinicalError("FORBIDDEN", "Only the Chief RT can download original workbooks.");
    if (!hasRecentReauth(s)) throw new ClinicalError("REAUTH_REQUIRED", "Confirm your password and authenticator code to download the original.");
  }, []);
}

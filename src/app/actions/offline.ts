"use server";

import { revalidatePath } from "next/cache";
import { ClinicalError, requireSession } from "@/server/clinical";
import { resolveSyncEvent, setDeviceOffline } from "@/server/offline";
import { AuthenticationError } from "@/server/session";

export type OfflineResult = { ok: true; message?: string } | { ok: false; reauth?: boolean; error: string };

async function wrap(fn: () => Promise<void>, message: string): Promise<OfflineResult> {
  try {
    await fn();
    revalidatePath("/devices");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof ClinicalError) return { ok: false, reauth: e.kind === "REAUTH_REQUIRED", error: e.message };
    if (e instanceof AuthenticationError) return { ok: false, error: "Your session has ended. Sign in again." };
    return { ok: false, error: "Could not save. Nothing was changed." };
  }
}

export async function deviceOfflineAction(deviceId: string, approve: boolean) {
  return wrap(
    async () => setDeviceOffline(await requireSession(), deviceId, approve),
    approve ? "Device approved for offline capture." : "Offline approval withdrawn; its leases are revoked.",
  );
}
export async function resolveSyncAction(id: string, resolution: "APPLIED" | "NOT_APPLIED", note: string) {
  return wrap(
    async () => resolveSyncEvent(await requireSession(), id, resolution, note),
    resolution === "APPLIED" ? "Applied as documentation." : "Recorded as not applied.",
  );
}

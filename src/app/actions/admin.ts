"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { AdminError, deactivateStaff, endSession, inviteStaff, resetAccess, revokeDevice, updateSetting } from "@/server/auth/admin";
import { getSession } from "@/server/session";

export type AdminResult = { ok: true; link?: string; message?: string } | { ok: false; reauth?: boolean; error: string };

async function activationLink(token: string): Promise<string> {
  let base = process.env.PUIMS_PUBLIC_URL;
  if (!base) {
    const h = await headers();
    const host = h.get("host") ?? "localhost:3000";
    const proto = process.env.PUIMS_INSECURE_COOKIES === "true" ? "http" : "https";
    base = `${proto}://${host}`;
  }
  // Token travels in the URL fragment, which browsers never send to servers or proxies.
  return `${base.replace(/\/$/, "")}/activate#${token}`;
}

async function guarded(fn: (s: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<AdminResult>, paths: string[]): Promise<AdminResult> {
  const s = await getSession();
  if (!s) return { ok: false, error: "Your session has ended. Sign in again." };
  try {
    const r = await fn(s);
    for (const p of paths) revalidatePath(p);
    return r;
  } catch (e) {
    if (e instanceof AdminError) return { ok: false, reauth: e.kind === "REAUTH_REQUIRED", error: e.message };
    return { ok: false, error: "The change could not be saved. Nothing was changed." };
  }
}

export async function inviteAction(username: string, displayName: string): Promise<AdminResult> {
  return guarded(
    async (s) => {
      const { token } = await inviteStaff(s, { username, displayName });
      return {
        ok: true,
        link: await activationLink(token),
        message: "Account created. Give this one-time link to the RT in person or through a trusted channel.",
      };
    },
    ["/staff"],
  );
}

export async function resetAccessAction(staffId: string): Promise<AdminResult> {
  return guarded(
    async (s) => {
      const { token } = await resetAccess(s, staffId);
      return {
        ok: true,
        link: await activationLink(token),
        message: "Access reset. All their sessions were ended. They must set a new password and authenticator with this link.",
      };
    },
    ["/staff"],
  );
}

export async function deactivateAction(staffId: string): Promise<AdminResult> {
  return guarded(
    async (s) => {
      await deactivateStaff(s, staffId);
      return { ok: true, message: "Account deactivated. All of its sessions were ended immediately." };
    },
    ["/staff"],
  );
}

export async function revokeDeviceAction(deviceId: string, reason: string): Promise<AdminResult> {
  return guarded(
    async (s) => {
      await revokeDevice(s, deviceId, reason);
      return { ok: true, message: "Device revoked and its sessions ended." };
    },
    ["/devices"],
  );
}

export async function endSessionAction(sessionId: string): Promise<AdminResult> {
  return guarded(
    async (s) => {
      await endSession(s, sessionId);
      return { ok: true, message: "Session ended." };
    },
    ["/devices", "/staff"],
  );
}

export async function updateSettingAction(key: string, value: string): Promise<AdminResult> {
  return guarded(
    async (s) => {
      await updateSetting(s, key, value);
      return { ok: true, message: "Setting saved." };
    },
    ["/settings", "/tubing", "/"],
  );
}

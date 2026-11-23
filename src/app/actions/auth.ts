"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { rateLimit } from "@/server/rateLimit";
import { cookieOptions, DEVICE_COOKIE, PENDING_COOKIE, SESSION_COOKIE } from "@/server/auth/cookies";
import { requestMeta } from "@/server/auth/request";
import { beginActivation, completeActivation, loginWithPassword, reauthenticate, revokeSessionByToken } from "@/server/auth/service";
import { getSession } from "@/server/session";

export interface FormState {
  error?: string;
  problems?: string[];
}

const GENERIC = "Sign-in failed. Check your username and password. After repeated failures the account is locked for 15 minutes.";

function safeNext(raw: FormDataEntryValue | null): string {
  const s = typeof raw === "string" ? raw : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") && s.length < 200 ? s : "/";
}

async function clientKey(): Promise<string> {
  const h = await headers();
  return process.env.PUIMS_TRUST_PROXY === "true" ? (h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown") : "direct";
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const ipKey = await clientKey();
  const byIp = rateLimit(`login-ip:${ipKey}`, 30, 5 * 60_000);
  const byUser = rateLimit(`login-user:${username.trim().toLowerCase()}`, 10, 5 * 60_000);
  if (!byIp.ok || !byUser.ok) return { error: "Too many sign-in attempts. Wait a few minutes and try again." };

  const jar = await cookies();
  const result = await loginWithPassword(username, password, await requestMeta(jar.get(DEVICE_COOKIE())?.value ?? null));
  if (!result.ok) return { error: result.reason === "device_revoked" ? "This device has been revoked. Contact the Chief RT." : GENERIC };
  jar.set(DEVICE_COOKIE(), result.deviceId, cookieOptions(60 * 60 * 24 * 400));
  jar.delete(PENDING_COOKIE()); // leftover from the removed authenticator step
  jar.set(SESSION_COOKIE(), result.sessionToken, cookieOptions());
  redirect(safeNext(form.get("next")));
}

export async function logoutAction(): Promise<void> {
  await endSessionAndRedirect();
}

export async function idleLogoutAction(): Promise<void> {
  await endSessionAndRedirect("idle");
}

async function endSessionAndRedirect(reason?: "idle"): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE())?.value;
  if (token) await revokeSessionByToken(token, reason === "idle" ? "idle timeout" : "logout");
  jar.delete(SESSION_COOKIE());
  redirect(reason === "idle" ? "/login?reason=idle" : "/login?reason=signed-out");
}

export interface ActivationView {
  ok: boolean;
  username?: string;
  displayName?: string;
  purpose?: "ACTIVATE" | "RESET";
}

export async function startActivationAction(token: string): Promise<ActivationView> {
  if (!rateLimit(`activate:${await clientKey()}`, 30, 10 * 60_000).ok) return { ok: false };
  const info = await beginActivation(token);
  if (!info) return { ok: false };
  return { ok: true, username: info.username, displayName: info.displayName, purpose: info.purpose };
}

export async function completeActivationAction(token: string, password: string, confirm: string): Promise<FormState & { ok?: boolean }> {
  if (!rateLimit(`activate-complete:${await clientKey()}`, 20, 10 * 60_000).ok) return { error: "Too many attempts. Wait a few minutes." };
  if (password !== confirm) return { problems: ["The two passwords do not match."] };
  const r = await completeActivation(token, password);
  return r.ok ? { ok: true } : { problems: r.problems };
}

export async function reauthAction(password: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  if (!s) return { ok: false, error: "Your session has ended. Sign in again." };
  if (!rateLimit(`reauth:${s.staffId}`, 10, 5 * 60_000).ok) return { ok: false, error: "Too many attempts. Wait a few minutes." };
  const ok = await reauthenticate(s, password);
  return ok ? { ok: true } : { ok: false, error: "Password not accepted." };
}

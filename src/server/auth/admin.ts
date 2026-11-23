import "server-only";
import { randomToken, sha256Hex, USERNAME_RE } from "@/lib/auth/tokens";
import { audit, tx, type Tx } from "../db";
import { ACTIVATION_HOURS, hasRecentReauth, type AuthedSession } from "./service";

/**
 * Chief RT administration. Every function:
 *  1. requires the caller to be the Chief RT (checked here AND re-checked in SQL via app_is_chief()),
 *  2. requires a step-up re-authentication within the last few minutes (sensitive action),
 *  3. is audited (row triggers + an explicit app-level event).
 */

export class AdminError extends Error {
  constructor(
    public readonly kind: "FORBIDDEN" | "REAUTH_REQUIRED" | "INVALID" | "CONFLICT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

async function asChief<T>(s: AuthedSession, fn: (c: Tx) => Promise<T>, opts: { reauth?: boolean } = { reauth: true }): Promise<T> {
  if (s.role !== "CHIEF_RT_ADMIN") throw new AdminError("FORBIDDEN", "Only the Chief RT can do this.");
  if (opts.reauth !== false && !hasRecentReauth(s)) throw new AdminError("REAUTH_REQUIRED", "Confirm your password and authenticator code to continue.");
  return tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId, auth: true }, async (c) => {
    const ok = await c.query<{ ok: boolean }>("SELECT app_is_chief() AS ok");
    if (!ok.rows[0]?.ok) throw new AdminError("FORBIDDEN", "Only the Chief RT can do this.");
    return fn(c);
  });
}

async function issueToken(c: Tx, staffId: string, purpose: "ACTIVATE" | "RESET", createdBy: string): Promise<string> {
  await c.query("UPDATE auth_token SET revoked_at = now() WHERE staff_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [staffId]);
  const token = randomToken();
  await c.query("INSERT INTO auth_token (staff_id, purpose, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))", [
    staffId,
    purpose,
    sha256Hex(token),
    createdBy,
    ACTIVATION_HOURS,
  ]);
  return token;
}

/** Creates an RT account in INVITED state. Returns the one-time activation token (shown once, never stored). */
export async function inviteStaff(s: AuthedSession, input: { username: string; displayName: string }): Promise<{ staffId: string; token: string }> {
  const username = input.username.trim().toLowerCase();
  const displayName = input.displayName.trim().replace(/\s+/g, " ");
  if (!USERNAME_RE.test(username)) throw new AdminError("INVALID", "Username: 3–40 characters, lowercase letters, digits, dot, dash or underscore.");
  if (displayName.length < 1 || displayName.length > 80) throw new AdminError("INVALID", "Display name: 1–80 characters.");
  return asChief(s, async (c) => {
    const exists = await c.query("SELECT 1 FROM staff WHERE lower(username) = $1", [username]);
    if (exists.rowCount) throw new AdminError("CONFLICT", "That username is already in use.");
    // Role is fixed server-side: the Chief RT can only create Respiratory Therapist accounts.
    const r = await c.query<{ id: string }>(
      "INSERT INTO staff (username, display_name, role, status, created_by) VALUES ($1, $2, 'RESPIRATORY_THERAPIST', 'INVITED', $3) RETURNING id",
      [username, displayName, s.staffId],
    );
    const staffId = r.rows[0].id;
    const token = await issueToken(c, staffId, "ACTIVATE", s.staffId);
    await audit(c, "admin.staff_invited", { username }, { table: "staff", id: staffId });
    return { staffId, token };
  });
}

/**
 * Resets an RT's access: revokes all sessions, clears password and authenticator,
 * and issues a new activation link. Also the way to reinstate a deactivated RT.
 */
export async function resetAccess(s: AuthedSession, staffId: string): Promise<{ token: string }> {
  if (staffId === s.staffId) throw new AdminError("INVALID", "You cannot reset your own access here.");
  return asChief(s, async (c) => {
    const r = await c.query<{ role: string }>("SELECT role FROM staff WHERE id = $1 FOR UPDATE", [staffId]);
    if (!r.rows[0]) throw new AdminError("NOT_FOUND", "Staff member not found.");
    if (r.rows[0].role !== "RESPIRATORY_THERAPIST") throw new AdminError("FORBIDDEN", "Only RT accounts can be reset here.");
    await c.query("UPDATE auth_session SET revoked_at = now(), revoked_reason = 'access reset' WHERE staff_id = $1 AND revoked_at IS NULL", [staffId]);
    await c.query(
      "UPDATE auth_credential SET password_hash = NULL, totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, failed_attempts = 0, locked_until = NULL WHERE staff_id = $1",
      [staffId],
    );
    await c.query("UPDATE staff SET status = 'INVITED', deactivated_at = NULL, deactivated_by = NULL WHERE id = $1", [staffId]);
    const token = await issueToken(c, staffId, "RESET", s.staffId);
    await audit(c, "admin.access_reset", undefined, { table: "staff", id: staffId });
    return { token };
  });
}

/** Deactivates an RT: immediate — every session is revoked and RLS stops all data access. */
export async function deactivateStaff(s: AuthedSession, staffId: string): Promise<void> {
  if (staffId === s.staffId) throw new AdminError("INVALID", "You cannot deactivate your own account.");
  await asChief(s, async (c) => {
    const r = await c.query<{ role: string; status: string }>("SELECT role, status FROM staff WHERE id = $1 FOR UPDATE", [staffId]);
    if (!r.rows[0]) throw new AdminError("NOT_FOUND", "Staff member not found.");
    if (r.rows[0].role !== "RESPIRATORY_THERAPIST") throw new AdminError("FORBIDDEN", "Only RT accounts can be deactivated here.");
    if (r.rows[0].status === "DEACTIVATED") return;
    await c.query("UPDATE staff SET status = 'DEACTIVATED', deactivated_at = now(), deactivated_by = $2 WHERE id = $1", [staffId, s.staffId]);
    await c.query("UPDATE auth_session SET revoked_at = now(), revoked_reason = 'account deactivated' WHERE staff_id = $1 AND revoked_at IS NULL", [staffId]);
    await c.query("UPDATE auth_token SET revoked_at = now() WHERE staff_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [staffId]);
    await audit(c, "admin.staff_deactivated", undefined, { table: "staff", id: staffId });
  });
}

export async function revokeDevice(s: AuthedSession, deviceId: string, reason: string): Promise<void> {
  if (deviceId === s.deviceId) throw new AdminError("INVALID", "You cannot revoke the device you are using.");
  const why = reason.trim().slice(0, 200) || "revoked by Chief RT";
  await asChief(s, async (c) => {
    const r = await c.query(
      "UPDATE device SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoked_reason = $3 WHERE id = $1 AND status = 'ACTIVE'",
      [deviceId, s.staffId, why],
    );
    if (!r.rowCount) throw new AdminError("NOT_FOUND", "Device not found or already revoked.");
    await c.query("UPDATE auth_session SET revoked_at = now(), revoked_reason = 'device revoked' WHERE device_id = $1 AND revoked_at IS NULL", [deviceId]);
    await audit(c, "admin.device_revoked", { reason: why }, { table: "device", id: deviceId });
  });
}

/** Any user may end their own other sessions; the Chief RT may end anyone's. No re-auth needed (only reduces access). */
export async function endSession(s: AuthedSession, sessionId: string): Promise<void> {
  await tx({ staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, async (c) => {
    const r = await c.query(
      "UPDATE auth_session SET revoked_at = now(), revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL AND (staff_id = $2 OR app_is_chief())",
      [sessionId, s.staffId, sessionId === s.sessionId ? "logout" : "ended by user"],
    );
    if (!r.rowCount) throw new AdminError("NOT_FOUND", "Session not found.");
    await audit(c, "auth.session_ended", undefined, { table: "auth_session", id: sessionId });
  });
}

export const EDITABLE_SETTINGS = {
  "tubing.interval_days": { min: 1, max: 60, integer: true, label: "Tubing replacement interval (days)" },
  "tubing.upcoming_window_hours": { min: 0, max: 336, integer: true, label: "Tubing “upcoming” window (hours)" },
  "session.idle_minutes": { min: 2, max: 120, integer: true, label: "Sign-out after inactivity (minutes)" },
  "session.absolute_hours": { min: 1, max: 24, integer: true, label: "Maximum session length (hours)" },
} as const;
export type SettingKey = keyof typeof EDITABLE_SETTINGS;

export async function updateSetting(s: AuthedSession, key: string, raw: string): Promise<void> {
  const spec = EDITABLE_SETTINGS[key as SettingKey];
  if (!spec) throw new AdminError("INVALID", "Unknown setting.");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value))) {
    throw new AdminError("INVALID", `${spec.label}: enter a whole number from ${spec.min} to ${spec.max}.`);
  }
  await asChief(s, async (c) => {
    await c.query("UPDATE setting SET value = to_jsonb($2::numeric), updated_at = now(), updated_by = $3 WHERE key = $1", [key, value, s.staffId]);
    await audit(c, "admin.setting_changed", { key, value }, { table: "setting", id: key });
  });
}

import "server-only";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { checkPassword } from "@/lib/auth/password";
import { decryptSecret, encryptSecret, randomToken, sha256Hex, USERNAME_RE } from "@/lib/auth/tokens";
import { generateTotpSecret, totpStep, verifyTotp } from "@/lib/auth/totp";
import type { Role } from "@/lib/clinical/vocabulary";
import { audit, getSettingNumber, tx, type Tx } from "../db";

/**
 * Account-managed authentication (decision U-02): Argon2id passwords + mandatory
 * TOTP second factor, opaque server-side sessions (instant revocation), one-time
 * activation links for provisioning, lockout after repeated failures.
 *
 * All messages returned to users are deliberately generic: they never reveal
 * whether a username exists, is locked, or which factor was wrong.
 */

export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_MINUTES = 15;
export const MFA_PENDING_MINUTES = 5;
export const MAX_MFA_ATTEMPTS_PER_SESSION = 5;
export const ACTIVATION_HOURS = 72;
export const REAUTH_WINDOW_MINUTES = 5;

// OWASP-recommended Argon2id baseline: m=19 MiB, t=2, p=1.
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= argonHash("dummy-password-for-timing", ARGON));

export const hashPassword = (pw: string) => argonHash(pw, ARGON);

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
}

export interface AuthedSession {
  sessionId: string;
  staffId: string;
  deviceId: string;
  role: Role;
  username: string;
  displayName: string;
  reauthAt: Date | null;
  idleExpiresAt: Date;
}

function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${os}`;
}

async function ensureDevice(c: Tx, meta: RequestMeta): Promise<{ id: string } | { revoked: true }> {
  if (meta.deviceId && /^[0-9a-f-]{36}$/.test(meta.deviceId)) {
    const r = await c.query<{ id: string; status: string }>("SELECT id, status FROM device WHERE id = $1", [meta.deviceId]);
    if (r.rows[0]?.status === "REVOKED") return { revoked: true };
    if (r.rows[0]) {
      await c.query("UPDATE device SET last_seen_at = now() WHERE id = $1", [meta.deviceId]);
      return { id: r.rows[0].id };
    }
  }
  const r = await c.query<{ id: string }>("INSERT INTO device (label) VALUES ($1) RETURNING id", [deviceLabel(meta.userAgent)]);
  return { id: r.rows[0].id };
}

// ---------------------------------------------------------------- login step 1: password

export type PasswordResult = { ok: true; pendingToken: string; deviceId: string } | { ok: false; reason: "invalid" | "device_revoked" };

export async function loginWithPassword(username: string, password: string, meta: RequestMeta): Promise<PasswordResult> {
  const uname = username.trim().toLowerCase();
  if (!USERNAME_RE.test(uname) || password.length === 0 || password.length > 256) {
    await argonVerify(await getDummyHash(), password.slice(0, 256) || "x").catch(() => false);
    return { ok: false, reason: "invalid" };
  }
  return tx({ auth: true, deviceId: meta.deviceId }, async (c) => {
    const r = await c.query<{ id: string; password_hash: string | null; totp_enabled_at: Date | null; locked: boolean }>(
      `SELECT s.id, cr.password_hash, cr.totp_enabled_at, coalesce(cr.locked_until > now(), false) AS locked
         FROM staff s JOIN auth_credential cr ON cr.staff_id = s.id
        WHERE lower(s.username) = $1 AND s.status = 'ACTIVE'`,
      [uname],
    );
    const row = r.rows[0];
    const valid = await argonVerify(row?.password_hash ?? (await getDummyHash()), password).catch(() => false);
    if (!row || !row.password_hash || !row.totp_enabled_at || row.locked || !valid) {
      if (row && !row.locked) {
        await c.query(
          `UPDATE auth_credential SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
           WHERE staff_id = $1`,
          [row.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
        );
      }
      await audit(c, "auth.login_failed", { stage: "password", known_user: !!row, locked: !!row?.locked });
      return { ok: false, reason: "invalid" };
    }
    const device = await ensureDevice(c, meta);
    if ("revoked" in device) {
      await audit(c, "auth.login_refused_revoked_device", { staff_id: row.id });
      return { ok: false, reason: "device_revoked" };
    }
    const absoluteHours = await getSettingNumber(c, "session.absolute_hours", 12);
    const token = randomToken();
    await c.query(
      `INSERT INTO auth_session (token_hash, staff_id, device_id, idle_expires_at, absolute_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4), now() + make_interval(hours => $5), $6, $7)`,
      [sha256Hex(token), row.id, device.id, MFA_PENDING_MINUTES, absoluteHours, meta.ip, meta.userAgent?.slice(0, 400) ?? null],
    );
    return { ok: true, pendingToken: token, deviceId: device.id };
  });
}

// ---------------------------------------------------------------- login step 2: TOTP

export type MfaResult = { ok: true } | { ok: false; reason: "invalid" | "expired" };

export async function verifyLoginMfa(pendingToken: string, code: string): Promise<MfaResult> {
  return tx({ auth: true }, async (c) => {
    const r = await c.query<{ id: string; staff_id: string; device_id: string; mfa_failures: number }>(
      `SELECT x.id, x.staff_id, x.device_id, x.mfa_failures
         FROM auth_session x JOIN staff s ON s.id = x.staff_id JOIN device d ON d.id = x.device_id
        WHERE x.token_hash = $1 AND x.revoked_at IS NULL AND x.mfa_verified_at IS NULL
          AND x.idle_expires_at > now() AND x.absolute_expires_at > now() AND s.status = 'ACTIVE' AND d.status = 'ACTIVE'`,
      [sha256Hex(pendingToken)],
    );
    const s = r.rows[0];
    if (!s) return { ok: false, reason: "expired" };
    const cr = await c.query<{ totp_secret_enc: string; totp_last_step: number | null; locked: boolean }>(
      "SELECT totp_secret_enc, totp_last_step, coalesce(locked_until > now(), false) AS locked FROM auth_credential WHERE staff_id = $1 FOR UPDATE",
      [s.staff_id],
    );
    const cred = cr.rows[0];
    const step = cred && !cred.locked ? verifyTotp(decryptSecret(cred.totp_secret_enc), code.trim(), Date.now(), cred.totp_last_step) : null;
    if (step === null) {
      await c.query(
        `UPDATE auth_credential SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE staff_id = $1`,
        [s.staff_id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
      );
      await audit(c, "auth.mfa_failed", { session_id: s.id, staff_id: s.staff_id });
      await c.query("UPDATE auth_session SET mfa_failures = mfa_failures + 1 WHERE id = $1", [s.id]);
      if (s.mfa_failures + 1 >= MAX_MFA_ATTEMPTS_PER_SESSION) {
        await c.query("UPDATE auth_session SET revoked_at = now(), revoked_reason = 'too many second-factor attempts' WHERE id = $1", [s.id]);
        return { ok: false, reason: "expired" };
      }
      return { ok: false, reason: "invalid" };
    }
    const idle = await getSettingNumber(c, "session.idle_minutes", 15);
    await c.query("UPDATE auth_credential SET totp_last_step = $2, failed_attempts = 0, locked_until = NULL WHERE staff_id = $1", [s.staff_id, step]);
    await c.query("UPDATE auth_session SET mfa_verified_at = now(), last_seen_at = now(), idle_expires_at = now() + make_interval(mins => $2) WHERE id = $1", [
      s.id,
      idle,
    ]);
    await c.query("UPDATE staff SET last_login_at = now() WHERE id = $1", [s.staff_id]);
    await c.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
      s.staff_id,
      s.id,
      s.device_id,
    ]);
    await audit(c, "auth.login");
    return { ok: true };
  });
}

// ---------------------------------------------------------------- session lookup

const TOUCH_THROTTLE_SECONDS = 30;

/** Validates a session token; slides the idle expiry (throttled). Returns null if not fully authenticated. */
export async function getAuthedSession(token: string): Promise<AuthedSession | null> {
  if (!token || token.length > 100) return null;
  return tx({ auth: true }, async (c) => {
    const r = await c.query<{
      id: string;
      staff_id: string;
      device_id: string;
      role: Role;
      username: string;
      display_name: string;
      reauth_at: Date | null;
      idle_expires_at: Date;
      stale: boolean;
    }>(
      `SELECT x.id, x.staff_id, x.device_id, s.role, s.username, s.display_name, x.reauth_at, x.idle_expires_at,
              x.last_seen_at < now() - make_interval(secs => $2) AS stale
         FROM auth_session x JOIN staff s ON s.id = x.staff_id JOIN device d ON d.id = x.device_id
        WHERE x.token_hash = $1 AND x.revoked_at IS NULL AND x.mfa_verified_at IS NOT NULL
          AND x.idle_expires_at > now() AND x.absolute_expires_at > now()
          AND s.status = 'ACTIVE' AND d.status = 'ACTIVE'`,
      [sha256Hex(token), TOUCH_THROTTLE_SECONDS],
    );
    const s = r.rows[0];
    if (!s) return null;
    let idleExpiresAt = s.idle_expires_at;
    if (s.stale) {
      const idle = await getSettingNumber(c, "session.idle_minutes", 15);
      const u = await c.query<{ idle_expires_at: Date }>(
        `UPDATE auth_session SET last_seen_at = now(), idle_expires_at = least(now() + make_interval(mins => $2), absolute_expires_at)
          WHERE id = $1 RETURNING idle_expires_at`,
        [s.id, idle],
      );
      idleExpiresAt = u.rows[0].idle_expires_at;
      await c.query("UPDATE device SET last_seen_at = now() WHERE id = $1", [s.device_id]);
    }
    return {
      sessionId: s.id,
      staffId: s.staff_id,
      deviceId: s.device_id,
      role: s.role,
      username: s.username,
      displayName: s.display_name,
      reauthAt: s.reauth_at,
      idleExpiresAt,
    };
  });
}

export async function revokeSessionByToken(token: string, reason: string): Promise<void> {
  await tx({ auth: true }, async (c) => {
    const r = await c.query<{ id: string; staff_id: string; device_id: string }>(
      "SELECT id, staff_id, device_id FROM auth_session WHERE token_hash = $1 AND revoked_at IS NULL",
      [sha256Hex(token)],
    );
    const s = r.rows[0];
    if (!s) return;
    await c.query("SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true)", [
      s.staff_id,
      s.id,
      s.device_id,
    ]);
    await c.query("UPDATE auth_session SET revoked_at = now(), revoked_reason = $2 WHERE id = $1", [s.id, reason]);
    await audit(c, reason === "logout" ? "auth.logout" : "auth.session_ended", { reason });
  });
}

// ---------------------------------------------------------------- step-up re-authentication

export function hasRecentReauth(s: AuthedSession, now = Date.now()): boolean {
  return !!s.reauthAt && now - s.reauthAt.getTime() < REAUTH_WINDOW_MINUTES * 60_000;
}

export async function reauthenticate(s: AuthedSession, password: string, code: string): Promise<boolean> {
  return tx({ auth: true, staffId: s.staffId, sessionId: s.sessionId, deviceId: s.deviceId }, async (c) => {
    const r = await c.query<{ password_hash: string; totp_secret_enc: string; totp_last_step: number | null; locked: boolean }>(
      "SELECT password_hash, totp_secret_enc, totp_last_step, coalesce(locked_until > now(), false) AS locked FROM auth_credential WHERE staff_id = $1 FOR UPDATE",
      [s.staffId],
    );
    const cred = r.rows[0];
    const pwOk = !!cred && !cred.locked && (await argonVerify(cred.password_hash, password).catch(() => false));
    const step = pwOk ? verifyTotp(decryptSecret(cred.totp_secret_enc), code.trim(), Date.now(), cred.totp_last_step) : null;
    if (!pwOk || step === null) {
      await c.query(
        `UPDATE auth_credential SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE staff_id = $1`,
        [s.staffId, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
      );
      await audit(c, "auth.reauth_failed");
      return false;
    }
    await c.query("UPDATE auth_credential SET totp_last_step = $2, failed_attempts = 0 WHERE staff_id = $1", [s.staffId, step]);
    await c.query("UPDATE auth_session SET reauth_at = now() WHERE id = $1", [s.sessionId]);
    await audit(c, "auth.reauth");
    return true;
  });
}

// ---------------------------------------------------------------- activation (invite / reset)

export interface ActivationInfo {
  username: string;
  displayName: string;
  purpose: "ACTIVATE" | "RESET";
  totpSecret: string;
}

async function findToken(c: Tx, token: string) {
  const r = await c.query<{ id: string; staff_id: string; purpose: "ACTIVATE" | "RESET"; username: string; display_name: string }>(
    `SELECT t.id, t.staff_id, t.purpose, s.username, s.display_name
       FROM auth_token t JOIN staff s ON s.id = t.staff_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now() AND s.status = 'INVITED'
      FOR UPDATE OF t`,
    [sha256Hex(token)],
  );
  return r.rows[0] ?? null;
}

/** Validates an activation token and (re)generates the pending TOTP secret to enrol. */
export async function beginActivation(token: string): Promise<ActivationInfo | null> {
  if (!token || token.length > 100) return null;
  return tx({ auth: true }, async (c) => {
    const t = await findToken(c, token);
    if (!t) return null;
    const cr = await c.query<{ totp_secret_enc: string | null }>("SELECT totp_secret_enc FROM auth_credential WHERE staff_id = $1", [t.staff_id]);
    let secret: string;
    if (cr.rows[0]?.totp_secret_enc) {
      secret = decryptSecret(cr.rows[0].totp_secret_enc);
    } else {
      secret = generateTotpSecret();
      await c.query(
        `INSERT INTO auth_credential (staff_id, totp_secret_enc) VALUES ($1, $2)
         ON CONFLICT (staff_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, totp_enabled_at = NULL, totp_last_step = NULL`,
        [t.staff_id, encryptSecret(secret)],
      );
    }
    return { username: t.username, displayName: t.display_name, purpose: t.purpose, totpSecret: secret };
  });
}

export type ActivationResult = { ok: true } | { ok: false; problems: string[] };

export async function completeActivation(token: string, password: string, code: string): Promise<ActivationResult> {
  return tx({ auth: true }, async (c) => {
    const t = await findToken(c, token);
    if (!t) return { ok: false, problems: ["This activation link is invalid, already used, or expired. Ask the Chief RT for a new one."] };
    await c.query("SELECT set_config('app.staff_id', $1, true)", [t.staff_id]);
    const policy = checkPassword(password, { username: t.username, displayName: t.display_name });
    if (!policy.ok) return { ok: false, problems: policy.problems };
    const cr = await c.query<{ totp_secret_enc: string | null }>("SELECT totp_secret_enc FROM auth_credential WHERE staff_id = $1 FOR UPDATE", [t.staff_id]);
    const enc = cr.rows[0]?.totp_secret_enc;
    const step = enc ? verifyTotp(decryptSecret(enc), code.trim(), Date.now(), null) : null;
    if (step === null) return { ok: false, problems: ["The authenticator code did not match. Check the device clock and try the newest code."] };
    await c.query(
      `UPDATE auth_credential SET password_hash = $2, password_changed_at = now(), totp_enabled_at = now(), totp_last_step = $3,
              failed_attempts = 0, locked_until = NULL WHERE staff_id = $1`,
      [t.staff_id, await hashPassword(password), step],
    );
    await c.query("UPDATE auth_token SET used_at = now() WHERE id = $1", [t.id]);
    await c.query("UPDATE auth_token SET revoked_at = now() WHERE staff_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [t.staff_id]);
    await c.query("UPDATE staff SET status = 'ACTIVE', activated_at = now(), deactivated_at = NULL, deactivated_by = NULL WHERE id = $1", [t.staff_id]);
    await audit(c, "auth.account_activated", { purpose: t.purpose });
    return { ok: true };
  });
}

export function currentTotpStep(): number {
  return totpStep(Date.now());
}

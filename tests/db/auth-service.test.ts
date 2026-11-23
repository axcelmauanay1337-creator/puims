import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminError, deactivateStaff, inviteStaff, resetAccess, revokeDevice, updateSetting } from "@/server/auth/admin";
import {
  beginActivation,
  completeActivation,
  getAuthedSession,
  LOCKOUT_THRESHOLD,
  loginWithPassword,
  reauthenticate,
  revokeSessionByToken,
  type AuthedSession,
} from "@/server/auth/service";
import { getPool } from "@/server/db";
import { owner, reseed } from "./helpers";

const PW = process.env.PUIMS_SEED_PASSWORD!;
const meta = { ip: null, userAgent: "vitest", deviceId: null };
let o: pg.Client;

/** Full sign-in (password). Returns the session token and session. */
async function signIn(username: string, deviceId: string | null = null) {
  const p = await loginWithPassword(username, PW, { ...meta, deviceId });
  if (!p.ok) throw new Error(`sign-in failed for ${username}: ${p.reason}`);
  return { token: p.sessionToken, deviceId: p.deviceId, session: (await getAuthedSession(p.sessionToken))! };
}

async function reauth(s: AuthedSession) {
  return { ok: await reauthenticate(s, PW), session: { ...s, reauthAt: new Date() } };
}

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
});
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("sign-in", () => {
  it("the correct password yields a session; the session cookie token is never stored in clear", async () => {
    const { token, session } = await signIn("rt.alpha");
    expect(session.username).toBe("rt.alpha");
    expect(session.role).toBe("RESPIRATORY_THERAPIST");
    const leaked = await o.query("SELECT count(*)::int AS n FROM auth_session WHERE token_hash = $1", [token]);
    expect(leaked.rows[0].n).toBe(0);
  });

  it("a successful sign-in is audited and clears earlier failures", async () => {
    await loginWithPassword("rt.bravo", "wrong-password-123", meta);
    await signIn("rt.bravo");
    const r = await o.query("SELECT failed_attempts FROM auth_credential c JOIN staff s ON s.id = c.staff_id WHERE s.username = 'rt.bravo'");
    expect(r.rows[0].failed_attempts).toBe(0);
    expect((await o.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login'")).rows[0].n).toBeGreaterThan(0);
  });

  it("unknown user and wrong password give the same generic result", async () => {
    expect(await loginWithPassword("nobody.here", PW, meta)).toEqual({ ok: false, reason: "invalid" });
    expect(await loginWithPassword("rt.bravo", "wrong-password-123", meta)).toEqual({ ok: false, reason: "invalid" });
  });

  it("INVITED and DEACTIVATED accounts cannot sign in", async () => {
    expect((await loginWithPassword("rt.golf", PW, meta)).ok).toBe(false); // seeded INVITED
    expect((await loginWithPassword("rt.foxtrot", PW, meta)).ok).toBe(false); // seeded DEACTIVATED
  });

  it(`locks the account after ${LOCKOUT_THRESHOLD} failures — even the correct password is then refused`, async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await loginWithPassword("rt.echo", `wrong-${i}-password`, meta);
    expect(await loginWithPassword("rt.echo", PW, meta)).toEqual({ ok: false, reason: "invalid" });
    const r = await o.query("SELECT locked_until > now() AS locked FROM auth_credential c JOIN staff s ON s.id = c.staff_id WHERE s.username = 'rt.echo'");
    expect(r.rows[0].locked).toBe(true);
    const failures = await o.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login_failed'");
    expect(failures.rows[0].n).toBeGreaterThanOrEqual(LOCKOUT_THRESHOLD);
  });

  it("logout revokes the session immediately", async () => {
    const { token } = await signIn("rt.delta");
    await revokeSessionByToken(token, "logout");
    expect(await getAuthedSession(token)).toBeNull();
  });
});

describe("Chief RT administration", () => {
  let chief: { token: string; deviceId: string; session: AuthedSession };

  beforeAll(async () => {
    chief = await signIn("chief.demo");
  });

  it("sensitive actions require a recent re-authentication", async () => {
    await expect(inviteStaff(chief.session, { username: "rt.newcomer", displayName: "Newcomer (Demo)" })).rejects.toMatchObject({ kind: "REAUTH_REQUIRED" });
  });

  it("re-authentication with a wrong password fails", async () => {
    expect(await reauthenticate(chief.session, "not-the-password")).toBe(false);
  });

  it("an RT cannot use admin functions even with a fresh re-auth", async () => {
    const rt = await signIn("rt.bravo");
    const { session } = await reauth(rt.session);
    await expect(inviteStaff(session, { username: "rt.x", displayName: "X" })).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(updateSetting(session, "tubing.interval_days", "5")).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("invite → activate (weak password refused) → sign in", async () => {
    const r = await reauth(chief.session);
    expect(r.ok).toBe(true);
    chief.session = r.session;
    const { token } = await inviteStaff(chief.session, { username: "rt.newcomer", displayName: "Newcomer Synthetic" });
    await expect(inviteStaff(chief.session, { username: "rt.newcomer", displayName: "Dup" })).rejects.toBeInstanceOf(AdminError);

    const info = await beginActivation(token);
    expect(info?.username).toBe("rt.newcomer");
    expect(await beginActivation("not-a-real-token")).toBeNull();

    const weak = await completeActivation(token, "password123");
    expect(weak.ok).toBe(false);

    expect(await completeActivation(token, "correct horse battery staple")).toEqual({ ok: true });
    expect(await completeActivation(token, "correct horse battery staple")).toMatchObject({ ok: false }); // single use

    const p = await loginWithPassword("rt.newcomer", "correct horse battery staple", meta);
    expect(p.ok).toBe(true);
    if (p.ok) expect(await getAuthedSession(p.sessionToken)).not.toBeNull();
  });

  it("deactivation ends the RT's live sessions immediately", async () => {
    const rt = await signIn("rt.alpha");
    expect(await getAuthedSession(rt.token)).not.toBeNull();
    await deactivateStaff(chief.session, rt.session.staffId);
    expect(await getAuthedSession(rt.token)).toBeNull();
    expect((await loginWithPassword("rt.alpha", PW, meta)).ok).toBe(false);
  });

  it("reset access reinstates through a new activation link and ends sessions", async () => {
    const alpha = (await o.query("SELECT id FROM staff WHERE username = 'rt.alpha'")).rows[0].id;
    const { token } = await resetAccess(chief.session, alpha);
    expect((await o.query("SELECT status FROM staff WHERE id = $1", [alpha])).rows[0].status).toBe("INVITED");
    expect(await beginActivation(token)).not.toBeNull();
  });

  it("an account added but never activated gets a first-time activation link", async () => {
    const golf = (await o.query("SELECT id FROM staff WHERE username = 'rt.golf'")).rows[0].id; // seeded INVITED
    const { token } = await resetAccess(chief.session, golf);
    expect((await beginActivation(token))?.purpose).toBe("ACTIVATE");
    expect(await completeActivation(token, "quiet river copper evening")).toEqual({ ok: true });
    expect((await loginWithPassword("rt.golf", "quiet river copper evening", meta)).ok).toBe(true);
  });

  it("the Chief RT cannot deactivate or reset themself", async () => {
    await expect(deactivateStaff(chief.session, chief.session.staffId)).rejects.toMatchObject({ kind: "INVALID" });
    await expect(resetAccess(chief.session, chief.session.staffId)).rejects.toMatchObject({ kind: "INVALID" });
  });

  it("revoking a device ends its sessions and blocks new sign-ins from it", async () => {
    const rt = await signIn("rt.delta");
    await revokeDevice(chief.session, rt.deviceId, "lost (test)");
    expect(await getAuthedSession(rt.token)).toBeNull();
    expect(await loginWithPassword("rt.delta", PW, { ...meta, deviceId: rt.deviceId })).toEqual({ ok: false, reason: "device_revoked" });
  });

  it("settings are validated before reaching the database", async () => {
    await expect(updateSetting(chief.session, "tubing.interval_days", "0")).rejects.toMatchObject({ kind: "INVALID" });
    await expect(updateSetting(chief.session, "made.up", "1")).rejects.toMatchObject({ kind: "INVALID" });
    await updateSetting(chief.session, "tubing.interval_days", "10");
    expect((await o.query("SELECT value FROM setting WHERE key = 'tubing.interval_days'")).rows[0].value).toBe(10);
    await updateSetting(chief.session, "tubing.interval_days", "7");
  });
});

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

// Same type parsing as the app (src/server/db.ts): DATE stays a YYYY-MM-DD string.
pg.types.setTypeParser(1082, (v) => v);

export const owner = () => new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
export const app = () => new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });

export function seedAccounts(): Record<string, { status: string; role: string }> {
  return JSON.parse(readFileSync(".seed-credentials.test.json", "utf8")).accounts;
}

export async function staffId(c: pg.Client, username: string): Promise<string> {
  return (await c.query("SELECT id FROM staff WHERE username = $1", [username])).rows[0].id;
}

/** Creates a fully-authenticated session row directly (owner) so RLS can be probed without the app. */
export async function makeSession(c: pg.Client, sid: string, opts: { mfa?: boolean; idleMinutes?: number } = {}) {
  const d = await c.query("INSERT INTO device (label) VALUES ('test device') RETURNING id");
  const s = await c.query(
    `INSERT INTO auth_session (token_hash, staff_id, device_id, idle_expires_at, absolute_expires_at, mfa_verified_at)
     VALUES (md5(random()::text), $1, $2, now() + make_interval(mins => $3), now() + interval '12 hours', $4) RETURNING id`,
    [sid, d.rows[0].id, opts.idleMinutes ?? 15, opts.mfa === false ? null : new Date()],
  );
  return { sessionId: s.rows[0].id as string, deviceId: d.rows[0].id as string, staffId: sid };
}

export async function asCtx<T>(
  c: pg.Client,
  ctx: { staffId?: string; sessionId?: string; deviceId?: string; auth?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query(
      "SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true), set_config('app.context', $4, true)",
      [ctx.staffId ?? "", ctx.sessionId ?? "", ctx.deviceId ?? "", ctx.auth ? "auth" : ""],
    );
    return await fn();
  } finally {
    await c.query("ROLLBACK");
  }
}

export async function expectPgError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    if ((e as { code?: string }).code === code) return;
    throw new Error(`expected SQLSTATE ${code}, got ${(e as { code?: string }).code}: ${(e as Error).message}`);
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}

/** Re-seed the test database so each test file starts from the same known state. */
export function reseed() {
  execSync("npx tsx scripts/seed.ts --test", {
    env: { ...process.env, MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL, PUIMS_DEPLOYMENT_PROFILE: "development" },
    stdio: "ignore",
  });
}

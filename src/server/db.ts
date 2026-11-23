import "server-only";
import pg from "pg";

/**
 * PostgreSQL access. The app connects as `puims_app` (not the schema owner), so
 * row-level security applies to every query. Each unit of work runs in a
 * transaction that first sets the request identity (transaction-local), which
 * RLS policies and audit triggers read.
 */

// DATE → 'YYYY-MM-DD' string (never a JS Date shifted by the host timezone).
pg.types.setTypeParser(1082, (v) => v);
// BIGINT → number (audit ids stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

const g = globalThis as unknown as { __puimsPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!g.__puimsPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    // Hosted PostgreSQL (e.g. Supabase): PUIMS_DB_CA holds the provider's CA certificate (PEM) and the
    // server certificate is verified against it. Without it, the connection string's sslmode applies.
    const ca = process.env.PUIMS_DB_CA?.replace(/\\n/g, "\n");
    let connectionString = process.env.DATABASE_URL;
    if (ca) {
      const u = new URL(connectionString);
      u.searchParams.delete("sslmode");
      connectionString = u.toString();
    }
    g.__puimsPool = new pg.Pool({
      connectionString,
      ssl: ca ? { ca, rejectUnauthorized: true } : undefined,
      max: Number(process.env.PUIMS_DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "puims-app",
    });
    // Never let an idle-client error crash the process or print connection details.
    g.__puimsPool.on("error", () => {});
  }
  return g.__puimsPool;
}

export interface DbContext {
  staffId?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  /** Identity-table access for login/activation/admin flows. Never grants clinical access. */
  auth?: boolean;
}

/**
 * Database errors are re-thrown WITHOUT `detail`/`where`, which can contain row
 * values (i.e. PHI). Only SQLSTATE and constraint name survive.
 */
export class DbError extends Error {
  constructor(
    public readonly code: string | undefined,
    public readonly constraint: string | undefined,
  ) {
    super(`Database error${code ? ` ${code}` : ""}${constraint ? ` (${constraint})` : ""}`);
    this.name = "DbError";
  }
}

function sanitize(e: unknown): Error {
  if (e instanceof DbError) return e;
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    const pe = e as { code: string; constraint?: string };
    return new DbError(pe.code, pe.constraint);
  }
  return e instanceof Error ? e : new Error("Unknown error");
}

export type Tx = pg.PoolClient;

export async function tx<T>(ctx: DbContext, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.staff_id', $1, true), set_config('app.session_id', $2, true), set_config('app.device_id', $3, true), set_config('app.context', $4, true)",
      [ctx.staffId ?? "", ctx.sessionId ?? "", ctx.deviceId ?? "", ctx.auth ? "auth" : ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw sanitize(e);
  } finally {
    client.release();
  }
}

/** App-level audit event (actor/session/device/time are stamped by the DB trigger). */
export async function audit(c: Tx, action: string, detail?: Record<string, unknown>, target?: { table?: string; id?: string }) {
  await c.query("INSERT INTO audit_log (action, table_name, record_id, detail) VALUES ($1, $2, $3, $4)", [
    action,
    target?.table ?? null,
    target?.id ?? null,
    detail ? JSON.stringify(detail) : null,
  ]);
}

export async function getSettingNumber(c: Tx, key: string, fallback: number): Promise<number> {
  const r = await c.query<{ value: unknown }>("SELECT value FROM setting WHERE key = $1", [key]);
  const v = Number(r.rows[0]?.value);
  return Number.isFinite(v) ? v : fallback;
}

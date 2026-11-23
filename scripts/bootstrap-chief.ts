/**
 * Provisions THE Chief RT administrator account (exactly one may exist).
 * Run by an operator with owner database credentials on the server:
 *
 *   npm run admin:bootstrap -- --username jdoe.chief --name "Full Name"
 *
 * Prints a one-time activation link (valid 72 h). The link is not stored —
 * only its SHA-256 hash. Deliver it to the Chief RT through a trusted channel;
 * they set their own password.
 */
import pg from "pg";
import { randomToken, sha256Hex, USERNAME_RE } from "../src/lib/auth/tokens";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const username = arg("username")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  if (!username || !USERNAME_RE.test(username)) throw new Error("--username: 3–40 chars, lowercase letters, digits, . _ -");
  if (!name || name.length > 80) throw new Error('--name "Display Name" is required (≤ 80 chars)');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set");
  const base = (process.env.PUIMS_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN");
    const existing = await c.query("SELECT username, status FROM staff WHERE role = 'CHIEF_RT_ADMIN' AND status <> 'DEACTIVATED'");
    if (existing.rowCount)
      throw new Error(
        `A Chief RT account already exists (${existing.rows[0].username}, ${existing.rows[0].status}). Deactivate it first through the documented hand-over procedure.`,
      );
    const s = await c.query<{ id: string }>(
      "INSERT INTO staff (username, display_name, role, status) VALUES ($1, $2, 'CHIEF_RT_ADMIN', 'INVITED') RETURNING id",
      [username, name],
    );
    const token = randomToken();
    await c.query("INSERT INTO auth_token (staff_id, purpose, token_hash, expires_at) VALUES ($1, 'ACTIVATE', $2, now() + interval '72 hours')", [
      s.rows[0].id,
      sha256Hex(token),
    ]);
    await c.query("INSERT INTO audit_log (action, table_name, record_id, detail) VALUES ('admin.chief_bootstrapped', 'staff', $1, $2)", [
      s.rows[0].id,
      JSON.stringify({ via: "cli" }),
    ]);
    await c.query("COMMIT");
    console.log(`Chief RT account "${username}" created (awaiting activation).`);
    console.log(`One-time activation link (valid 72 hours, shown only now):\n\n  ${base}/activate#${token}\n`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

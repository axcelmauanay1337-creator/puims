// Applies db/migrations/*.sql in order as the schema OWNER (MIGRATION_DATABASE_URL).
// Each migration runs in its own transaction and is recorded with a SHA-256 checksum;
// an already-applied migration whose file changed aborts the run (never edit applied migrations).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set");
  process.exit(1);
}
const dir = path.resolve("db/migrations");
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
  .sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query("SELECT pg_advisory_lock(727)");
  const applied = new Map((await client.query("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]));
  let count = 0;
  for (const f of files) {
    const sql = readFileSync(path.join(dir, f), "utf8");
    const sum = createHash("sha256").update(sql).digest("hex");
    if (applied.has(f)) {
      if (applied.get(f) !== sum) throw new Error(`Migration ${f} was modified after being applied. Create a new migration instead.`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [f, sum]);
      await client.query("COMMIT");
      console.log(`applied ${f}`);
      count++;
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`${f}: ${e.message}`);
    }
  }
  console.log(count ? `${count} migration(s) applied` : "database is up to date");
} finally {
  await client.end();
}

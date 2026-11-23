// One-command local setup (synthetic data only):
//   npm run setup            → .env.local with fresh secrets, PostgreSQL in Docker, migrations, synthetic data
//   npm run setup -- --native   → use an existing local PostgreSQL via scripts/db-local-setup.sh instead of Docker
//   npm run setup -- --port 5433 → expose the Docker database on another local port
// Safe to re-run: keeps an existing .env.local and database, re-applies migrations, re-seeds synthetic data.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const native = args.includes("--native");
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 5432;
const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const hex = (n) => randomBytes(n).toString("hex");

if (!existsSync(".env.local")) {
  const owner = hex(18);
  const app = hex(18);
  let s = readFileSync(".env.example", "utf8");
  s = s
    .replaceAll("puims_app:CHANGE_ME@localhost:5432", `puims_app:${app}@localhost:${port}`)
    .replaceAll("puims_owner:CHANGE_ME@localhost:5432", `puims_owner:${owner}@localhost:${port}`)
    .replace("PUIMS_DB_OWNER_PASSWORD=CHANGE_ME", `PUIMS_DB_OWNER_PASSWORD=${owner}`)
    .replace("PUIMS_DB_APP_PASSWORD=CHANGE_ME", `PUIMS_DB_APP_PASSWORD=${app}`)
    .replace("PUIMS_DATA_KEY=CHANGE_ME", `PUIMS_DATA_KEY=${randomBytes(32).toString("base64")}`)
    .replace("PUIMS_SEED_PASSWORD=CHANGE_ME", `PUIMS_SEED_PASSWORD=Synthetic-${hex(6)}`)
    .replace("# PUIMS_INSECURE_COOKIES=true", "PUIMS_INSECURE_COOKIES=true");
  s += `\n# Docker database (local development only)\nPUIMS_DB_SUPERUSER_PASSWORD=${hex(18)}\nPUIMS_DB_PORT=${port}\n`;
  if (s.includes("CHANGE_ME@") || /=CHANGE_ME$/m.test(s)) throw new Error("setup: a placeholder was not replaced");
  writeFileSync(".env.local", s, { mode: 0o600 });
  console.log("✓ created .env.local with fresh random secrets");
} else {
  console.log("• keeping existing .env.local");
}

if (native) {
  run("./scripts/db-local-setup.sh");
} else {
  run("docker compose --env-file .env.local up -d --wait db");
  console.log("✓ PostgreSQL container is healthy");
}
run("npm run db:migrate");
run("npm run db:migrate:test");
run("npm run db:seed");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
console.log(`
PUIMS is ready (synthetic data only).
  1. npm run dev
  2. open http://localhost:3000
  3. sign in as chief.demo (Chief RT) or rt.alpha (RT)
     password: ${env.PUIMS_SEED_PASSWORD}
     code:     npm run dev:totp -- chief.demo   (or add the secret from .seed-credentials.json to an authenticator app)
`);

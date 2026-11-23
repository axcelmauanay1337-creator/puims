# PUIMS — Deployment and Rollback Runbook

Simplest path: **`docs/SERVER_SETUP.md`** (`./puims-server.sh` — one machine, Docker, automatic HTTPS and backups; it sets `PUIMS_OFFLINE_POLICY_APPROVED=true` because offline use is approved). The rest of this runbook is for a more formal setup. Audience: IT. First-time installation is in `docs/SETUP.md` ("First production-like deployment"); backups in `docs/BACKUP_AND_RESTORE.md`. **Do not deploy with real patient data before the release gate (handoff checklist §H) and `docs/PRODUCTION_READINESS_CHECKLIST.md` are signed off.**

## Architecture recap

One Next.js (Node.js 22) application process behind a TLS reverse proxy, one PostgreSQL 16 database (authoritative, U-01). The app connects as `puims_app` (row-level security, no DELETE). Migrations and backups use the owner role from an operator machine, not the app host. No outbound internet access is required at runtime (no analytics, no external APIs).

## Environment variables

| Variable                        | Required    | Notes                                                                                                                                                                                       |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | yes         | `puims_app` role, `sslmode=require`                                                                                                                                                         |
| `PUIMS_DATA_KEY`                | yes         | 32-byte base64; encrypts authenticator secrets and offline lease keys. Keep outside DB backups; losing it forces authenticator re-enrolment and makes unsynced offline queues unrecoverable |
| `PUIMS_DEPLOYMENT_PROFILE`      | yes         | `lan` or `cloud` (refuses seeding/dev helpers; shows no dev banner)                                                                                                                         |
| `PUIMS_PUBLIC_URL`              | yes         | Used for activation links                                                                                                                                                                   |
| `PUIMS_TRUST_PROXY`             | optional    | `true` only behind a trusted proxy that sets `X-Forwarded-For`                                                                                                                              |
| `PUIMS_OFFLINE_POLICY_APPROVED` | optional    | Leave `false` until U-03 is approved; while false the Chief RT cannot approve offline devices                                                                                               |
| `PUIMS_DB_POOL_MAX`             | optional    | default 10                                                                                                                                                                                  |
| `NEXT_TELEMETRY_DISABLED`       | recommended | `1`                                                                                                                                                                                         |

## Release procedure (each new version)

1. **Read the release notes**: list of new migrations (`db/migrations/`), new env vars, changed policies.
2. **Verify the build** on the build machine: `npm ci && npm run verify` (format, lint, types, unit, database, build, browser tests against a disposable test database). Record the result.
3. **Back up** (`scripts/backup.sh`) and confirm the manifest checksum. Keep the previous application build directory/container image.
4. **Maintenance notice** to the unit (expected minutes; use paper meanwhile). Offline-capable devices keep working on their encrypted queue and sync afterwards.
5. **Stop** the app (or drain behind the proxy).
6. **Migrate**: `MIGRATION_DATABASE_URL=… npm run db:migrate`. Migrations are forward-only, transactional, checksummed and refuse to run if an applied file was altered.
7. **Start** the new build (`npm start` / container). Check `GET /api/health` → `{"status":"ok"}` (contains no patient data).
8. **Smoke test** (5 minutes, synthetic or test account where possible): sign in with authenticator; Overview loads; open a patient; Nebulization worklist; Diagnostics calendar; Reports; Devices & Sync shows "Online". Check the server log for errors (logs contain no request bodies or patient values).
9. **Announce** completion; note the version in the change log.

## Rollback

Choose by what failed:

| Situation                                                                                                                  | Action                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New build misbehaves, **no migration** in this release                                                                     | Stop, start the previous build. Done.                                                                                                                                                                                                                                                                                              |
| New build misbehaves, migration applied, schema change is **additive** (new tables/columns/functions — true for 0007–0009) | Start the previous build against the migrated database: older code ignores the new objects. Investigate, fix forward.                                                                                                                                                                                                              |
| Migration failed mid-way                                                                                                   | Nothing to undo: each migration runs in one transaction and is recorded only on success. Fix and re-run.                                                                                                                                                                                                                           |
| Data corruption or a destructive migration problem                                                                         | Restore the pre-release backup into a **new** database (`docs/BACKUP_AND_RESTORE.md` → Real restore), point the previous build at it. Entries made after the backup must be re-entered from paper — tell the unit; synced offline entries after that point are listed in the old database's `sync_event` table for reconciliation. |

Never "roll back" by editing or deleting migration files on a database where they were applied, and never delete clinical rows: corrections are voids.

## After an incident

- Revoke affected sessions/devices from Devices & Sync; reset access for affected accounts.
- If `PUIMS_DATA_KEY` may be exposed: rotate it (procedure to be written with IT before go-live — re-encrypt `auth_credential.totp_secret_enc` and `offline_lease.key_enc`), revoke all offline leases, force authenticator re-enrolment.
- Preserve the audit log (append-only; export with owner credentials for the investigation).

# PUIMS — Setup and Deployment

## Local development (synthetic data only)

Requirements: Node.js ≥ 20.9 (22 recommended), PostgreSQL 16 with local superuser access (`sudo -u postgres`), `openssl`.

```bash
npm ci
cp .env.example .env.local        # then replace every CHANGE_ME (see below)
./scripts/db-local-setup.sh       # creates roles puims_owner / puims_app and databases puims + puims_test
npm run db:migrate
npm run db:seed                   # synthetic data + synthetic accounts
npm run dev                       # http://localhost:3000
```

Generate values for `.env.local`: two DB passwords (`openssl rand -hex 18`), `PUIMS_DATA_KEY` (`openssl rand -base64 32`), `PUIMS_SEED_PASSWORD` (≥ 12 chars), and `PUIMS_INSECURE_COOKIES=true` for plain-HTTP localhost.

**Signing in locally**: seeded accounts are `chief.demo` and `rt.alpha` … `rt.echo` (`rt.foxtrot` is deactivated, `rt.golf` invited), all with password `PUIMS_SEED_PASSWORD`.

## Tests

```bash
npm test            # unit (time rules, tubing, metrics, password policy, crypto)
npm run test:db     # PostgreSQL: RLS, audit immutability, constraints, auth service (re-seeds puims_test)
npm run build && npm run test:e2e   # Playwright against puims_test with real sign-in
npm run verify      # everything, CI order
```

## First production-like deployment (hospital LAN or approved cloud)

> Do not load real patient data until the release gate in `docs/handoff/SECURITY_AND_ACCEPTANCE_CHECKLIST.md` §H is signed off.

1. **Database**: PostgreSQL 16 on a hospital-managed host with TLS, disk encryption and restricted network access. Run `db/bootstrap.sql` as a superuser with strong passwords supplied via `-v`.
2. **Secrets** (from the hospital secret store, never in Git): `DATABASE_URL` (puims_app), `PUIMS_DATA_KEY`, `PUIMS_DEPLOYMENT_PROFILE=lan` or `cloud`, `PUIMS_PUBLIC_URL=https://puims.<hospital>.local`, `PUIMS_TRUST_PROXY=true` only behind a trusted reverse proxy. The owner URL is needed only for migrations/backups and should not stay on the app host.
3. **Migrate**: `MIGRATION_DATABASE_URL=… npm run db:migrate` (refuses if an applied migration was edited).
4. **Build and run**: `npm ci && npm run build && npm start` behind a TLS-terminating reverse proxy (HTTPS is mandatory: session cookies are `Secure` and `__Host-` prefixed).
5. **Bootstrap the Chief RT**: `MIGRATION_DATABASE_URL=… PUIMS_PUBLIC_URL=… npm run admin:bootstrap -- --username <name> --name "<Full Name>"`. Hand the printed one-time link to the Chief RT in person. It expires in 72 h.
6. The Chief RT activates (sets a password), then invites each RT from **RT Staff**.
7. Configure encrypted backups (`docs/BACKUP_AND_RESTORE.md`) and run a restore drill before go-live.

Seeding (`npm run db:seed`) refuses to run on `lan`/`cloud` profiles.

## Chief RT forgot their password / left the role

Operator procedure with owner credentials, recorded in the audit log:

```sql
-- 1. Deactivate the current Chief RT (ends all their sessions immediately)
UPDATE staff SET status = 'DEACTIVATED', deactivated_at = now() WHERE role = 'CHIEF_RT_ADMIN' AND status <> 'DEACTIVATED';
UPDATE auth_session SET revoked_at = now(), revoked_reason = 'chief rt replaced' WHERE revoked_at IS NULL AND staff_id IN (SELECT id FROM staff WHERE role = 'CHIEF_RT_ADMIN');
```

then run `npm run admin:bootstrap` for the new (or re-enrolling) Chief RT with a new username. Two-person authorization for this procedure is recommended.

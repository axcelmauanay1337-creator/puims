# PUIMS — Pulmonary Unit Information and Management System

Notion-style clinical workspace for Respiratory Therapists: patient masterlist, shifts and handover, nebulization, mechanical ventilation, change of tubing tracking, PFT / ABG / sputum induction, reports, import, audit.

> **Status: Milestones 0–8 built and tested — not for clinical use.** All 16 modules work end to end on synthetic data: password accounts, row-level security, append-only audit, patients, shifts and handover, nebulization / ventilation / tubing documentation, PFT / ABG / sputum-induction scheduling, the PFT form as the official record, the workbook import wizard, reports with audited exports, and an interim offline capture design (off by default). What remains is the hospital's: approvals, real-data decisions and clinical UAT — see `docs/PRODUCTION_READINESS_CHECKLIST.md`. Do not load real patient data until hospital IT, DPO/privacy and clinical governance approve it.

## Run it for real (your own machine)

```bash
./puims-server.sh setup
```

Database, app, automatic HTTPS and daily backups on one computer (unit PC or small cloud server). Step-by-step: [`docs/SERVER_SETUP.md`](docs/SERVER_SETUP.md).

## Quick start for developers (local, synthetic data)

Requirements: **Node.js 22** (≥ 20.9) and **Docker Desktop** (or Docker Engine with Compose). Linux, macOS or Windows.

```bash
npm ci
npm run setup      # creates .env.local with fresh secrets, starts PostgreSQL in Docker, migrates, loads synthetic data
npm run dev        # then open http://localhost:3000
```

`npm run setup` prints the sign-in details. Accounts: `chief.demo` (Chief RT) and `rt.alpha` … `rt.echo` (RTs). Sign in with the password `npm run setup` prints.

## Scripts

| Command                                                       | What it does                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run build` / `npm start`                 | Develop / build / serve                                                                  |
| `npm run lint` · `npm run typecheck` · `npm run format:check` | Static checks                                                                            |
| `npm test`                                                    | Unit tests (time rules, tubing, metrics, password policy, crypto)                        |
| `npm run test:db`                                             | PostgreSQL tests: RLS, audit, constraints, auth, every clinical workflow (`TEST_*` URLs) |
| `npm run test:e2e`                                            | Playwright + axe against a production build and the test DB, with real sign-in           |
| `npm run verify`                                              | Everything, in CI order                                                                  |
| `npm run db:migrate` · `npm run db:seed`                      | Apply migrations · load synthetic data (dev/UAT only)                                    |
| `npm run admin:bootstrap -- --username … --name "…"`          | Create THE Chief RT account (prints a one-time activation link)                          |
| `npm run fixture:workbook`                                    | Write a messy, synthetic PFT scheduling workbook to try the import wizard                |
| `npm run build:offline`                                       | Rebuild the offline capture page script (runs automatically before dev/build)            |
| `scripts/backup.sh` · `scripts/restore-drill.sh`              | Encrypted backup · verified restore drill                                                |

## Configuration

See `.env.example`. Key variables: `DATABASE_URL` (least-privileged app role), `MIGRATION_DATABASE_URL` (owner; migrations/backups only), `PUIMS_DATA_KEY` (encrypts offline lease keys and retained originals; keep outside DB backups), `PUIMS_DEPLOYMENT_PROFILE` (`development` · `uat` · `lan` · `cloud`), `PUIMS_PUBLIC_URL`.

## Privacy rules for contributors

- Never commit, upload, paste or screenshot real patient data — including into AI tools, issue trackers or analytics.
- Hospital numbers in fixtures must use the reserved `SYN-` prefix; staff are "RT Alpha (Demo)…", physicians "Dr. Demo …".
- Patient identifiers must never appear in URLs (use internal UUIDs; send search terms in POST bodies).
- Do not add analytics/telemetry SDKs.

## Documentation

- `docs/00-MILESTONE-0-PLAN.md` — assumptions, open decisions (U-01…U-19), architecture, entity map, schema review, milestone plan
- `docs/USER_GUIDE.md` · `docs/CLINICAL_UAT_CHECKLIST.md` · `docs/IMPORT_GUIDE.md`
- `docs/DEPLOYMENT_RUNBOOK.md` · `docs/PRODUCTION_READINESS_CHECKLIST.md` · `docs/SECURITY_REVIEW.md` · `docs/BACKUP_AND_RESTORE.md` · `docs/DATA_DICTIONARY.md`
- `docs/THREAT_MODEL.md` · `docs/OFFLINE_BEHAVIOR_MATRIX.md` · `docs/adr/`
- `docs/BUILD_TRACKER.md` — milestone status and evidence
- `docs/handoff/` — the original requirements package

# PUIMS — Production Readiness Checklist

Status as of Milestone 8 (2026-11-22). ✅ = done and tested in this repository. ☐ = **must be done by the hospital before real patient data**; these cannot be completed by the development team alone.

## Governance and approvals (release gate)

- ☐ Hospital IT approves the hosting topology (U-01) and the server/database hardening.
- ☐ DPO/privacy approves the data inventory, retention (U-12), contact (U-08) and payment (U-09) decisions, and any cloud/vendor use (U-15).
- ☐ Clinical governance approves: PFT form content and layout (U-10: header, revision, Salbutamol statement), pulmonologist signature method (U-18), status vocabularies (U-05), procedure catalogue (U-06), tubing interval (U-04).
- ☐ Offline policy (U-03): approved platforms/devices; only then set `PUIMS_OFFLINE_POLICY_APPROVED=true`.
- ☐ Real workbook import plan (U-19): approved environment, named reviewers.
- ☐ Downtime (paper) procedure aligned with the app (U-16).
- ☐ Independent security assessment / penetration test of the deployed system.

## Security

- ⚠️ Authenticator (TOTP) removed at the product owner's request (ADR-0009) — hospital IT must accept password-only sign-in or ask for a second factor back. ✅ Individual accounts, Argon2id, lockout, session idle/absolute limits, step-up re-authentication for sensitive actions.
- ✅ Row-level security on every table keyed to a validated session; app role has no DELETE/TRUNCATE.
- ✅ Append-only audit log (actor/session/device/time stamped in the database).
- ✅ Nonce CSP on the app; strict static CSP on the offline page; no PHI in URLs; no-store caching; no analytics/telemetry.
- ✅ CSV exports formula-injection-safe and audited; import contact/payment columns dropped.
- ✅ `npm audit`: 0 known vulnerabilities at release (exceljs's `uuid` pinned via override).
- ☐ TLS certificates, reverse proxy, firewall rules, host patching, DB encryption at rest (hospital IT).
- ☐ `PUIMS_DATA_KEY` held in the hospital secret store; key-rotation procedure agreed.
- ☐ Shared rate limiting if more than one app instance runs.

## Reliability and operations

- ✅ Encrypted backup script and restore drill (drill passed 2026-11-22 on the development host).
- ☐ Backup schedule, off-site copy and quarterly restore drill adopted by IT.
- ✅ Health endpoint without patient data; deployment and rollback runbook (`docs/DEPLOYMENT_RUNBOOK.md`).
- ☐ Monitoring/alerting on the health endpoint and disk space.
- ✅ Performance on synthetic data: pages 30–60 ms server time; yearly report ≈ 1 s (`docs/SECURITY_REVIEW.md` §Performance). ☐ Re-measure with real data volume.

## Quality

- ✅ Automated tests: unit, PostgreSQL (RLS, constraints, workflows), browser (desktop + phone, axe WCAG 2.1 AA checks, real sign-in) — `npm run verify`.
- ☐ Clinical UAT (`docs/CLINICAL_UAT_CHECKLIST.md`) signed by the Chief RT and clinical governance.
- ☐ Training using `docs/USER_GUIDE.md`.

## Data

- ✅ Synthetic data only in this repository; seed refuses `lan`/`cloud`.
- ☐ Chief RT bootstrapped in production with `npm run admin:bootstrap`; approved signatory directory entered (real names only after approval).
- ☐ PFT template v2 entered with the hospital-confirmed header/revision and "hospital-confirmed" ticked.

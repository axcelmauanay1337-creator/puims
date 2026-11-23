# PUIMS Build Tracker

| Milestone | Deliverable                                                    | Status                                                                               | Evidence / tests                                                                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | Repository inspection, architecture, assumptions, threat model | **Complete**                                                                         | `docs/00-MILESTONE-0-PLAN.md`, `docs/THREAT_MODEL.md`, `docs/adr/0001–0005`                                                                                                                                                                                                                        |
| 1         | Runnable responsive app shell                                  | **Complete**                                                                         | 50 unit tests (Vitest) · 45 e2e tests (Playwright, desktop + Pixel 7, axe WCAG 2.1 AA on 6 screens) · production build green · stable over 3 repeated e2e runs                                                                                                                                     |
| 2         | Database, auth, roles, authorization, audit                    | **Complete**                                                                         | 3 migrations · 63 PostgreSQL tests (RLS, append-only audit, constraints, auth service) · 72 unit tests (incl. RFC 6238 vectors) · 55 e2e tests with real sign-in · restore drill passed · ADR-0006                                                                                                 |
| 3         | Patient masterlist, shifts, handover                           | **Complete**                                                                         | Migration 0004 · 81 PostgreSQL tests (+18 for M3) · 77 unit tests (+5 handover-shift boundary tests) · 62 e2e tests (+7 workflows)                                                                                                                                                                 |
| 4         | Nebulization, ventilation, tubing tracker                      | **Complete**                                                                         | Migrations 0005–0006 · 93 PostgreSQL tests (+12 for M4) · 82 unit tests (+5 expected-dose slot tests) · 67 e2e tests (+5 documentation workflows)                                                                                                                                                  |
| 5         | Diagnostics, PFT form, import staging                          | **Complete** (hospital confirmations pending: U-10 content, U-18, U-19)              | Migration 0007 · +19 PostgreSQL tests (scheduling workflow, reschedule lineage, PFT lifecycle, signatory/template, import staging→commit→reverse/discard) · +23 unit tests (workbook parser) · +4 e2e (book→PFT sign→final→print, calendar URLs, messy workbook staging, RT refused)               |
| 6         | Reports and analytics                                          | **Complete**                                                                         | Period engine + reports · +5 PostgreSQL tests (Chief-only, totals reconcile, rates, tubing compliance, audited formula-safe exports) · +6 unit tests (periods) · +6 e2e (week/month/year + axe, CSV download, RT refused)                                                                          |
| 7         | PWA, offline store, sync, mobile hardening                     | **Complete as interim design** — off by default; production use needs U-03           | Migration 0008 · +5 PostgreSQL tests (approval + step-up, lease, key release, idempotent sync, conflict, clock skew, revoked device) · +5 unit tests (sealing, queue) · +3 e2e (unapproved refused, Chief approval, airplane-mode capture → reload → reconnect → sync)                             |
| 8         | UAT, security review, deployment readiness                     | **Complete** (repository side); hospital sign-offs listed in the readiness checklist | Migration 0009 (U-09 guard) · review fixes · `npm run verify` green: 116 unit · 122 PostgreSQL · 81 Playwright (desktop + phone, axe) · performance budget test · docs: security review, user guide, UAT checklist, deployment/rollback runbook, production readiness, import guide, ADR-0007/0008 |

Open policy questions: see `00-MILESTONE-0-PLAN.md` §3 (U-01 … U-19). Production gate: `docs/PRODUCTION_READINESS_CHECKLIST.md`.

## Update 2026-11-23 (after Milestone 8)

- PFT form layout and printed text now follow the hospital's PFT guide (form AS-PUL-PFT-006) supplied by the product owner — template v2 via migration 0010. Only the form's printed text was read; signature sheets (staff/doctor names) and any filled-in values were not.
- Open appointments are editable (time, procedure, physician, OPD/INP, remarks) with a required reason and full history; closed appointments and appointments with a signed PFT record stay locked.
- The real scheduling workbook was **not** opened or imported into this development environment (U-19).

## Update 2026-11-23 (e-signatures; Excel used exactly as is)

- Product owner: everything is approved; the pulmonologist signs with the e-sign in the Excel guide; nothing in the Excel files may be changed.
- Migrations 0012–0013: signatory e-signature images (set once, never replaced), pulmonologist sign-off method `E_SIGNATURE_APPLIED_BY_RT`, staged signature proposals.
- Settings → Load from the hospital's PFT guide workbook: logo, header lines, item 6 and form code copied byte-for-byte into a hospital-confirmed template version; each signature image with the name written under it is offered for the directory.
- Import keeps every text value exactly as typed (no trimming or space collapsing).
- Tests: 117 unit · 127 PostgreSQL · 82 Playwright.

## Update 2026-11-23 (privacy officer approvals)

Product owner: "everything is approved by the hospital privacy officer". Applied to the privacy decisions only (migration 0011): contact info (U-08) and payment class (U-09) are stored; original workbooks are retained encrypted (U-12). Added the hospital logo on the PFT template. Decisions owned by hospital IT or clinical governance (hosting, offline devices U-03, real-data import environment U-19, PFT content confirmation, U-18) are unchanged.

## Milestone 8 — what "complete" means here

A whole-repository review against the threat model (v1.0) found and fixed: an optional payment field that contradicted U-09 (removed; DB CHECK added), offline approval possible in hospital profiles (interlock added), key material and raw workbook values reaching the audit log (redacted), print layout showing app chrome, and a test-harness authenticator race. Accessibility (axe on new pages, phone overflow checks) and a performance budget test were added. Deliverables: `SECURITY_REVIEW.md`, `USER_GUIDE.md`, `CLINICAL_UAT_CHECKLIST.md`, `DEPLOYMENT_RUNBOOK.md`, `PRODUCTION_READINESS_CHECKLIST.md`, `IMPORT_GUIDE.md`, updated threat model, data dictionary, offline matrix and decision register. **Not done (cannot be done by the development team):** hospital approvals, independent penetration test, clinical UAT sign-off, real-data import.

## Milestone 7 — what "complete" means here

Offline capture of nebulization doses and tubing replacements on devices the Chief RT approves (step-up), with a ≤ 12 h lease, an AES-GCM-sealed IndexedDB queue and snapshot whose key stays in memory only, idempotent sync, and a review queue for conflicts (already documented, clock skew > 5 min, outside the lease) and rejections — nothing overwritten, nothing silently dropped. Refused in `lan`/`cloud` deployments until U-03 is approved. ADR-0007; `OFFLINE_BEHAVIOR_MATRIX.md`.

## Milestone 6 — what "complete" means here

Day / week / month / year reports on operational (06:00–06:00) or calendar days: unique patients, service counts, OPD/INP, active ventilators, nebulization and diagnostic status, diagnostic outcome rates (no rate on an empty denominator), tubing replacement compliance (on time / late / not documented), workload context by shift beside rostered RT-shifts (explicitly not a ranking), per-day and monthly trends, written definitions on the page. CSV exports (Chief RT) are audited, formula-injection-safe, and the one export with patient data is labelled and flagged in the audit log.

## Milestone 5 — what "complete" means here

PFT/ABG/sputum-induction booking in the scheduler's name, a fixed status workflow (closed statuses never change; reasons for cancel/no-show/for-reschedule), reschedule lineage with both rows kept, void instead of delete, list + month calendar views with date/status/OPD-INP/RT filters (codes only in URLs), appointment history, printable schedules. The PFT form is the official record (ADR-0008): versioned Chief-maintained template with placeholders, RT e-signature with step-up, pulmonologist sign-off recorded from an approved directory (wet signature, U-18), final records immutable, amendments append-only. Import wizard per `IMPORT_GUIDE.md`.

## Milestone 4 — what "complete" means here

Decision applied: only Respiratory Therapists enter or discontinue nebulization orders (U-17).
Orders are transcribed exactly as written and never edited (discontinue with a reason instead). Expected doses are derived only from the times written on the order and are never stored or auto-completed; an RT documents each outcome (given / not given / refused / delayed / cancelled — reason required for all but given) in their own name with the actual time (Asia/Manila), within a 72-hour late-entry window and not in the future. One outcome per dose; mistakes are voided with a reason (by the author or the Chief RT) and the dose re-opens. Ventilator hook-in (optionally documenting a new circuit), disconnection; no overlapping encounters; hook-in details immutable. Tubing replacements documented with reason, after hook-in and after the last replacement; voids restore the previous due date. Every write carries a client-generated id (idempotent retries — groundwork for Milestone 7 offline sync) and the device's capture time. Handover carries expected doses by order + slot.

## Milestone 3 — what "complete" means here

Decisions applied: sex Male/Female only (U-07); one handover per shift (U-11); hospital number optional (U-13).
Register patients (possible duplicates shown for explicit human review — same name in any order, or same date of birth with a shared name; never merged; an identical hospital number is refused); correct details with a reason, optimistic locking and an append-only correction history; Chief RT roster editing with soft removal; write the one handover per shift (only for the current or just-ended shift, by a rostered RT or the Chief RT) with open items linked to live records; acknowledgment by someone other than the author, after which the handover is frozen.

## Milestone 2 — what "complete" means here

PostgreSQL is the source of truth for every screen. Individual accounts with password + authenticator app; Chief RT invites/resets/deactivates RTs and revokes devices (with step-up re-authentication); settings editable and audited; row-level security on every table keyed to a validated session; append-only audit; nonce-based CSP; encrypted backup + restore drill. Clinical **write** workflows (documentation, registration, handover creation) are still Milestones 3–4.

## Milestone 1 — what "complete" means here

Read-only screens on synthetic data for all 16 modules; every write workflow is shown as an explicit "Milestone N" notice rather than a fake or dead control. Server-side permission checks on every page and API. No real authentication (demo session only, fail-closed). No database.

## Update 2026-11-23 (password-only sign-in; database hardening)

- Product owner: remove the authenticator. Sign-in, activation and "Confirm it's you" are password-only (ADR-0009). Lockout, rate limits, session limits and audit are unchanged.
- Migration 0015 (Supabase security advisor): RLS on `schema_migrations`; EXECUTE on every public function revoked from PUBLIC (which included Supabase's `anon`/`authenticated` API roles) and granted only to `puims_app`; `search_path` pinned on every function.
- Tests: 105 unit · 127 PostgreSQL · 82 Playwright.

## Update 2026-11-23 (import automation; booking dropdowns)

- Import: settings filled in automatically on upload (remembered from the last import; workbook year and date order inferred from the data, shown to the reviewer). New "Accept suggested repeat visits" links safe repeat visits; doubtful ones stay for a person.
- Booking: procedure is a dropdown of the unit's PFT procedures (plus "Other"); marking an appointment done asks which RT performed it (active accounts only).
- Tests: 105 unit · 129 PostgreSQL · 82 Playwright.

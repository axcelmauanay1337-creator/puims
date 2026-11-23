# PUIMS — Milestone 8 Security, Accessibility and Performance Review

Date: 2026-11-22. Scope: the whole repository after Milestones 5–7 (diagnostics, PFT record, import, reports/exports, offline capture). Reviewer: the development team (self-review). **This is not a substitute for the hospital's independent security assessment.**

## Method

Code review of every new route, server action and SQL policy against the threat model (`docs/THREAT_MODEL.md` v1.0); static checks; dependency audit; automated tests at three layers; manual click-through on desktop and phone sizes.

## Static checks (all clean)

| Check                                             | Result                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `npm audit`                                       | 0 vulnerabilities (exceljs → `uuid` pinned ≥ 11.1.1 via `overrides`) |
| `dangerouslySetInnerHTML` / `innerHTML` in `src/` | none (offline page builds DOM with `textContent`)                    |
| `console.*` logging in server code                | none (no request bodies or patient values logged)                    |
| `eval` / `new Function`                           | none                                                                 |
| Database errors returned to clients               | sanitized (`DbError` keeps only SQLSTATE + constraint)               |

## Findings fixed during the review

1. **U-09 policy slip** — an optional payment field had been added to booking and import. Removed from both; payment columns are now dropped from staged workbook rows like contact columns; migration 0009 adds `CHECK (payment_class IS NULL)`; tests added.
2. **Offline approval in hospital profiles** — added an interlock: in `lan`/`cloud` profiles the Chief RT cannot approve offline devices unless `PUIMS_OFFLINE_POLICY_APPROVED=true` (U-03). Tested.
3. **Key material in the audit log** — `audit_row_change()` now redacts `key_enc` (offline lease keys, even though encrypted). Tested.
4. **Raw workbook values in the audit log** — reviewer decisions on staged rows are audited with decision fields only, so discarding a batch really removes its staged values. Tested.
5. **Print output** — app chrome (sidebar, navigation) now hidden when printing PFT forms and schedules.
6. **Test-harness race** — parallel browser tests could draw the same one-time authenticator step (correctly rejected by the server as a replay); the helper now allocates steps under an exclusive lock. Product behaviour unchanged.

## New attack surface reviewed

| Surface                                                    | Controls                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/import/upload`                                  | Same-origin check, Chief only, rate limit (10/min), 10 MB, ZIP signature, sheet/row/column caps, formulas not evaluated, in-memory only                                                         |
| `GET /api/import/{id}/report`, `GET /api/reports/export`   | Chief only (RLS + permission), rate-limited exports, CSV formula escaping, `nosniff`, `no-store`, audited                                                                                       |
| `POST /api/offline/lease`, `/api/offline/key`, `/api/sync` | Same-origin check, signed-in session, rate limits, 2 MB body cap, device approval, staff+device+session binding, ≤ 200 entries per request, idempotency by entry id                             |
| Server actions (diagnostics, PFT, import, offline)         | Next.js origin check; permission check in code; re-checked by RLS and triggers; step-up for signing, finalizing, amending, template/directory changes, import commit/reversal, offline approval |
| `/offline-capture.html`                                    | Static, no inline script/style, strict CSP, no patient data in the HTML; data only from the encrypted IndexedDB snapshot                                                                        |

## Accessibility

Automated axe (WCAG 2.0/2.1 A + AA, serious/critical) passes on every main route plus the new appointment, PFT form, import batch and week/month/year report pages. Phone layout (Pixel 7 emulation): no horizontal overflow on Overview, Patients, Nebulization, Shifts, Reports (day and month), Devices, Diagnostics list and calendar, Import, Settings and the offline capture page. Status is never conveyed by colour alone (glyph + text). Remaining manual checks are in the UAT checklist (keyboard-only flows, screen reader spot checks).

## Performance (synthetic data: 48 patients, ~1 year history, 960 appointments, 1,135 nebulization records)

Production build, median of 3 server responses after warm-up (`tests/e2e/performance.spec.ts`, budget 3 s):

| Page                                                                       | Median                                                                                                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview `/`                                                               | 49 ms                                                                                                                                                    |
| Patients, Nebulization, Handover, Diagnostics list/calendar, Audit, Import | 31–36 ms                                                                                                                                                 |
| Reports (day / month)                                                      | 60 / 57 ms                                                                                                                                               |
| Reports (year)                                                             | ≈ 1,050 ms — computes every expected nebulization dose of the year from orders; acceptable for an on-demand management report; revisit with real volumes |

## Residual risks

See `docs/THREAT_MODEL.md` → "Residual risks (Milestone 8)".

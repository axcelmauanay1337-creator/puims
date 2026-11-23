# PUIMS — Clinical User Acceptance Test Checklist

Run in a **UAT environment with synthetic data** (`PUIMS_DEPLOYMENT_PROFILE=uat`), by the Chief RT and at least two RTs, on the devices the unit will actually use (ward PC, tablet/phone). Record pass/fail, tester, date and notes. Any fail → issue + retest. Automated tests already cover the technical rules; UAT checks that the workflow is right **for this unit**.

Tester: \***\*\_\_\*\*** Device/browser: \***\*\_\_\*\*** Date: \***\*\_\_\*\***

## A. Access

- [ ] Chief RT creates an RT account; RT activates with a password; signs in.
- [ ] Idle sign-out after the configured minutes; re-login works.
- [ ] RT cannot open Staff, Reports, Import, Audit (server says Access denied).
- [ ] Chief RT revokes a device; that browser is signed out immediately.

## B. Patients, shifts, handover

- [ ] Register a patient without hospital number; duplicate warning appears for a similar name; decision recorded.
- [ ] Correct a name with a reason; history shows before/after.
- [ ] Roster for today; handover written by the outgoing RT, acknowledged by the incoming RT; items show live status.
- [ ] An event at 02:30 counts in the previous operational date's Night shift.

## C. Nebulization, ventilation, tubing

- [ ] RT enters an order with written times; doses appear at those times only (none invented for "Q6H" without times).
- [ ] Given / refused (reason) / void with reason → dose re-opens.
- [ ] Chief RT has no "New order" (U-17).
- [ ] Hook-in, tubing replacement, disconnection; tubing due/overdue matches the policy in Settings (U-04 sign-off).

## D. Diagnostics

- [ ] Book PFT, ABG, sputum induction; calendar shows them on the right day/time.
- [ ] Mark done (performer = me), no-show (reason), cancel (reason); closed statuses cannot change.
- [ ] Reschedule: original shows "Rescheduled", follow-up linked both ways; history lists changes.
- [ ] Filters by date, status, OPD/INP, RT; print schedule; printable patient schedule.
- [ ] Booking cannot record payment (U-09).

## E. PFT form (official record)

- [ ] Layout matches the approved paper form (header, sections, order, signature areas, form code/revision). **Requires U-10 confirmation.**
- [ ] Clinical sections start empty; nothing generated; interpretation only at sign-off.
- [ ] Unsigned draft prints with "DRAFT — not an official record".
- [ ] RT signs (password + code); content locked; RT not in directory cannot sign.
- [ ] Pulmonologist sign-off recorded from the directory with transcribed interpretation; final prints correctly; amendment appended with reason. **U-18 decision recorded.**

## F. Reports

- [ ] Day/week/month/year figures match a manual count from the synthetic data for one chosen period.
- [ ] Definitions are understood and accepted by the Chief RT (unique patients, OPD/INP, tubing compliance, diagnostic rates, workload context).
- [ ] Exports download; the audit log shows each export.

## G. Import (synthetic workbook only)

- [ ] `npm run fixture:workbook` file staged; every flag type understood by the reviewer; declarations applied.
- [ ] Contact and payment columns are absent from the review screen.
- [ ] Dry run blocks commit until every row is decided; commit with password + code; reverse the batch.

## H. Offline (only if U-03 is approved for testing)

- [ ] Chief approves one device; RT prepares capture; airplane mode; document a dose and a tubing change; reload → Locked; reconnect → Unlock → Sync.
- [ ] Same dose documented online meanwhile → appears in Sync review as a conflict; resolved with a reason.
- [ ] Device clock changed by 10 minutes → entry goes to review.
- [ ] Withdraw approval → the device can no longer unlock or sync.

## I. Accessibility & devices

- [ ] Keyboard-only: sign in, document a dose, book an appointment.
- [ ] Phone: no sideways scrolling on the main screens; buttons easy to tap.

Sign-off — Chief RT: \***\*\_\_\*\*** Clinical governance: \***\*\_\_\*\***

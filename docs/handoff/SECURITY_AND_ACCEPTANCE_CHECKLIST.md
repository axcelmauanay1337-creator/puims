# PUIMS — Security, Clinical Safety, and Acceptance Checklist

## A. Identity and access
- [ ] Every RT has an individual account.
- [ ] Exactly designated Chief RT administrator role is provisioned through secure admin process.
- [ ] No client-side-only role checks.
- [ ] Server and database enforce authorization.
- [ ] Disabled/deactivated accounts cannot continue accessing server data.
- [ ] Device registration, expiry, and revocation are implemented.
- [ ] Sensitive actions require re-authentication where appropriate.

## B. Patient privacy
- [ ] No real patient data in seed data, screenshots, logs, telemetry, AI prompts, or public repositories.
- [ ] TLS for all application/API traffic.
- [ ] PHI excluded from URLs and notification previews.
- [ ] Exports are permission-controlled and audited.
- [ ] Retention, correction, access, and deletion rules approved by hospital.
- [ ] Privacy impact and vendor/hosting review completed by responsible hospital personnel.

## C. Clinical record integrity
- [ ] Actual event time is distinct from data-entry time and server sync time.
- [ ] Audit trail captures actor, device, action, target, time, and relevant before/after state.
- [ ] Finalized clinical records are not silently overwritten or deleted.
- [ ] Corrections are traceable.
- [ ] Offline queued records are visibly not yet synchronized.
- [ ] Idempotency prevents duplicate sync.
- [ ] Conflicts are surfaced for human resolution.
- [ ] No clinical interpretation, dose, order, or schedule is inferred by the software.
- [ ] Tubing replacement is never marked complete automatically.

## D. Offline and resilience tests
- [ ] App shell opens after initial authorized installation and sync.
- [ ] Airplane-mode behavior is tested.
- [ ] Hospital LAN-only behavior is tested.
- [ ] Complete network outage is tested.
- [ ] Local data is encrypted/protected to approved standard.
- [ ] Local authorization expires and requires re-authentication.
- [ ] Device deauthorization behavior is documented, including inability to wipe a device while offline.
- [ ] App restart does not lose queued entries.
- [ ] Storage quota/full condition is handled without claiming save success.
- [ ] Clock skew is detected/flagged.
- [ ] Reconnect retries safely.
- [ ] Duplicate submission/retry does not create duplicate clinical records.
- [ ] Conflict review works.
- [ ] Last successful sync and data freshness are visible.
- [ ] Devices do not appear to share new entries during complete isolation.

## E. Time and shift tests
- [ ] 05:59 belongs to previous operational date/night shift.
- [ ] 06:00 begins new operational date/morning shift.
- [ ] 13:59 morning; 14:00 afternoon.
- [ ] 21:59 afternoon; 22:00 night.
- [ ] 00:00–05:59 belongs to prior operational date.
- [ ] Calendar-day and operational-day reports are independently correct.
- [ ] All calculations use `Asia/Manila`.

## F. Import tests
- [ ] Original workbook checksum retained.
- [ ] Sheet and source row provenance retained.
- [ ] Raw values retained.
- [ ] Ambiguous date and age/sex formats flagged.
- [ ] Malformed year values not silently corrected.
- [ ] Contact notes are not blindly interpreted as phone numbers.
- [ ] Repeat/rescheduled appointments retained.
- [ ] Possible duplicates are reviewed, not auto-deleted.
- [ ] Dry-run and import exception report work.
- [ ] Commit requires authorized human approval.

## G. Clinical workflow UAT
- [ ] Patient registration and search.
- [ ] Nebulization order reference and actual administration.
- [ ] Not-given/refused/cancelled reason capture.
- [ ] Ventilator hook-in and disconnection.
- [ ] Tubing install/replacement and 7-day due/overdue calculation.
- [ ] PFT, ABG, sputum induction scheduling.
- [ ] PFT form printable and matches approved source layout.
- [ ] Shift handover and acknowledgment.
- [ ] Chief RT consolidated report.
- [ ] Monthly census and service trend definitions validated.

## H. Release gate
Do not enable real patient data or clinical use until the hospital's authorized IT/security, DPO/privacy, clinical governance, and relevant infection-prevention leadership have approved:
- hosting and data processing;
- access model;
- offline data scope;
- device management;
- backup/restore;
- retention and incident response;
- clinical forms and workflows;
- tubing replacement interval and exceptions;
- user acceptance test results.

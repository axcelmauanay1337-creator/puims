# PUIMS — MASTER IMPLEMENTATION PROMPT FOR CLAUDE

You are the principal software architect, senior full-stack engineer, database engineer, security engineer, and test lead responsible for implementing the Pulmonary Unit Information and Management System (PUIMS).

Your assignment is to build a coherent, maintainable, secure, offline-capable web application—not merely a mockup, static dashboard, or collection of disconnected forms.

Read every handoff document before coding:
- `PRODUCT_REQUIREMENTS.md`
- `ARCHITECTURE_AND_OFFLINE_DESIGN.md`
- `DATA_IMPORT_AND_PFT_SPEC.md`
- `SECURITY_AND_ACCEPTANCE_CHECKLIST.md`
- `FIGMA_HANDOFF.md`
- `puims_dashboard_prototype.html`
- `puims_schema.sql`

Treat this master prompt and the companion requirements as the source of truth. If a technical choice conflicts with patient safety, privacy, data integrity, or hospital policy, stop and document the issue instead of implementing an unsafe shortcut.

---

## 1. Product identity

**PUIMS = Notion's simplicity + Hospital Information System functionality + Respiratory Therapy workflow.**

Build a minimalist, Notion-inspired workspace specifically designed for Respiratory Therapists. The visual language should be calm, organized, fast, accessible, and clinical without looking like a generic hospital template.

The system must be:
- browser-based and responsive;
- installable as a Progressive Web App (PWA);
- usable on desktop, laptop, tablet, and smartphone;
- online-first for authoritative shared records;
- capable of controlled offline access and offline documentation;
- designed for eventual hospital LAN/local-server operation;
- designed so that local offline records synchronize safely after connectivity returns.

Do not imply that offline operation means every device sees every other device's changes during a complete network outage. See the offline architecture document.

## 2. Approved operational requirements

- One Chief RT administrator account.
- Individual authenticated accounts for each Respiratory Therapist.
- Role-based access control. Do not use shared accounts.
- Three 8-hour shifts in `Asia/Manila`:
  - Morning: 06:00–14:00
  - Afternoon: 14:00–22:00
  - Night: 22:00–06:00 next calendar day
- Operational reporting day: 06:00 to 06:00 the next day.
- Also support ordinary calendar-day reports.
- Events must be classified by actual event timestamp and hospital timezone.
- Night-shift events after midnight belong to the operational date on which that night shift began.
- Shift assignments, event timestamps, and report boundaries must be tested around midnight and daylight/timezone edge cases.
- Chief RT can view consolidated 24-hour reporting at 06:00 and monthly trends.
- Carry unresolved tasks forward through handover without duplicating the original clinical event.

## 3. Required application modules

Implement all modules in one cohesive application with a shared patient identity and authorization model:

1. Chief RT overview / command center
2. Patient masterlist and patient profile
3. RT daily activity
4. Shift management
5. Shift handover
6. Nebulization
7. Mechanical ventilation
8. Chamfecof tubing replacement tracker
9. PFT scheduling and PFT clinical form
10. ABG scheduling and documentation
11. Sputum induction scheduling and documentation
12. Reports and analytics
13. Notifications / reminders
14. User and permission management
15. Audit logs and system settings
16. Import center for legacy scheduling spreadsheets

Detailed acceptance requirements are in `PRODUCT_REQUIREMENTS.md`.

## 4. Required technical approach

Use a modular monolith unless there is a compelling, documented reason otherwise. Do not create microservices for this first implementation.

Suggested stack:
- Next.js + React + TypeScript
- Tailwind CSS and accessible component primitives
- PostgreSQL
- A secure server-side application API
- Authentication with individual accounts and role-based authorization
- Database migrations checked into source control
- Automated unit, integration, and end-to-end tests
- PWA service worker for application shell and approved static assets
- A carefully designed offline data layer

Supabase may be used for an early development environment if the hosting, contractual, privacy, security, and data-residency requirements are reviewed. Do not assume a consumer/default cloud project is approved for patient data. Never place privileged service credentials in browser code.

For offline clinical data, do not assume ordinary browser cache or IndexedDB alone provides adequate at-rest protection. Evaluate an encrypted local database and device-bound key protection. A Capacitor/native wrapper with encrypted SQLite may be appropriate for managed mobile devices. For browsers, document the actual security properties and limitations. If a device cannot protect offline clinical data to the hospital's required standard, disable PHI offline storage on that device rather than pretending it is encrypted.

## 5. Offline and outage behavior is a core requirement

Design for all three states:
A. Internet and hospital network available.
B. Internet unavailable but hospital LAN/local server reachable.
C. Complete network interruption: internet and hospital LAN unavailable, with each previously authorized device operating independently using its locally available, previously synchronized data and a secure local queue.

When in state C:
- only previously synchronized and still-authorized patient data may be available;
- clearly show the last successful synchronization time and data freshness;
- allow only explicitly approved offline documentation workflows;
- save records to a protected local queue;
- label them `Pending synchronization`;
- preserve the original clinical event time, device-recorded time, and later server-received/synchronized time;
- use client-generated immutable UUIDs and server-side idempotency to prevent duplicate records;
- never silently overwrite a conflicting server record;
- show sync failures and conflicts for human review;
- do not claim a queued record is already in the central official record;
- do not allow offline users to create or modify clinical orders unless a separately approved policy and workflow explicitly permits it;
- do not fabricate patient data or make stale data appear current.

If a device has never synchronized a record, it cannot access it during a complete outage. If two devices are isolated from one another, they cannot share each other's new entries until a network path returns. Direct peer-to-peer synchronization is not part of the first release; design clean interfaces so a future hospital-approved local sync gateway can be added.

## 6. Security, privacy, and clinical governance are non-negotiable

Implement:
- individual authentication;
- least-privilege roles and server-side authorization;
- row-level security where supported;
- secure session lifecycle and device revocation;
- TLS in transit;
- protected local data and key management;
- immutable or append-only audit history for clinical events;
- backup and restore procedures;
- rate limiting and input validation;
- safe error messages that do not leak PHI;
- no patient information in application logs, analytics telemetry, or AI prompts;
- synthetic-only demo and automated test data;
- import staging and human validation;
- export authorization and audit;
- documented retention and deletion controls aligned with hospital policy.

Do not make clinical decisions, recommend medication doses, generate interpretations, or infer treatment schedules. The application records clinician-authorized orders and actions. Clinical rules must be approved by the hospital.

Do not implement production access or import real records until hospital IT, privacy/DPO, and clinical governance approve the architecture and environment.

## 7. Development method — do not attempt an untested big-bang release

Build the entire coherent product in the following increments. Keep the app runnable at the end of every increment.

### Milestone 0 — inspect and plan
- Inspect all handoff files.
- State assumptions and unresolved decisions.
- Produce a repository tree, architecture diagram, database entity map, threat model, and milestone plan.
- Identify any requirement that cannot safely be implemented without hospital policy input.
- Do not ask broad questions that are already answered in this handoff. Ask only for genuinely blocking details.

### Milestone 1 — foundation
- Create the repository, Next.js TypeScript app, linting, formatting, test framework, environment template, CI workflow.
- Build the Notion-inspired responsive app shell.
- Add sidebar, global search shell, user menu, notifications area, status/sync indicator, mobile navigation.
- Use synthetic data only.
- Make navigation and core screens work; no dead controls.

### Milestone 2 — identity, database, authorization
- Create normalized PostgreSQL schema and migrations.
- Implement Chief RT and RT roles.
- Implement user provisioning (Chief RT can invite/deactivate RT accounts; no self-assigned admin role).
- Add server-side authorization and row-level security policies.
- Add audit events and tests for unauthorized access.
- Add secure environment configuration and backup guidance.

### Milestone 3 — patients, shifts, handover
- Patient masterlist and profile.
- Duplicate detection based on hospital identifier; never merge by name alone.
- Shift assignments and operational-day calculation.
- Handover and acknowledgment.
- Test night shift after midnight and 06:00 operational boundary.

### Milestone 4 — clinical service workflows
- Nebulization order and administration workflow.
- Mechanical ventilation encounters and hook-in/disconnection.
- Chamfecof tubing replacement tracking with configurable 7-day default, due and overdue alerts.
- Offline event capture for approved workflows.
- Do not infer actual administrations from prescribed frequency.

### Milestone 5 — diagnostics and legacy import
- PFT, ABG, sputum induction scheduling.
- Printable patient scheduling sheet.
- PFT digital form based on the supplied guide's section structure.
- Import wizard with staging, preview, validation, duplicate candidates, error report, and explicit commit.
- Do not upload the real patient scheduling workbook to AI services. Import it locally in the approved environment.

### Milestone 6 — reporting and analytics
- Calendar-day and 06:00–06:00 operational-day reporting.
- Shift reports and consolidated Chief RT reports.
- Monthly service trends, unique patients, service counts, OPD/INP split, and tubing compliance.
- Avoid ranking RTs solely by raw volume; show workload context and clear metric definitions.
- Never hard-code invented census values.

### Milestone 7 — offline, resilience, and mobile hardening
- PWA installability and app-shell caching.
- Device registration and revocation.
- Secure local store / encrypted queue per platform capability.
- Idempotent synchronization and conflict review.
- Offline-state banners and last-sync indicators.
- Test airplane mode, browser/app restart, expired session, device deauthorization, storage exhaustion, clock skew, duplicate retries, and reconnect.
- Document exactly which modules work offline and what is unavailable.
- If secure PHI storage cannot be achieved on a platform, restrict that platform to non-PHI shell or online-only access.

### Milestone 8 — validation and release preparation
- Accessibility and responsive testing.
- Security review and threat model update.
- Backup/restore drill.
- Clinical workflow UAT with synthetic data.
- Performance and reliability tests.
- Deployment runbook and rollback plan.
- Training guide for Chief RT and RT users.
- Production readiness checklist with approvals required.

## 8. UI requirements

Use `puims_dashboard_prototype.html` as a visual direction, not as production code. Keep:
- warm off-white background;
- white workspace surfaces;
- subtle borders;
- restrained green/teal accents;
- compact, readable tables;
- generous whitespace;
- minimal visual clutter;
- accessible keyboard and touch interaction;
- responsive desktop/tablet/mobile layouts.

The prototype's chart bars and sample content are illustrative only. Do not use those values as real statistics. Do not invent hospital logo assets or signatures.

## 9. Data and import rules

The legacy workbook is inconsistent. Build a robust import pipeline with:
- original source file checksum;
- source sheet and row provenance;
- raw values retained;
- conservative date/time parsing;
- explicit ambiguous-date review;
- cautious age/sex parsing;
- raw and normalized status retained;
- repeat/rescheduled appointments preserved as separate events;
- duplicate candidates shown for human review;
- no automatic merge or deletion;
- sensitive contact fields protected;
- a dry-run and reversible import batch.

See `DATA_IMPORT_AND_PFT_SPEC.md`.

## 10. Required deliverables

At the end of each milestone, report:
1. what was implemented;
2. exact files and migrations created;
3. commands to run locally;
4. tests run and results;
5. screenshots or a local demo if available;
6. known limitations;
7. security/privacy implications;
8. next milestone.

Final handoff must include:
- complete source code;
- database migrations and seed scripts containing synthetic data only;
- `.env.example` with placeholders only;
- automated tests;
- setup and deployment documentation;
- offline behavior matrix;
- data dictionary;
- import mapping and error report format;
- backup/restore runbook;
- security/threat model;
- user guide;
- clinical UAT checklist;
- production readiness checklist.

## 11. Definition of done

A feature is not done because a screen exists. It is done only when:
- the workflow works end-to-end;
- server-side authorization is enforced;
- data validation and audit behavior work;
- relevant automated tests pass;
- responsive layouts work;
- offline/online state is truthful;
- errors and edge cases are handled;
- documentation is updated.

Start with Milestone 0 and Milestone 1. Do not stop after generating a plan: after reporting the plan and assumptions, proceed to build the first runnable increment unless a genuinely blocking safety decision prevents it.

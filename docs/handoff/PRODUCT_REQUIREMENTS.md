# PUIMS — Product Requirements

## 1. Users and permissions

### Chief RT administrator
- One designated Chief RT administrator account initially.
- Manage RT accounts: invite, activate, deactivate, reset access through approved auth flow.
- View all Pulmonary Unit patients and service records as authorized.
- Manage shift assignments and operational settings.
- View all reports, monthly trends, and audit history.
- Review import batches and approve commits.
- Configure reminder settings within approved policy.

### Respiratory Therapist
- Individual account; no shared accounts.
- View and document only within assigned permissions.
- Search authorized patient records.
- Record service events, handovers, and assigned activity.
- View own activity and relevant unit schedules.
- Cannot grant roles, alter audit history, or bypass restrictions.

Enforce permissions on the server and database, not merely by hiding UI buttons.

## 2. Navigation / information architecture

WORKSPACE
- Overview
- Patient Masterlist
- RT Daily Activities
- Shift Handover

CLINICAL SERVICES
- Nebulization
- Mechanical Ventilation

DIAGNOSTICS
- PFT Scheduling
- ABG
- Sputum Induction

MANAGEMENT
- Shift Management
- RT Staff
- Reports & Analytics
- Import Center

SYSTEM
- Notifications
- Audit Logs
- Settings
- Device Management / Sync Status

## 3. Dashboard

### RT view
Show only relevant authorized information:
- current shift and assigned RT;
- operational date and current shift;
- patients/events relevant to the RT's scope;
- pending tasks and handover items;
- today's diagnostic schedule;
- tubing due/overdue alerts;
- sync status and last successful sync;
- quick actions for permitted documentation.

### Chief RT view
In addition to the above:
- unique patients served;
- service volume by type;
- active ventilator encounters;
- tubing upcoming/due/overdue;
- nebulization scheduled/completed/not given;
- diagnostic schedule and status;
- shift snapshots;
- daily, monthly and year-to-date trends;
- OPD vs INP split;
- RT workload context and activity audit.

No fake or hard-coded census metrics. Empty states must be explicit.

## 4. Patient masterlist

Fields:
- internal UUID;
- unique hospital patient number / MRN (required when available and per hospital policy);
- full name;
- date of birth;
- age calculated from DOB where permitted (do not overwrite source age);
- sex field according to hospital-approved values;
- patient category: OPD / INP / other;
- ward / room;
- relevant contact information only if approved and necessary;
- created/updated metadata;
- provenance for imported records.

Requirements:
- search by hospital ID and name;
- duplicate candidate detection;
- never merge on name alone;
- retain historical service encounters if patient location changes;
- maintain correction history;
- do not expose patient information in URLs, telemetry, logs, or browser error traces.

## 5. Nebulization

Capture:
- patient;
- authorized order reference / prescriber;
- medication name as ordered;
- frequency preset: STAT, once, BID, TID, QID, Q4H, Q6H, Q8H, Q12H, PRN, custom;
- explicit prescribed scheduled times where applicable;
- order start/end;
- actual administration date/time;
- administering RT;
- status: scheduled, pending, in progress, completed, not given, refused, cancelled, delayed (configure approved vocabulary);
- reason if not administered;
- notes and audit metadata.

Rules:
- Do not calculate or invent exact administration times from frequency alone.
- Do not create medication orders or doses by inference.
- Offline: allow only approved documentation against a previously synchronized active order; do not create/modify orders offline by default.
- Record scheduled time separately from actual administration time.

## 6. Mechanical ventilation

Capture:
- patient and encounter;
- hook-in timestamp;
- disconnection timestamp;
- ventilator identifier / model / serial number where approved;
- ward/room;
- responsible RT;
- status active/discontinued;
- clinical notes as approved;
- complete history.

A patient may have multiple ventilation encounters over time. Do not overwrite history.

## 7. Chamfecof tubing replacement tracker

- Default interval: 7 calendar days, configurable only by authorized admin and subject to approved policy.
- Record tubing type, installation/replacement timestamp, performer, reason, linked ventilator encounter.
- Show next due date/time.
- Alert upcoming, due, overdue.
- Never mark a replacement as completed automatically.
- A replacement event must be explicitly documented by an authenticated RT.
- Confirm interval and exceptions with infection prevention, manufacturer instructions, and hospital policy before production.
- Preserve replacement history.

## 8. Diagnostics

Services:
- PFT
- ABG
- Sputum induction

Scheduling fields where applicable:
- patient;
- OPD/INP;
- date/time;
- age/sex as source values and normalized values separately where needed;
- requesting physician;
- procedure/test type;
- status;
- payment classification if hospital policy permits;
- RT scheduler;
- performed by;
- remarks;
- source provenance for imported appointments.

Statuses should support scheduling reality, including scheduled/pending, done/completed, no-show, cancelled, for-reschedule/rescheduled. Preserve raw imported status.

Provide:
- calendar and table views;
- filtering by date, service, status, OPD/INP, RT;
- printable patient schedule;
- individual appointment history;
- repeat appointment and reschedule lineage without collapsing distinct events.

## 9. PFT digital documentation form

Use the supplied PFT guide workbook as the structure reference. Preserve its major sections:
- Facility header and PULMONARY FUNCTION TEST title.
- Date.
- Patient information: name, sex, age, birthdate, hospital number, weight, height, room/outpatient, requesting physician, HMO, test type.
- Technician's comments.
- Patient's spirometry history.
- Purpose of test.
- Patient's smoking history.
- Patient's medication.
- Patient observation.
- Bronchodilator note present in the source template (Salbutamol via MDI); preserve as a template statement only if confirmed by the hospital and do not interpret it as a universal instruction.
- Interpretation section.
- Respiratory Therapist and Pulmonologist signature areas.
- Form identifier shown in source template: AS-PUL-PFT-006.

The source workbook has separate `Patient Data`, `RT signature`, and `Pulmo Signature` sheets. Do not reproduce or expose embedded staff/provider names in development fixtures. Populate signature selectors only from an approved, maintained directory. Do not invent clinical interpretation or auto-sign.

The PFT form should be printable and preserve a clear, professional layout. Confirm with clinical leadership whether the digital form is a legal clinical record or a working worksheet.

## 10. RT daily activities

- Track service event counts by authenticated RT and timestamp.
- Show context such as shift, service type, completed/pending status.
- Do not use raw event counts as a simplistic staff ranking or substitute for workload complexity.
- Audit changes and corrections.

## 11. Shift management

Timezone: `Asia/Manila`.

Shifts:
- Morning 06:00–14:00.
- Afternoon 14:00–22:00.
- Night 22:00–06:00 next day.

Operational day:
- starts 06:00 local time;
- ends 06:00 next day.

Provide:
- assignment calendar;
- assigned RTs;
- shift handover;
- event-to-shift classification based on actual event time;
- reports by operational date and calendar date;
- correct attribution for events between midnight and 05:59 to the previous operational date's night shift.

## 12. Shift handover

Capture:
- operational date and shift;
- outgoing RT and incoming RT;
- active ventilator encounters;
- open nebulization/treatment tasks;
- tubing upcoming/due/overdue;
- pending diagnostic appointments;
- equipment concerns;
- free-text handover notes;
- creation and acknowledgment timestamps;
- acknowledgment by incoming RT.

Carry open items forward as references to original records. Do not duplicate the underlying clinical service event.

## 13. Reports and analytics

- calendar-day reports;
- 06:00–06:00 operational-day reports;
- shift reports;
- weekly/monthly/yearly views;
- unique patients served (define counting logic);
- service counts by type;
- OPD/INP split;
- diagnostics scheduled/completed/no-show/cancelled;
- active ventilator census;
- tubing replacement compliance;
- trends by month to identify surges;
- downloadable/printable reports subject to role permission and audit.

Every metric needs a documented definition, filter, and timezone rule.

## 14. Offline support

See `ARCHITECTURE_AND_OFFLINE_DESIGN.md`. The UI must always show:
- online / local-server / offline mode;
- last successful synchronization;
- pending queue count;
- sync errors/conflicts;
- whether displayed patient data is stale.

Offline functionality must be explicitly scoped and security-approved per device platform.

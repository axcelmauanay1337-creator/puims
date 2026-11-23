# PUIMS — Architecture and Online/Offline Design

## 1. Recommended architecture

Use a modular monolithic web application with:
- responsive Next.js/React/TypeScript frontend;
- server-side API and authorization;
- PostgreSQL authoritative database;
- individual authentication;
- PWA app shell;
- offline queue and synchronization engine;
- optional hospital-managed on-premises deployment / LAN endpoint;
- managed-device support for secure offline clinical storage.

Avoid microservices for the first release.

## 2. Three operating modes

### Mode A — Online
Internet and hospital network are available.
- Full authorized application.
- Central database is authoritative.
- Shared records and reports update through server APIs.
- Device sync status is visible.

### Mode B — Internet unavailable, hospital LAN/local server reachable
- Device connects to the hospital local PUIMS endpoint.
- Shared records remain available if the on-premises service and database are healthy.
- Remote cloud features may be unavailable.
- The application must distinguish LAN connectivity from internet connectivity.

### Mode C — Complete network outage
Internet and hospital LAN are unavailable.
- Each device works independently from its previously synchronized, approved local data.
- The device can record only explicitly permitted offline events.
- New offline entries stay in a protected local queue.
- Other isolated devices cannot see those new entries until connectivity returns.
- The UI must make this limitation obvious.

Do not promise cross-device collaboration during a total network outage. Direct peer-to-peer synchronization is deferred until a separately approved design and security review.

## 3. Data authority and sync

The central PostgreSQL database is the authoritative shared record when reachable. A local server may serve as an approved hospital LAN endpoint, but avoid uncontrolled multi-master databases.

Each offline mutation should be represented as an immutable event:
- client-generated UUID;
- user ID and device ID;
- patient and source record IDs;
- event type and payload;
- clinical event time (`occurred_at`);
- local capture time (`recorded_at_device`);
- device timezone and clock metadata;
- sync state;
- server receipt time (`received_at_server`);
- server commit time (`committed_at_server`);
- schema/version identifier.

Synchronization:
1. Authenticate device/user when connection returns.
2. Validate device status and account status.
3. Submit queued events in stable order where dependencies require it.
4. Enforce idempotency using immutable event UUID.
5. Re-check server authorization and business rules.
6. Validate patient and source record references.
7. Detect stale or conflicting updates.
8. Append accepted event to official history and audit log.
9. Return accepted/rejected/conflict state for each event.
10. Retain local copy until server acknowledgment and approved retention cleanup.

Never use last-write-wins for clinical records. Never silently discard a queued entry. Conflicts require explicit resolution and audit.

## 4. Offline data scope

Default allowed offline:
- app shell and static resources;
- user profile and role claims with expiry;
- shift roster relevant to the user;
- limited, previously synchronized patient records required for assigned work;
- relevant upcoming diagnostic schedule;
- active ventilation encounter summaries and tubing due information;
- active nebulization order details needed to document against an existing order;
- offline handover drafts;
- permitted clinical event drafts/records.

Default prohibited offline:
- create or modify medication orders;
- create new patient identities unless a hospital-approved emergency registration workflow exists;
- unrestricted patient masterlist download;
- bulk export of patient data;
- edit or delete finalized server records;
- auto-sign clinical documentation;
- overwrite conflicts;
- view records outside the user's authorization or cache scope.

All offline scope must be configurable by hospital policy and tested.

## 5. Local storage security

A PWA service worker cache is for the application shell and approved static assets, not a place to cache patient records indiscriminately.

Do not claim IndexedDB is automatically encrypted. Do not claim browser storage is secure merely because the site uses HTTPS.

Evaluate:
- managed devices and full-disk encryption;
- app-level encryption using WebCrypto;
- key protection and lifecycle;
- secure device registration;
- local database encryption;
- lock timeout and re-authentication;
- device revocation behavior;
- secure wipe limitations while device is offline;
- local storage quota and eviction behavior.

For managed iOS/Android devices, evaluate a native wrapper (e.g. Capacitor) with encrypted SQLite and keys held in platform secure storage. Select maintained libraries only after checking support, security history, licensing, and compatibility. For desktop browser offline PHI, document limitations; if required protection cannot be demonstrated, keep PHI online-only on that platform.

When a device is revoked while offline, immediate remote wipe cannot be guaranteed. Use short-lived offline authorization leases, local lock, expiry, and documented residual-risk handling.

## 6. PWA and device experience

- Installable app where supported.
- Responsive desktop/tablet/mobile layouts.
- Clear online, LAN-only, offline, sync-pending, conflict, and stale-data states.
- Show last successful sync timestamp.
- Provide a manual sync action and safe automatic retry.
- Do not repeatedly prompt for installation.
- Do not cache PHI in browser history, URL query strings, or notification previews.
- Lock the application after inactivity.
- Re-authenticate for sensitive actions.
- Respect device orientation and touch targets.

## 7. Offline event examples

### Nebulization administration
Offline documentation is allowed only against a previously synchronized active authorized order. Record actual administration time, performer, status, and reason if not given. Do not create/modify the order offline.

### Ventilator event
Allow approved encounter event documentation only if the encounter is in the authorized local cache. Record event type, event time, performer, and relevant equipment reference.

### Tubing replacement
Allow recording a replacement only if the active ventilator encounter is locally available and the user is authorized. Calculate due date using approved interval configuration; do not auto-mark replacement.

### Diagnostics
Allow permitted appointment updates only if the appointment is cached and the operation is approved. Do not create or reschedule appointments offline by default.

## 8. Local server / hospital network

Plan for deployment profiles:
- development;
- test/UAT;
- approved hospital LAN/on-premises;
- approved remote/cloud endpoint if hospital permits.

If an on-premises server is used, provide:
- secure LAN DNS endpoint;
- TLS even on LAN;
- firewall/network segmentation guidance;
- monitored database and application service;
- backup and restore;
- patching and access controls;
- local-to-remote replication or backup strategy approved by IT.

Do not design the on-premises and cloud database as uncontrolled writable peers. Choose one authoritative database per deployment topology and document failover.

## 9. Time and shift classification

All stored timestamps should be timezone-aware UTC instants plus the hospital timezone context. Display in `Asia/Manila`.

Shift classification:
- Morning 06:00 inclusive to 14:00 exclusive.
- Afternoon 14:00 inclusive to 22:00 exclusive.
- Night 22:00 inclusive to 06:00 next day exclusive.
- Operational date changes at 06:00 local time.
- At 00:00–05:59, operational date is the previous calendar date.

Server is authoritative for classification. Offline clients may display provisional classification and reconcile on sync. Test exact boundaries 05:59, 06:00, 13:59, 14:00, 21:59, 22:00, 23:59, 00:00.

## 10. Deferred capability

Local device-to-device or peer-to-peer sync is not part of the first release. After secure single-device offline operation is proven, assess a hospital-managed local sync gateway that devices can reach over a dedicated local Wi-Fi network. Do not introduce ad hoc Bluetooth/Wi-Fi Direct patient-data exchange without a separate threat model, identity model, conflict strategy, and IT approval.

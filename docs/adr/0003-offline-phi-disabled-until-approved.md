# ADR-0003: No offline PHI until a platform passes security review

Status: Superseded in part by ADR-0007 (Milestone 7). The "no offline PHI" rule still holds for every device the Chief RT has not approved, and for every `lan`/`cloud` deployment until U-03 is approved.

**Context.** Browser storage (IndexedDB, Cache Storage) is not encrypted at rest by the browser; key protection in a pure web app is limited. Revocation cannot reach an offline device.

**Decision.** Milestone 1 stores no patient data on devices. The service worker caches only static, PHI-free assets and an offline notice page. Milestone 7 will evaluate (a) WebCrypto-encrypted IndexedDB with non-extractable keys and short leases for managed desktops, and (b) a Capacitor wrapper with encrypted SQLite and platform keystore for managed mobile devices. Any platform that cannot meet the hospital's standard stays online-only.

**Consequences.** During a complete outage (mode C) the current release offers no documentation; the UI says so explicitly and points to the unit's downtime procedure (U-16).

# PUIMS — Offline Behaviour Matrix

Truth table for the **current release** (Milestone 8). The same matrix is shown in-app on _Devices & Sync_.

Modes (ARCHITECTURE_AND_OFFLINE_DESIGN.md §2): **A** internet + LAN · **B** LAN / local server only · **C** complete outage.

> Offline capture is an **interim design awaiting hospital approval (U-03)**. It is off for every device until the Chief RT approves that device, and in `lan`/`cloud` deployments it cannot be approved at all until `PUIMS_OFFLINE_POLICY_APPROVED=true` is set after IT + DPO sign-off.

| Capability                                                       | A · Online                                                     | B · LAN only                                      | C · Complete outage                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Open app shell                                                   | Yes                                                            | Yes                                               | Static offline notice (`/offline.html`); `/offline-capture.html` on prepared devices                                                        |
| Connection state shown                                           | "Online"                                                       | "Local server" when the server's profile is `lan` | "Offline — PUIMS server unreachable" (main app and capture page)                                                                            |
| View patients, schedules, reports                                | Yes                                                            | Yes, if the LAN server and DB are healthy         | **No.** Only the prepared worklist snapshot (pending doses, active ventilators) on an approved, prepared device, while its page is unlocked |
| Document nebulization doses                                      | Yes                                                            | Yes                                               | Approved + prepared devices: saved encrypted on the device, sent later                                                                      |
| Document tubing replacements                                     | Yes                                                            | Yes                                               | Same as above                                                                                                                               |
| Hook-in / disconnection, diagnostics, PFT form, handover, import | Yes                                                            | Yes                                               | **No** — online only                                                                                                                        |
| Enter or discontinue nebulization orders (RTs only)              | Yes                                                            | Yes                                               | Never offline                                                                                                                               |
| Register patients                                                | Yes                                                            | Yes                                               | Never offline                                                                                                                               |
| See other devices' new entries                                   | Via server                                                     | Via LAN server                                    | No — the snapshot is not refreshed offline                                                                                                  |
| Pending queue count / last sync                                  | Capture page status bar; _Devices & Sync_                      | same                                              | Capture page status bar                                                                                                                     |
| Conflicts                                                        | _Devices & Sync → Sync review_                                 | same                                              | Detected when the entry reaches the server                                                                                                  |
| Clock skew detection                                             | Every probe (30 s); checked again at sync (> 5 min → conflict) | same                                              | Last measured value only                                                                                                                    |

## How an offline entry is protected and synchronized

1. **Approve** (Chief RT, step-up): _Devices & Sync → Approve for offline…_ on one device.
2. **Prepare** (RT, online, signed in): open `/offline-capture.html` → _Prepare offline capture_. The server issues a lease (≤ 12 h, never past the session) with a random AES-256 key and a minimal snapshot. The key is imported as a non-extractable WebCrypto key and kept **in memory only**; the snapshot is sealed (AES-GCM, bound to the lease) into IndexedDB.
3. **Capture** offline: each entry gets a client UUID and the device time and is sealed into IndexedDB. The page reads it back before saying "saved"; if storage is full it says the entry was **not** saved.
4. **Reload or close** while offline: the key is gone, the encrypted entries stay. The page shows _Locked_ with the count; it can be unlocked only by reconnecting and signing in (key released to the same staff + device + valid session).
5. **Sync** when PUIMS is reachable: entries go through the same validated write path as online documentation. Each is recorded in `sync_event` with one outcome — `ACCEPTED`, `DUPLICATE` (retry), `CONFLICT` (already documented, clock skew > 5 min, captured outside the lease) or `REJECTED` (invalid). The device deletes an entry only after the server acknowledges it.
6. **Review**: conflicts and rejections wait in _Sync review_. The capturing RT may _apply after checking_ (in their own name) or anyone authorized may record _do not apply_ with a reason. Never last-write-wins, never silently dropped.

## Honest limits

- While the capture page is unlocked, anyone using that browser can see the snapshot.
- A revoked device that never reconnects keeps its encrypted data; it cannot be wiped remotely. The server refuses its key and its sync.
- Clearing browser data deletes unsent entries. Document on paper whenever unsure.
- IndexedDB is **not** encrypted by the browser; PUIMS encrypts the records itself as described. Approve only managed devices with OS disk encryption and a screen lock.

## Tests

Unit: sealing, non-extractable keys, queue acknowledgment, storage-full, expired lease (`tests/unit/offline-queue.test.ts`). Database: approval + step-up, lease limits, key release rules, idempotent retry, conflict instead of overwrite, clock skew, revoked device, `lan` interlock (`tests/db/milestone7.test.ts`). Browser (Playwright): unapproved device refused, Chief approval, airplane-mode capture → reload (locked, ciphertext only) → reconnect → unlock → sync (`tests/e2e/offline.spec.ts`).

# PUIMS — User Guide (Chief RT and Respiratory Therapists)

PUIMS is **not validated for clinical use**. This environment contains synthetic data only. All times are Asia/Manila. An operational day runs 06:00 → 06:00; shifts are Morning 06–14, Afternoon 14–22, Night 22–06.

## Signing in

1. Username + password.
2. You are signed out after 15 minutes without activity and after 12 hours at most.
3. Some actions ask **"Confirm it's you"** (your password again): account and device changes, settings, PFT signing/finalizing/amending, signatory and template changes, import commit/reversal, offline device approval.
4. Forgot your password or lost your phone? Ask the Chief RT to reset your access — they give you a new one-time activation link in person.

## For every RT

| Task                                      | Where                                                                                     | Notes                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find a patient                            | Search box (Ctrl K) or Patient Masterlist                                                 | Search terms never appear in the address bar                                                                                                                         |
| Register / correct a patient              | Patient Masterlist → New patient; patient → Edit                                          | Possible duplicates are shown for you to decide; identity corrections need a reason                                                                                  |
| Nebulization orders                       | Nebulization → New order                                                                  | RTs only. Enter exactly as written, including the times. Orders are never edited — discontinue with a reason and enter a new one                                     |
| Document a dose                           | Nebulization worklist → Document                                                          | Given / not given / refused / delayed / cancelled; reason needed unless given; up to 72 h late, never in the future. Wrong entry → Void with reason                  |
| Ventilator hook-in, disconnection, tubing | Mechanical Ventilation, Change of Tubing                                                  | Tubing is never marked replaced automatically                                                                                                                        |
| Book PFT / ABG / sputum induction         | Diagnostics → Book appointment                                                            | Patient, date/time, procedure as requested, OPD/INP, physician. Payment is not recorded (U-09)                                                                       |
| Update an appointment                     | Open it → Mark done / No-show / Cancel / For reschedule / Reschedule                      | Done is recorded in your name. Done, no-show, cancelled and rescheduled cannot be changed — void an entry made in error (only the RT who booked it, or the Chief RT) |
| Calendar / filters / print                | Diagnostics → Calendar; filters; Print schedule; appointment → Printable patient schedule |                                                                                                                                                                      |
| PFT form                                  | PFT appointment → Start PFT form                                                          | See below                                                                                                                                                            |
| Handover                                  | Shift Handover                                                                            | One per shift; acknowledged by someone other than the author                                                                                                         |
| My activity                               | RT Daily Activities                                                                       | Context, not a ranking                                                                                                                                               |

### The PFT form (official clinical record)

1. **Start** it from the PFT appointment on the day of the test. Name, sex, age, hospital no., room/outpatient, physician and test type are copied in — check them. Clinical sections are empty: write only what you observed.
2. **Save draft** as often as you like. If someone else saved it meanwhile you are told to reload — nothing is overwritten.
3. **Sign as RT…** (password + code). You must be in the approved signatory directory. After signing, the content is locked.
4. Get the pulmonologist's interpretation and approval (e-signature) — or print for a signature on paper.
5. **Finalize record…**: choose the pulmonologist from the directory and how they sign — **their approved e-signature** (as in the Excel guide; only if their e-signature is on file) or the printed copy — type the interpretation exactly as given, tick the confirmation, confirm with password + code. The record is now final and prints with the signatures.
6. Later corrections: **Add amendment…** (section, text, reason). The original is never changed.

### Offline capture (only if the Chief RT approved your device)

1. While online and signed in: Devices & Sync → **Open offline capture** → **Prepare offline capture**. Keep that tab open.
2. Without connection you can document doses due and tubing replacements; each is saved encrypted on the device ("Saved on this device"). If it says **not saved**, use paper.
3. If the page is reloaded offline it shows **Locked** — your entries are still there; reconnect, sign in, **Unlock**.
4. When PUIMS is reachable, press **Sync now** (it also syncs automatically). Entries that clash with what is already documented, or whose times need checking, appear in **Devices & Sync → Sync review**: _Apply after checking_ (your own entries) or _Do not apply_ with a reason.
5. You cannot remove offline data while entries are unsent.

## For the Chief RT

| Task                                                                                                                               | Where                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Create RT accounts, reset access, deactivate                                                                                       | RT Staff                                   |
| Roster                                                                                                                             | Shift Management                           |
| Settings: tubing interval, session limits                                                                                          | Settings                                   |
| PFT template (header, revision, bronchodilator statement) — a new version each time; tick "hospital-confirmed" only when confirmed | Settings → PFT form template               |
| Approved signatory directory (RTs linked to accounts; pulmonologists)                                                              | Settings → Approved signatory directory    |
| Reports: day / week / month / year, operational or calendar days; definitions on the page                                          | Reports & Analytics                        |
| CSV exports (audited). The appointment list contains patient data — handle per hospital policy                                     | Reports & Analytics                        |
| Import a scheduling workbook (approved environment only)                                                                           | Import Center — see `docs/IMPORT_GUIDE.md` |
| Audit trail                                                                                                                        | Audit Logs                                 |
| Sessions and devices; revoke a lost device; approve/withdraw offline capture                                                       | Devices & Sync                             |
| Resolve sync conflicts (record "do not apply"; only the capturing RT can apply)                                                    | Devices & Sync → Sync review               |

The Chief RT cannot enter nebulization orders (U-17) and cannot sign PFT forms as an RT.

## When PUIMS is unavailable

Follow the unit's paper downtime procedure. Enter paper records into PUIMS afterwards (doses up to 72 h late) — never guess times.

# PUIMS — Workbook Import: Mapping, Flags and Exception Report

Applies to the Import Center (Chief RT). Built and tested with **synthetic workbooks only**. What is kept: every cell value (with sheet and row), and the original file encrypted. What is not kept as such: colours, fonts, images and formulas (cached values only) — PUIMS shows and prints the data in its own layouts. Importing the real `PFT SCHEDULING` workbook requires an approved environment and reviewers (U-19). Never upload the real workbook to AI services or anywhere outside the approved PUIMS server.

Try it with synthetic data: `npm run fixture:workbook` writes `synthetic-pft-schedule.xlsx` (a deliberately messy file reproducing the layout problems in the spec).

## 1. Limits and handling of the file

| Rule             | Value                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Format           | `.xlsx` only (ZIP signature checked)                                                                |
| Size             | ≤ 10 MB; ≤ 24 visible worksheets; ≤ 3,000 data rows × 40 columns per sheet (truncation is reported) |
| Where it is read | In memory on the PUIMS server; never written to disk; never sent elsewhere                          |
| Formulas         | Not evaluated; the cached value stored in the file is used                                          |
| Same file twice  | Refused while a batch with the same SHA-256 is staged or committed                                  |
| Blank rows       | Skipped and counted per sheet                                                                       |

## 2. Column mapping

Headers are detected in the first 15 rows (the row with the most recognized headers). Suggestions can be changed per sheet; saving a mapping re-checks that sheet and resets its decisions.

| PUIMS field                 | Recognized headers (case/punctuation-insensitive)                                                                                                                                                               | What happens                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Date                        | `DATE`, `DATE OF PFT/TEST/PROCEDURE/APPOINTMENT`, `SCHEDULE DATE`; a generic `Column N` / blank header is **suggested** only if ≥ 60 % of its values look like dates (shown as "suggested from values — check") | See §3                                                                                                                       |
| Time                        | `TIME`, `SCHEDULE TIME`                                                                                                                                                                                         | See §3                                                                                                                       |
| Patient name                | `NAME`, `PATIENT`, `PATIENT NAME`, `NAME OF PATIENT`, `FULL NAME`                                                                                                                                               | Never used alone to merge                                                                                                    |
| Age, Sex, Age / Sex         | `AGE`, `SEX`/`GENDER`, `AGE/SEX` and variants                                                                                                                                                                   | Raw text kept on the appointment (`raw_age_sex`); sex normalized only to M/F when unambiguous; DOB is never derived from age |
| OPD / INP                   | `OPD/INP`, `CATEGORY`, `PATIENT TYPE`                                                                                                                                                                           | OPD/OUT/OUTPATIENT → OPD; INP/IN/INPATIENT/ADMITTED/WARD → INP                                                               |
| Requesting physician        | `PHYSICIAN`, `DOCTOR`, `DR`, `REQUESTING PHYSICIAN`, `AP`                                                                                                                                                       | Text as recorded                                                                                                             |
| Procedure                   | `PROCEDURE`, `TEST`, `TEST TYPE`, `EXAM`                                                                                                                                                                        | Label kept as written (no catalogue mapping, U-06)                                                                           |
| Status                      | `STATUS`                                                                                                                                                                                                        | Raw text kept; normalized (§3)                                                                                               |
| RT scheduler / Performed by | `RT SCHEDULER`, `SCHEDULED BY`, `PERFORMED BY`, `DONE BY`                                                                                                                                                       | Kept as text in remarks ("Source scheduler: …"); not linked to accounts                                                      |
| Remarks                     | `REMARKS`, `NOTES`, `COMMENTS`                                                                                                                                                                                  | Text                                                                                                                         |
| **Contact**                 | `CONTACT`, `CONTACT NO`, `CP`, `MOBILE`, `PHONE`, …                                                                                                                                                             | **Not imported** — removed before staging, not even kept raw (U-08)                                                          |
| **Payment**                 | `PAYMENT`, `MODE OF PAYMENT`, `HMO/CASH`                                                                                                                                                                        | **Not imported** — removed before staging (U-09)                                                                             |

## 3. Conservative parsing and flags

Blocking flags (●) must be resolved by the reviewer typing the correct value from the source record, or the row is not imported. Other flags (◆) are information the reviewer must still see before deciding.

| Flag                                        | Blocking | Meaning / rule                                                                                                                                                                                                                          |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATE_MISSING                                | ●        | Empty date — never inferred                                                                                                                                                                                                             |
| DATE_MALFORMED                              | ●        | Unreadable, or a misspelled month name                                                                                                                                                                                                  |
| DATE_AMBIGUOUS                              | ●        | e.g. `6/4/2025` when the reviewer has not declared month/day order                                                                                                                                                                      |
| DATE_IMPOSSIBLE                             | ●        | Non-existent day, year outside 2000–2100, or contradicts the declared order                                                                                                                                                             |
| YEAR_MALFORMED                              | ●        | e.g. `06/25/20255` — apparent typo, **never corrected automatically**                                                                                                                                                                   |
| YEAR_MISMATCH                               | ●        | Year differs from the declared workbook year — never changed                                                                                                                                                                            |
| YEAR_MISSING                                | ●        | No year in the value and no workbook year declared                                                                                                                                                                                      |
| YEAR_FROM_WORKBOOK                          | ◆        | Year taken from the reviewer's declared workbook year                                                                                                                                                                                   |
| SHEET_MONTH_MISMATCH                        | ◆        | Date's month differs from the worksheet name (e.g. an August date on the JULY sheet)                                                                                                                                                    |
| TIME_MISSING / TIME_MALFORMED               | ●        |                                                                                                                                                                                                                                         |
| TIME_NO_MERIDIEM                            | ●        | `8:00` without AM/PM, unless the reviewer declared 24-hour times                                                                                                                                                                        |
| NAME_MISSING                                | ●        |                                                                                                                                                                                                                                         |
| NAME_SUSPECT                                | ◆        | Digits or symbols in the name                                                                                                                                                                                                           |
| AGE_SEX_UNCERTAIN                           | ◆        | e.g. `8 mos/F`, `X`, conflicting columns — raw kept, nothing normalized                                                                                                                                                                 |
| STATUS_MISSING / STATUS_UNKNOWN             | ●        | Known variants: done/completed/performed → COMPLETED; no-show/did not come → NO_SHOW; cancelled → CANCELLED; pending/on hold → PENDING; for resched → FOR_RESCHEDULE; rescheduled → RESCHEDULED; scheduled/booked/confirmed → SCHEDULED |
| CATEGORY_MISSING                            | ◆        | Empty OPD/INP is saved as “Other / not stated” — never guessed as OPD or INP; correct the appointment later if known. A declared default still applies.                                                                                 |
| CATEGORY_UNKNOWN                            | ●        | Unrecognized OPD/INP text must be resolved by the reviewer                                                                                                                                                                              |
| PROCEDURE_MISSING                           | ●        |                                                                                                                                                                                                                                         |
| VALUE_TOO_LONG                              | ●        | Longer than the database allows                                                                                                                                                                                                         |
| CONTACT_NOT_IMPORTED / PAYMENT_NOT_IMPORTED | ◆        | The sheet had such a column; it was dropped                                                                                                                                                                                             |
| NAME_MATCHES_EXISTING                       | ◆        | Same name key as an existing patient — the reviewer must explicitly choose existing or new                                                                                                                                              |
| NAME_REPEATS_IN_BATCH                       | ◆        | Same name on other rows — repeat visit or different person? Reviewer may link "same person as row …"                                                                                                                                    |
| DUPLICATE_CANDIDATE                         | ◆        | Same name + date + time + procedure in the batch, or same name + date as an existing appointment — never auto-discarded                                                                                                                 |

Reviewer declarations (batch level, audited): text date order (MDY/DMY), workbook year, "times without AM/PM are 24-hour", OPD/INP for empty cells.

## 4. Decisions, dry run, commit, reversal

- Every row ends as **Import** (with a patient choice: new / existing / same person as another row) or **Do not import** (reason required). "Accept clean rows" accepts only rows with no blocking flag and no matching/duplicate flag, as new patients.
- **Dry run** shows rows, accepted, rejected, pending, new/existing/linked patients, appointments to create, and every remaining problem. Commit is enabled only when there are no problems.
- **Commit** (Chief RT, password confirmation) creates patients (`provenance = IMPORT`, sex only if clearly M/F, no DOB) and one appointment per accepted row (`source = IMPORT`, `raw_status`, `raw_age_sex`, link to its staging row).
- **Reverse** a committed batch (step-up, reason): voids its appointments and the patients it created if nothing else refers to them; refused if any imported appointment has since been updated, rescheduled or has a PFT form.
- **Discard** a staged batch: closes it and erases its staged values and the retained original.
- **Download original workbook…** (Chief RT, step-up): returns the exact uploaded file (checked against its SHA-256).

## 5. Exception report (CSV)

`GET /api/import/{batchId}/report` — UTF-8 with BOM, RFC 4180, formula-injection-safe. Download is audited. It identifies rows **only by worksheet and row number** — no names or other patient values — so it can be used beside the original workbook.

```
PUIMS import exception report,file sha256 <64 hex>,status STAGED,generated <ISO time>
worksheet,row,decision,patient link,unresolved (blocking),other flags,resolved fields,reviewer reason
JUNE,6,PENDING,,Day/month order is ambiguous,Contact column present — not imported (U-08),,
JUNE,10,REJECT,,,Possible duplicate (...),,Duplicate of row 4 (entered twice)
```

Rows that are accepted and have no flags are omitted (they are not exceptions).

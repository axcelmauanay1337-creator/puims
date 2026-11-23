# PUIMS — Legacy Import and PFT Form Specification

## 1. Scheduling workbook inspected

The source workbook is named `PFT SCHEDULING (3).xlsx` in the user's working files. It contains monthly worksheets:
- JUNE
- JULY
- AUGUST
- SEPTEMBER
- OCTOBER
- NOVEMBER
- DECEMBER

The source workbook contains identifiable patient information. This package intentionally does not reproduce patient rows, names, phone numbers, or other identifiers.

## 2. Observed layout differences

The monthly sheets are not fully consistent:
- Some use `DATE`; some use a generic `Column 1` header.
- Early sheets use separate `AGE` and `SEX` columns.
- Later sheets may combine them into `Age / Sex`.
- Some sheets have extra blank or unused columns.
- Date values include both spreadsheet date values and text-like strings, with inconsistent formats and apparent malformed years.
- Contact information may be a phone number or a note/category rather than a phone number.
- Status values include variants such as completed, no-show, cancelled, pending, and for-reschedule.
- Repeated patient appointments may represent legitimate repeat tests or rescheduling and must remain separate source events.

## 3. Source fields observed

- date
- time
- patient name
- age
- sex
- age/sex combined
- contact info
- physician
- procedure
- status
- payment
- RT scheduler
- performed by
- remarks

Do not assume all columns exist on every sheet.

## 4. Import staging requirements

Create a guided import wizard:
1. Select file in the approved environment.
2. Calculate and retain source file checksum.
3. Detect worksheets and probable header rows.
4. Map columns to PUIMS fields.
5. Show a preview with original raw values.
6. Parse values conservatively.
7. Flag ambiguous/impossible dates, unknown status, missing patient identity, malformed time, and uncertain age/sex.
8. Show possible duplicates but never automatically discard or merge them.
9. Preserve source workbook name, sheet, row number, raw row JSON, and import batch.
10. Allow authorized reviewer to resolve flagged rows.
11. Dry-run and produce an error/exception report.
12. Require explicit human confirmation before commit.
13. Make import batch traceable and reversible by a controlled correction/void workflow.

Never silently change an apparent year typo. Never infer missing dates. Never interpret contact notes as phone numbers without validation. Keep raw age/sex string even when normalized fields are derived.

## 5. Appointment and patient matching

- Match existing patients by approved unique hospital ID when available.
- Do not match or merge on name alone.
- If the workbook does not contain a reliable hospital ID, create a review queue for patient matching.
- A repeated patient name on a different date is not automatically a duplicate.
- A same-date/time/procedure match is only a duplicate candidate, not proof.
- Preserve rescheduled appointment lineage and each original source row.
- Never drop a source row without a documented reviewer decision.

## 6. PFT procedure normalization

Preserve original procedure label and optionally map to a controlled local catalogue after clinical approval. Do not infer clinical test details from text labels. Procedure catalogue may include examples found in the source, such as simple/complete PFT with post-bronchodilator and PFT with DLCO, but final catalogue must be approved by the Pulmonary Unit.

## 7. PFT guide workbook inspected

The guide workbook contains these worksheets:
- `Patient Data`
- `RT signature`
- `Pulmo Signature`

The `Patient Data` sheet is a 52-row by 33-column form. Its visible structure includes:
- facility header and address/trunkline;
- `PULMONARY FUNCTION TEST`;
- date;
- patient information;
- name, sex, age, birthdate;
- hospital number;
- weight (kg), height (cm), room/outpatient;
- requesting physician;
- HMO;
- test type;
- technician's comments;
- patient's spirometry history;
- purpose of test;
- patient's smoking history;
- patient's medication;
- patient observation;
- source-template note about Salbutamol used as bronchodilator via MDI;
- interpretation;
- Respiratory Therapist and Pulmonologist signature areas;
- form identifier `AS-PUL-PFT-006`.

Preserve the structure and labels, but confirm the facility header and form revision with the hospital before production. The Salbutamol sentence is source-template content, not a universal clinical instruction; keep it only if the hospital confirms it remains current. Do not invent interpretation, auto-sign, or fabricate provider credentials.

The signature worksheets contain named personnel. Do not seed their names in development fixtures. Build an approved signature directory with controlled admin maintenance and a signature/approval workflow that meets hospital policy.

## 8. Privacy

The actual scheduling workbook must remain in a hospital-approved environment. Do not upload patient rows to Claude, ChatGPT, Figma, public code repositories, issue trackers, demo sites, or analytics tools. Use synthetic data for development. Any real-data migration must be approved by the hospital DPO/privacy office and IT.

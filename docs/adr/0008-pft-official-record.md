# ADR-0008: The PFT form as the official clinical record

Status: Accepted (Milestone 5). Decision U-10 (2026-11-22): the digital PFT form is the official clinical record. Pulmonologist signature method is open (U-18).

**Decision.**

- Structure follows the PFT guide workbook (form `AS-PUL-PFT-006`): facility header, title, date, patient information, technician's comments, spirometry history, purpose, smoking history, medication, observation, optional source-template bronchodilator statement, interpretation, RT and pulmonologist signature areas.
- Header, address, revision and bronchodilator statement come from a Chief-maintained, append-only template table; v1 is clearly marked "pending hospital confirmation". Nothing is invented.
- Administrative fields are pre-filled from the patient and appointment; clinical sections start empty. Interpretation is typed by a person only at sign-off — never generated, never pre-filled.
- Lifecycle enforced in the database: DRAFT → RT_SIGNED (the author, as their own directory entry, with password + authenticator) → FINAL (an RT records the directory pulmonologist and the transcribed interpretation, attesting the wet signature on the printed copy). FINAL content never changes and cannot be voided; corrections are append-only amendments with a reason.
- Signatory directory: Chief-only, step-up, synthetic entries only in dev/test; entries are deactivated, never edited.

**Consequences.** The printed form carries the RT's e-signature line and the pulmonologist's wet signature. If clinical governance chooses pulmonologist accounts (U-18), the FINAL step becomes a pulmonologist e-signature without changing the record structure.

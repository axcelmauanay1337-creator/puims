# PUIMS — Claude Implementation Handoff

This package is the consolidated implementation brief for the Pulmonary Unit Information and Management System (PUIMS).

## Product direction

**Notion's simplicity + Hospital Information System functionality + Respiratory Therapy workflow.**

PUIMS is a responsive, browser-based clinical and operational application for the Pulmonary Unit. It must support desktop, laptop, tablet, and smartphone use, with online operation and carefully controlled offline capability.

## Give Claude these files

1. `CLAUDE_MASTER_BUILD_PROMPT.md` — paste this entire file as the main instruction.
2. `PRODUCT_REQUIREMENTS.md` — detailed product and workflow requirements.
3. `ARCHITECTURE_AND_OFFLINE_DESIGN.md` — system architecture and outage behavior.
4. `DATA_IMPORT_AND_PFT_SPEC.md` — source workbook structure and safe import rules.
5. `SECURITY_AND_ACCEPTANCE_CHECKLIST.md` — mandatory security, clinical safety, and acceptance criteria.
6. `FIGMA_HANDOFF.md` — visual design direction.
7. `puims_dashboard_prototype.html` — visual reference only.
8. `puims_schema.sql` — preliminary schema reference only; Claude must review and replace/extend it through proper migrations.

## Suggested Claude workflow

Start a new Claude project or coding session. Attach the complete handoff package (or place the files in the repository), then paste `CLAUDE_MASTER_BUILD_PROMPT.md`.

Tell Claude to:
- inspect all supplied files first;
- create the project repository and implementation plan;
- implement the application in tested milestones;
- show the actual files, migrations, tests, and run instructions;
- never claim a feature is complete unless it runs and passes tests.

## Patient-data warning — read before uploading source workbooks

The original PFT scheduling workbook contains identifiable patient information, including names and contact information. **Do not upload that workbook or real patient data to Claude or any other AI service unless the hospital has explicitly approved that disclosure and the service, account, and processing arrangement.**

The handoff package intentionally contains no patient rows. The original workbook should be imported locally into an approved PUIMS staging environment by authorized staff, with a human review step. Use synthetic records for development and demonstrations.

The PFT guide workbook was inspected to identify its structure. Do not treat its embedded staff/provider names or signatures as permission to use them in a demo. Load approved signature identities only after hospital authorization.

## Important status

This is an implementation handoff, not a deployed or clinically validated system. Hospital IT, the Data Protection Officer, clinical governance, infection prevention, and authorized clinical leadership must review the system before real patient data or clinical use.

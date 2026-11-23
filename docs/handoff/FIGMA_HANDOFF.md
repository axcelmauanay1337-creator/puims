# PUIMS — Figma Design Handoff

## Design concept

**Notion's simplicity + Hospital Information System functionality + Respiratory Therapy workflow.**

Create a clean clinical workspace, not a generic hospital dashboard.

## Visual direction
- Warm off-white application background.
- White or near-white content surfaces.
- Thin neutral borders and subtle separators.
- Restrained green/teal accent for primary actions and positive status.
- Neutral amber/red for warnings and overdue states.
- Minimal shadows, no heavy gradients.
- Compact readable typography and clear hierarchy.
- Generous whitespace without wasting clinical screen space.
- Strong accessible contrast and visible focus states.

## Core frames
1. Desktop Overview — Chief RT
2. Desktop Overview — RT
3. Patient Masterlist
4. Patient Profile
5. Nebulization Worklist
6. Nebulization Documentation
7. Mechanical Ventilation List
8. Ventilator Encounter Detail
9. Tubing Replacement Timeline
10. PFT Schedule
11. PFT Patient Form
12. ABG Schedule/Documentation
13. Sputum Induction Schedule/Documentation
14. Shift Management
15. Shift Handover
16. Reports and Analytics
17. Import Center / Validation Preview
18. Device Management / Sync Status
19. Mobile Dashboard
20. Mobile Patient / Quick Documentation
21. Offline Mode / Pending Sync
22. Conflict Review

## Responsive behavior
- Desktop: sidebar + workspace + optional contextual right panel.
- Tablet: collapsible sidebar, touch-friendly tables and actions.
- Phone: bottom navigation or compact drawer, cards instead of dense tables, quick actions, large touch targets.
- Keep sync state visible on all screen sizes.
- Clearly distinguish current data from cached/stale data.
- Offline queue and conflict states must be understandable without relying on color alone.

## Components
- App sidebar and mobile nav.
- Top bar with global search and user profile.
- Breadcrumbs and page title.
- Filterable/sortable data table.
- Patient identity header.
- Status badges.
- Empty/loading/error states.
- Quick-action buttons.
- Date/time picker with timezone context.
- Shift badge.
- Alert/reminder panel.
- Offline/sync status banner.
- Pending queue list.
- Conflict-resolution comparison panel.
- Printable clinical form layout.

## Design tokens (suggested starting point)
- Background: #F7F7F4
- Surface: #FFFFFF
- Text: #252824
- Secondary text: #70766F
- Border: #E6E8E3
- Primary accent: muted green/teal
- Warning: accessible amber
- Danger: accessible red
- Radius: modest 8–12px
- Spacing: consistent 4/8px scale

Do not include real patient data, real signatures, or identifiable staff/provider details in Figma files. Use synthetic placeholder records.

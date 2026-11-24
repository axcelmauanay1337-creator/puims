/**
 * Loads SYNTHETIC demonstration data into a development/UAT database.
 *
 *   npm run db:seed            # uses MIGRATION_DATABASE_URL
 *   npm run db:seed -- --test  # uses TEST_MIGRATION_DATABASE_URL
 *
 * Refuses to run unless PUIMS_DEPLOYMENT_PROFILE is development or uat.
 * ALWAYS wipes existing data first (it is meant for disposable databases only).
 *
 * Synthetic accounts get the password in PUIMS_SEED_PASSWORD; the account list is
 * written to .seed-credentials[.test].json (gitignored).
 */
import { hash } from "@node-rs/argon2";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { generateSyntheticDataset } from "../src/lib/demo/synthetic";
import { classifyInstant } from "../src/lib/time/shifts";

const test = process.argv.includes("--test");
const profile = process.env.PUIMS_DEPLOYMENT_PROFILE ?? "development";
if (profile !== "development" && profile !== "uat") {
  console.error(`Refusing to seed synthetic data: PUIMS_DEPLOYMENT_PROFILE=${profile}`);
  process.exit(1);
}
const url = test ? process.env.TEST_MIGRATION_DATABASE_URL : process.env.MIGRATION_DATABASE_URL;
const password = process.env.PUIMS_SEED_PASSWORD;
if (!url) throw new Error(`${test ? "TEST_" : ""}MIGRATION_DATABASE_URL is not set`);
if (!password || password.length < 12) throw new Error("PUIMS_SEED_PASSWORD must be set (≥ 12 characters)");
if (!process.env.PUIMS_DATA_KEY) throw new Error("PUIMS_DATA_KEY must be set");

const TABLES = [
  "charge_post",
  "niv_encounter",
  "equipment",
  "sync_event",
  "offline_lease",
  "pft_form_amendment",
  "pft_form",
  "signatory_proposal",
  "signatory",
  "pft_template",
  "import_row",
  "import_batch",
  "handover_item",
  "shift_handover",
  "tubing_event",
  "vent_encounter",
  "neb_administration",
  "neb_order",
  "diagnostic_appointment",
  "shift_assignment",
  "patient",
  "auth_session",
  "auth_token",
  "auth_credential",
  "device",
  "staff",
];

async function bulk(c: pg.Client, table: string, rows: Record<string, unknown>[], chunk = 500) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).join(", ");
  for (let i = 0; i < rows.length; i += chunk) {
    await c.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::${table}, $1)`, [JSON.stringify(rows.slice(i, i + chunk))]);
  }
}

const usernameOf = (displayName: string) =>
  displayName.startsWith("Chief")
    ? "chief.demo"
    : `rt.${displayName
        .replace(/^RT /, "")
        .replace(/ \(Demo\)$/, "")
        .toLowerCase()}`;

async function main() {
  const now = new Date();
  const ds = generateSyntheticDataset(classifyInstant(now).operationalDate, now);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const started = Date.now();
  try {
    await c.query("BEGIN");
    // Disposable databases only: the owner temporarily lifts the audit-log TRUNCATE guard.
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate");
    await c.query(`TRUNCATE ${TABLES.join(", ")}, audit_log RESTART IDENTITY CASCADE`);
    await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate");
    // TRUNCATE ... CASCADE also empties `setting` (it references staff), so restore the defaults.
    await c.query(
      `INSERT INTO setting (key, value, description) VALUES
         ('tubing.interval_days', '7', 'Change of tubing (ventilator circuit) interval in calendar days (policy-pending, U-04)'),
         ('tubing.upcoming_window_hours', '48', 'Hours before due at which tubing is flagged upcoming (policy-pending, U-04)'),
         ('session.idle_minutes', '15', 'Sign-out after this many minutes without activity (U-14)'),
         ('session.absolute_hours', '12', 'Maximum session length regardless of activity'),
         ('charges.ventilator_per_day', '5500', 'Ventilator charge per patient per day, ₱ (synthetic)'),
         ('charges.hfnc_per_day', '4500', 'HFNC machine charge per patient per day, ₱ (synthetic)'),
         ('charges.niv_per_day', '3500', 'BiPAP / CPAP machine charge per patient per day, ₱ (synthetic)')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_by = NULL, updated_at = now()`,
    );

    // Staff + credentials ------------------------------------------------
    const creds: Record<string, { status: string; role: string }> = {};
    const pwHash = await hash(password!, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    await bulk(
      c,
      "staff",
      ds.staff.map((s) => ({
        id: s.id,
        username: usernameOf(s.displayName),
        display_name: s.displayName,
        role: s.role,
        status: s.accountStatus,
        created_at: s.createdAt,
        activated_at: s.accountStatus === "INVITED" ? null : s.createdAt,
        deactivated_at: s.accountStatus === "DEACTIVATED" ? now.toISOString() : null,
        last_login_at: s.lastActiveAt,
      })),
    );
    const credRows = [];
    for (const s of ds.staff) {
      if (s.accountStatus === "INVITED") continue;
      creds[usernameOf(s.displayName)] = { status: s.accountStatus, role: s.role };
      credRows.push({
        staff_id: s.id,
        password_hash: pwHash,
        password_changed_at: now.toISOString(),
        failed_attempts: 0,
      });
    }
    await bulk(c, "auth_credential", credRows);

    // Clinical -------------------------------------------------------------
    await bulk(
      c,
      "patient",
      ds.patients.map((p) => ({
        id: p.id,
        hospital_patient_id: p.hospitalPatientId,
        full_name: p.fullName,
        date_of_birth: p.dateOfBirth,
        sex: p.sex,
        category: p.category,
        ward_room: p.wardRoom,
        provenance: "SEED",
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      })),
    );
    await bulk(
      c,
      "shift_assignment",
      ds.assignments.map((a) => ({ id: a.id, operational_date: a.operationalDate, shift: a.shift, staff_id: a.staffId })),
    );
    await bulk(
      c,
      "neb_order",
      ds.nebOrders.map((o) => ({
        id: o.id,
        patient_id: o.patientId,
        order_reference: o.orderReference,
        prescriber: o.prescriber,
        medication_as_ordered: o.medicationAsOrdered,
        frequency: o.frequency,
        prescribed_times: o.prescribedTimes,
        start_at: o.startAt,
        end_at: o.endAt,
      })),
    );
    await bulk(
      c,
      "neb_administration",
      // Only DOCUMENTED outcomes are stored; scheduled/pending doses are derived from the order's times.
      ds.nebAdministrations
        .filter((a) => a.performedBy !== null)
        .map((a) => ({
          id: a.id,
          order_id: a.orderId,
          patient_id: a.patientId,
          scheduled_at: a.scheduledAt,
          actual_at: a.actualAt,
          status: a.status,
          performed_by: a.performedBy,
          reason: a.reason,
          source: "SEED",
        })),
    );
    await bulk(
      c,
      "vent_encounter",
      ds.encounters.map((e) => ({
        id: e.id,
        patient_id: e.patientId,
        hooked_at: e.hookedAt,
        disconnected_at: e.disconnectedAt,
        ventilator_ref: e.ventilatorRef,
        ward_room: e.wardRoom,
        responsible_staff_id: e.responsibleStaffId,
        source: "SEED",
      })),
    );
    await bulk(
      c,
      "tubing_event",
      ds.tubing.map((t) => ({
        id: t.id,
        encounter_id: t.encounterId,
        tubing_type: t.tubingType,
        installed_at: t.installedAt,
        interval_days: 7,
        next_due_at: t.installedAt, // recomputed by trigger
        performed_by: t.performedBy,
        reason: t.reason,
        source: "SEED",
      })),
    );
    await bulk(
      c,
      "diagnostic_appointment",
      ds.diagnostics.map((d) => ({
        id: d.id,
        patient_id: d.patientId,
        service: d.service,
        scheduled_at: d.scheduledAt,
        status: d.status,
        raw_status: d.rawStatus,
        procedure_label: d.procedureLabel,
        requesting_physician: d.requestingPhysician,
        category: d.category,
        scheduler_id: d.schedulerId,
        performed_by: d.performedBy,
        reschedules_id: d.reschedulesId,
        remarks: d.remarks,
        source: "SEED",
      })),
    );
    await bulk(
      c,
      "shift_handover",
      ds.handovers.map((h) => ({
        id: h.id,
        operational_date: h.operationalDate,
        shift: h.shift,
        outgoing_staff_id: h.outgoingStaffId,
        incoming_staff_id: h.incomingStaffId,
        equipment_concerns: h.equipmentConcerns,
        notes: h.notes,
        created_at: h.createdAt,
        acknowledged_at: h.acknowledgedAt && h.incomingStaffId ? h.acknowledgedAt : null,
        acknowledged_by: h.acknowledgedAt && h.incomingStaffId ? h.incomingStaffId : null,
      })),
    );
    // Historical handovers are inserted already acknowledged; the owner lifts the
    // "no items on acknowledged handovers" guard just for this synthetic backfill.
    await c.query("ALTER TABLE handover_item DISABLE TRIGGER handover_item_guard");
    await bulk(
      c,
      "handover_item",
      ds.handovers.flatMap((h) => h.pendingItems.map((i) => ({ handover_id: h.id, kind: i.kind, ref_id: i.refId, summary: i.summary }))),
    );
    await c.query("ALTER TABLE handover_item ENABLE TRIGGER handover_item_guard");

    // PFT template v1 (placeholders — the hospital must confirm header, revision and the bronchodilator
    // statement) and a SYNTHETIC signatory directory. Real staff/provider names are never seeded.
    await c.query(
      `INSERT INTO pft_template (version, facility_header, facility_address, form_revision, bronchodilator_note, hospital_confirmed)
       VALUES (1, '[Facility header — pending hospital confirmation]', '[Address / trunkline — pending hospital confirmation]', '[Revision — pending confirmation]', NULL, false),
              -- v2: printed text of the hospital's PFT guide (AS-PUL-PFT-006), as in migration 0010. Form text only — no names.
              (2, 'DILIMAN DOCTORS HOSPTAL, INC', E'251 COMMONWEALTH AVE., MATANDANG BALARA, QUEZON CITY\\nTRUNKLINE: (632) 8883-6900',
                  'AS-PUL-PFT-006 (no revision printed on the source form)',
                  'Salbutamol was used as the bronchodilator and administered via metered-dose inhaler (MDI).', false)`,
    );
    const chief = ds.staff.find((s) => s.role === "CHIEF_RT_ADMIN")!;
    const rtSigners = ds.staff.filter((s) => s.role === "RESPIRATORY_THERAPIST" && s.accountStatus === "ACTIVE");
    await bulk(c, "signatory", [
      ...rtSigners.map((s, i) => ({
        kind: "RESPIRATORY_THERAPIST",
        display_name: s.displayName,
        credentials: `SYN-LIC-RT-${String(i + 1).padStart(4, "0")}`,
        staff_id: s.id,
        created_by: chief.id,
      })),
      { kind: "PULMONOLOGIST", display_name: "Dr. Demo Pulmonologist A", credentials: "SYN-LIC-MD-0001", staff_id: null, created_by: chief.id },
      { kind: "PULMONOLOGIST", display_name: "Dr. Demo Pulmonologist B", credentials: "SYN-LIC-MD-0002", staff_id: null, created_by: chief.id },
    ]);
    // Redesign (0016): synthetic equipment board, HFNC/NIV and patient flags --------------
    const rt = (await c.query<{ id: string }>("SELECT id FROM staff WHERE role = 'RESPIRATORY_THERAPIST' AND status = 'ACTIVE' ORDER BY username LIMIT 1"))
      .rows[0];
    await c.query(
      `INSERT INTO equipment (code, kind, model, pm_due_on, rented_from, rented_since, rental_rate, created_by, updated_by) VALUES
         ('VENT-01', 'VENTILATOR', 'Synthetic Vent A', current_date + 60, NULL, NULL, NULL, $1, $1),
         ('VENT-02', 'VENTILATOR', 'Synthetic Vent A', current_date + 30, NULL, NULL, NULL, $1, $1),
         ('VENT-03', 'VENTILATOR', 'Synthetic Vent B', current_date - 1, NULL, NULL, NULL, $1, $1),
         ('RENT-01', 'VENTILATOR', 'Synthetic Vent A', NULL, 'Demo Medical Supply (SYN)', current_date - 3, 6000, $1, $1),
         ('HF-01', 'HFNC', 'Synthetic HFNC', current_date + 90, NULL, NULL, NULL, $1, $1),
         ('HF-02', 'HFNC', 'Synthetic HFNC', current_date + 90, NULL, NULL, NULL, $1, $1),
         ('BP-01', 'BIPAP', 'Synthetic BiPAP', current_date + 45, NULL, NULL, NULL, $1, $1),
         ('BP-02', 'BIPAP', 'Synthetic BiPAP', current_date + 45, NULL, NULL, NULL, $1, $1)`,
      [chief.id],
    );
    const free = (
      await c.query<{ id: string; ward_room: string | null }>(
        `SELECT p.id, p.ward_room FROM patient p WHERE p.category = 'INP' AND p.voided_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM vent_encounter v WHERE v.patient_id = p.id AND v.disconnected_at IS NULL) ORDER BY p.full_name LIMIT 4`,
      )
    ).rows;
    if (rt && free.length >= 2) {
      await c.query(
        `INSERT INTO niv_encounter (patient_id, device, setting, spo2_target, equipment_id, ward_room, started_at, started_by)
         VALUES ($1, 'HFNC', '40 L/min · FiO₂ 35%', '92–96%', (SELECT id FROM equipment WHERE code = 'HF-01'), $2, now() - interval '20 hours', $5),
                ($3, 'BIPAP', 'IPAP 14 · EPAP 6 · FiO₂ 40%', '88–92%', (SELECT id FROM equipment WHERE code = 'BP-02'), $4, now() - interval '9 hours', $5)`,
        [free[0].id, free[0].ward_room, free[1].id, free[1].ward_room, rt.id],
      );
    }
    const flagged = (await c.query<{ id: string }>("SELECT id FROM patient WHERE voided_at IS NULL ORDER BY full_name LIMIT 3")).rows;
    if (flagged.length === 3) {
      await c.query(
        `UPDATE patient SET precautions = '{CONTACT}', special_endorsement = 'Desaturates on suctioning: pre-oxygenate first (synthetic).', updated_by = $2 WHERE id = $1`,
        [flagged[0].id, chief.id],
      );
      await c.query("UPDATE patient SET precautions = '{AIRBORNE}', own_supplies = '{OWN_MEDICATION}', updated_by = $2 WHERE id = $1", [
        flagged[1].id,
        chief.id,
      ]);
      await c.query("UPDATE patient SET own_supplies = '{OWN_MESH_NEBULIZER,OWN_MEDICATION}', updated_by = $2 WHERE id = $1", [flagged[2].id, chief.id]);
    }
    // 0017: synthetic profile details for some patients.
    await c.query(
      `UPDATE patient SET contact_info = 'Relative (synthetic) · 0917 000 ' || lpad((row_number)::text, 4, '0'),
              attending_physician = (ARRAY['Dr. Demo Santos', 'Dr. Demo Reyes', 'Dr. Demo Ramos'])[1 + row_number % 3],
              height_cm = 150 + (row_number % 30), weight_kg = 50 + (row_number % 35), updated_by = $1
         FROM (SELECT id AS pid, row_number() OVER (ORDER BY full_name) AS row_number FROM patient WHERE voided_at IS NULL) x
        WHERE patient.id = x.pid AND x.row_number % 3 <> 0`,
      [chief.id],
    );
    await c.query("COMMIT");
    const file = test ? ".seed-credentials.test.json" : ".seed-credentials.json";
    writeFileSync(
      file,
      JSON.stringify({ note: "SYNTHETIC accounts for development/testing only. Password is PUIMS_SEED_PASSWORD.", accounts: creds }, null, 2),
      { mode: 0o600 },
    );
    const counts = await c.query(
      `SELECT (SELECT count(*) FROM patient) patients, (SELECT count(*) FROM neb_administration) neb_admins, (SELECT count(*) FROM diagnostic_appointment) diagnostics,
              (SELECT count(*) FROM vent_encounter) encounters, (SELECT count(*) FROM tubing_event) tubing, (SELECT count(*) FROM staff) staff`,
    );
    console.log(`Seeded synthetic data in ${((Date.now() - started) / 1000).toFixed(1)}s:`, counts.rows[0]);
    console.log(`Accounts (password = PUIMS_SEED_PASSWORD, list in ${file}):`, Object.keys(creds).join(", "));
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

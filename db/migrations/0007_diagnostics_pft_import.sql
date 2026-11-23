-- 0007: Milestone 5 — diagnostics scheduling, PFT clinical form, workbook import staging.
--
-- Decisions:
--  * 2026-11-22 (product owner): the digital PFT form IS the official clinical record (U-10).
--    So: signed content is immutable; corrections are append-only amendments; nothing is
--    auto-signed; interpretation is only ever typed by a person (never generated).
--  * Facility header, form revision and the source-template bronchodilator (Salbutamol via MDI)
--    statement are NOT invented: they live in a Chief-maintained template table, start as
--    clearly-marked placeholders and every form snapshots the template version it was made with.
--  * Pulmonologist e-signature: pulmonologists hold no PUIMS account (U-18, open). Interim rule:
--    the form is finalized when an RT records the pulmonologist's sign-off on the printed copy,
--    choosing the pulmonologist from the approved signatory directory. Recorded, never implied.
--  * Import: staging rows keep sheet/row/raw values; nothing is merged on name; contact columns are
--    not imported (U-08); every row needs an explicit reviewer decision; commit is Chief-only.

-- ================================================================= diagnostic appointments

ALTER TABLE diagnostic_appointment
  ADD COLUMN payment_class   text CHECK (length(payment_class) <= 60),   -- only if hospital policy permits (U-12)
  ADD COLUMN raw_age_sex     text CHECK (length(raw_age_sex) <= 40),      -- source value kept verbatim
  ADD COLUMN import_row_id   uuid,
  ADD COLUMN updated_at      timestamptz,
  ADD COLUMN updated_by      uuid REFERENCES staff(id),
  ADD COLUMN status_reason   text CHECK (length(status_reason) <= 300),
  ADD COLUMN voided_at       timestamptz,
  ADD COLUMN voided_by       uuid REFERENCES staff(id),
  ADD COLUMN void_reason     text CHECK (length(void_reason) <= 300),
  ADD CONSTRAINT diag_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL)),
  -- A completed appointment names who performed it (imports may only know a name → kept in the import row).
  ADD CONSTRAINT diag_completed_performer CHECK (status <> 'COMPLETED' OR performed_by IS NOT NULL OR source IN ('IMPORT', 'SEED')),
  ADD CONSTRAINT diag_reason_chk CHECK (status NOT IN ('CANCELLED', 'NO_SHOW', 'FOR_RESCHEDULE') OR source IN ('IMPORT', 'SEED') OR status_reason IS NOT NULL);

-- A reschedule produces exactly one live follow-up; both rows are kept (lineage).
CREATE UNIQUE INDEX diag_reschedule_child_uq ON diagnostic_appointment (reschedules_id) WHERE reschedules_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX diag_status_idx ON diagnostic_appointment (status) WHERE voided_at IS NULL;

-- Status workflow. Terminal statuses never change; a wrong entry is voided with a reason.
CREATE FUNCTION diag_status_allowed(old_s text, new_s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT old_s = new_s OR CASE old_s
    WHEN 'SCHEDULED'      THEN new_s IN ('PENDING', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'FOR_RESCHEDULE', 'RESCHEDULED')
    WHEN 'PENDING'        THEN new_s IN ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'FOR_RESCHEDULE', 'RESCHEDULED')
    WHEN 'FOR_RESCHEDULE' THEN new_s IN ('RESCHEDULED', 'CANCELLED')
    ELSE false
  END
$$;
GRANT EXECUTE ON FUNCTION diag_status_allowed(text, text) TO puims_app;

CREATE FUNCTION diag_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['status', 'status_reason', 'performed_by', 'remarks', 'updated_at', 'updated_by', 'voided_at', 'voided_by', 'void_reason', 'operational_date', 'shift'];
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided appointment cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'appointment details cannot be edited; reschedule, or void and book again' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.voided_at IS NOT NULL THEN
    -- voiding changes nothing else
    IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'void separately from other changes' USING ERRCODE = 'check_violation';
    END IF;
    NEW.voided_at := now();
    RETURN NEW;
  END IF;
  IF NOT diag_status_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'status % cannot change to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED') AND (to_jsonb(NEW) - ARRAY['updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'a closed appointment cannot be changed; void it with a reason' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER diag_guard BEFORE UPDATE ON diagnostic_appointment FOR EACH ROW EXECUTE FUNCTION diag_guard();

-- Reschedule lineage must stay within the same patient and service.
CREATE FUNCTION diag_lineage_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF NEW.reschedules_id IS NULL THEN RETURN NEW; END IF;
  SELECT patient_id, service INTO p FROM diagnostic_appointment WHERE id = NEW.reschedules_id;
  IF p.patient_id IS DISTINCT FROM NEW.patient_id OR p.service IS DISTINCT FROM NEW.service THEN
    RAISE EXCEPTION 'a reschedule must keep the same patient and service' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER diag_lineage_check BEFORE INSERT ON diagnostic_appointment FOR EACH ROW EXECUTE FUNCTION diag_lineage_check();

DROP POLICY diagnostic_appointment_insert ON diagnostic_appointment;
CREATE POLICY diagnostic_appointment_insert ON diagnostic_appointment FOR INSERT
  WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND voided_at IS NULL AND (
    (source IN ('ONLINE', 'OFFLINE_SYNC') AND scheduler_id = (SELECT app_active_staff_id()))
    OR (source = 'IMPORT' AND (SELECT app_is_chief()))));
DROP POLICY diagnostic_appointment_update ON diagnostic_appointment;
CREATE POLICY diagnostic_appointment_update ON diagnostic_appointment FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL)
  WITH CHECK (updated_by = (SELECT app_active_staff_id()) AND (voided_at IS NULL OR voided_by = (SELECT app_active_staff_id())));

CREATE OR REPLACE VIEW service_event_v WITH (security_invoker = true) AS
  SELECT a.id::text AS id, 'NEBULIZATION'::text AS service, a.patient_id, a.performed_by AS staff_id,
         coalesce(a.actual_at, a.scheduled_at) AS occurred_at, a.status, a.id AS source_id
    FROM neb_administration a WHERE a.performed_by IS NOT NULL AND a.voided_at IS NULL
  UNION ALL
  SELECT e.id::text || ':hook', 'MECHANICAL_VENTILATION', e.patient_id, e.responsible_staff_id, e.hooked_at, 'HOOK_IN', e.id
    FROM vent_encounter e WHERE e.responsible_staff_id IS NOT NULL
  UNION ALL
  SELECT e.id::text || ':disc', 'MECHANICAL_VENTILATION', e.patient_id, e.responsible_staff_id, e.disconnected_at, 'DISCONNECTION', e.id
    FROM vent_encounter e WHERE e.disconnected_at IS NOT NULL AND e.responsible_staff_id IS NOT NULL
  UNION ALL
  SELECT t.id::text, 'TUBING_REPLACEMENT', e.patient_id, t.performed_by, t.installed_at, 'COMPLETED', t.id
    FROM tubing_event t JOIN vent_encounter e ON e.id = t.encounter_id WHERE t.voided_at IS NULL
  UNION ALL
  SELECT d.id::text, d.service, d.patient_id, d.performed_by, d.scheduled_at, 'COMPLETED', d.id
    FROM diagnostic_appointment d WHERE d.status = 'COMPLETED' AND d.performed_by IS NOT NULL AND d.voided_at IS NULL;

-- ================================================================= approved signatory directory

CREATE TABLE signatory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('RESPIRATORY_THERAPIST', 'PULMONOLOGIST')),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  credentials   text CHECK (length(credentials) <= 120),     -- e.g. licence number as approved by the hospital
  staff_id      uuid REFERENCES staff(id),                   -- RTs: the PUIMS account that may sign as this signatory
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES staff(id),
  deactivated_at timestamptz,
  deactivated_by uuid REFERENCES staff(id),
  CHECK (kind = 'RESPIRATORY_THERAPIST' OR staff_id IS NULL),
  CHECK (active = (deactivated_at IS NULL))
);
CREATE UNIQUE INDEX signatory_staff_uq ON signatory (staff_id) WHERE staff_id IS NOT NULL AND active;

-- Entries are never edited (a printed form must keep meaning what it said); only deactivated.
CREATE FUNCTION signatory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.active THEN RAISE EXCEPTION 'a deactivated signatory cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - ARRAY['active', 'deactivated_at', 'deactivated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['active', 'deactivated_at', 'deactivated_by']) THEN
    RAISE EXCEPTION 'signatory entries cannot be edited; deactivate and add a new one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signatory_guard BEFORE UPDATE ON signatory FOR EACH ROW EXECUTE FUNCTION signatory_guard();

-- ================================================================= PFT form template (Chief-maintained, versioned)

CREATE TABLE pft_template (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version            integer NOT NULL UNIQUE,
  form_code          text NOT NULL DEFAULT 'AS-PUL-PFT-006' CHECK (length(form_code) <= 40),
  facility_header    text NOT NULL CHECK (length(facility_header) BETWEEN 1 AND 200),
  facility_address   text CHECK (length(facility_address) <= 300),
  form_revision      text NOT NULL CHECK (length(form_revision) BETWEEN 1 AND 60),
  bronchodilator_note text CHECK (length(bronchodilator_note) <= 400),   -- NULL = not printed
  hospital_confirmed boolean NOT NULL DEFAULT false,                     -- true only when the Chief attests hospital confirmation
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES staff(id)
);
-- Append-only: a new version supersedes; old forms keep pointing at the version they used.
CREATE TRIGGER pft_template_immutable BEFORE UPDATE OR DELETE ON pft_template FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

INSERT INTO pft_template (version, facility_header, facility_address, form_revision, bronchodilator_note, hospital_confirmed)
VALUES (1, '[Facility header — pending hospital confirmation]', '[Address / trunkline — pending hospital confirmation]', '[Revision — pending confirmation]', NULL, false);

-- ================================================================= PFT form (official clinical record)

CREATE TABLE pft_form (
  id                   uuid PRIMARY KEY,                       -- client-generated (idempotent create)
  appointment_id       uuid NOT NULL REFERENCES diagnostic_appointment(id),
  patient_id           uuid NOT NULL REFERENCES patient(id),
  template_id          uuid NOT NULL REFERENCES pft_template(id),
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RT_SIGNED', 'FINAL')),
  test_date            date NOT NULL,
  -- patient information (snapshot at the time of the test; the masterlist may change later)
  patient_name         text NOT NULL CHECK (length(patient_name) BETWEEN 1 AND 160),
  sex                  text CHECK (sex IN ('M', 'F')),
  age_text             text CHECK (length(age_text) <= 20),
  birthdate            date,
  hospital_number      text CHECK (length(hospital_number) <= 40),
  weight_kg            numeric(5,1) CHECK (weight_kg > 0 AND weight_kg < 500),
  height_cm            numeric(5,1) CHECK (height_cm > 0 AND height_cm < 260),
  room_or_opd          text CHECK (length(room_or_opd) <= 60),
  requesting_physician text CHECK (length(requesting_physician) <= 120),
  hmo                  text CHECK (length(hmo) <= 80),
  test_type            text CHECK (length(test_type) <= 160),
  -- narrative sections (typed by people; never generated)
  technician_comments  text CHECK (length(technician_comments) <= 2000),
  spirometry_history   text CHECK (length(spirometry_history) <= 1000),
  purpose_of_test      text CHECK (length(purpose_of_test) <= 1000),
  smoking_history      text CHECK (length(smoking_history) <= 1000),
  medication           text CHECK (length(medication) <= 1000),
  observation          text CHECK (length(observation) <= 2000),
  interpretation       text CHECK (length(interpretation) <= 4000),   -- as written by the pulmonologist
  -- workflow
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL REFERENCES staff(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  rt_signatory_id      uuid REFERENCES signatory(id),
  rt_signed_at         timestamptz,
  rt_signed_by         uuid REFERENCES staff(id),
  pulmo_signatory_id   uuid REFERENCES signatory(id),
  finalized_at         timestamptz,
  finalized_by         uuid REFERENCES staff(id),
  pulmo_signoff_method text CHECK (pulmo_signoff_method IN ('WET_SIGNATURE_ON_PRINTED_COPY')),
  voided_at            timestamptz,
  voided_by            uuid REFERENCES staff(id),
  void_reason          text CHECK (length(void_reason) <= 300),
  device_id            uuid REFERENCES device(id),
  CHECK ((status = 'DRAFT') = (rt_signed_at IS NULL)),
  CHECK ((rt_signed_at IS NULL) = (rt_signatory_id IS NULL) AND (rt_signed_at IS NULL) = (rt_signed_by IS NULL)),
  CHECK ((status = 'FINAL') = (finalized_at IS NOT NULL)),
  CHECK ((finalized_at IS NULL) = (pulmo_signatory_id IS NULL) AND (finalized_at IS NULL) = (finalized_by IS NULL) AND (finalized_at IS NULL) = (pulmo_signoff_method IS NULL)),
  CHECK (status <> 'FINAL' OR interpretation IS NOT NULL),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL))
);
CREATE UNIQUE INDEX pft_form_appointment_uq ON pft_form (appointment_id) WHERE voided_at IS NULL;
CREATE INDEX pft_form_patient_idx ON pft_form (patient_id);

CREATE FUNCTION pft_form_check_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT patient_id, service, voided_at INTO a FROM diagnostic_appointment WHERE id = NEW.appointment_id;
  IF a.service IS DISTINCT FROM 'PFT' OR a.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a PFT form needs a live PFT appointment' USING ERRCODE = 'check_violation';
  END IF;
  IF a.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'form patient must match the appointment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pft_form_check_appointment BEFORE INSERT ON pft_form FOR EACH ROW EXECUTE FUNCTION pft_form_check_appointment();

-- Lifecycle: DRAFT (editable by its author) → RT_SIGNED (content frozen) → FINAL (frozen; amendments only).
CREATE FUNCTION pft_form_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content text[] := ARRAY['test_date', 'patient_name', 'sex', 'age_text', 'birthdate', 'hospital_number', 'weight_kg', 'height_cm', 'room_or_opd',
                          'requesting_physician', 'hmo', 'test_type', 'technician_comments', 'spirometry_history', 'purpose_of_test',
                          'smoking_history', 'medication', 'observation'];
  fixed text[] := ARRAY['id', 'appointment_id', 'patient_id', 'template_id', 'created_at', 'created_by', 'device_id'];
  k text;
BEGIN
  IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'a voided form cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN RAISE EXCEPTION 'form identity cannot change' USING ERRCODE = 'check_violation'; END IF;
  END LOOP;
  IF NEW.voided_at IS NOT NULL THEN
    IF OLD.status = 'FINAL' THEN RAISE EXCEPTION 'a final record cannot be voided; add an amendment' USING ERRCODE = 'check_violation'; END IF;
    IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at']) THEN
      RAISE EXCEPTION 'void separately from other changes' USING ERRCODE = 'check_violation';
    END IF;
    NEW.voided_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'FINAL' THEN RAISE EXCEPTION 'a final PFT record cannot be edited; add an amendment' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status = 'RT_SIGNED' THEN
    FOREACH k IN ARRAY content || ARRAY['rt_signatory_id', 'rt_signed_at', 'rt_signed_by'] LOOP
      IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
        RAISE EXCEPTION 'signed content cannot be edited' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF NEW.status <> 'FINAL' THEN RAISE EXCEPTION 'a signed form can only be finalized' USING ERRCODE = 'check_violation'; END IF;
    NEW.finalized_at := now();
  ELSE -- DRAFT
    IF NEW.status = 'FINAL' THEN RAISE EXCEPTION 'the RT must sign before the form is finalized' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.interpretation IS DISTINCT FROM OLD.interpretation THEN
      RAISE EXCEPTION 'interpretation is recorded at pulmonologist sign-off' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'RT_SIGNED' THEN NEW.rt_signed_at := now(); END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER pft_form_guard BEFORE UPDATE ON pft_form FOR EACH ROW EXECUTE FUNCTION pft_form_guard();

-- The RT signs only as the directory entry linked to their own account.
CREATE FUNCTION pft_form_signer_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'RT_SIGNED' AND OLD.status = 'DRAFT' THEN
    IF NOT EXISTS (SELECT 1 FROM signatory WHERE id = NEW.rt_signatory_id AND kind = 'RESPIRATORY_THERAPIST' AND active AND staff_id = NEW.rt_signed_by) THEN
      RAISE EXCEPTION 'you can only sign as your own approved signatory entry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'FINAL' AND OLD.status = 'RT_SIGNED' THEN
    IF NOT EXISTS (SELECT 1 FROM signatory WHERE id = NEW.pulmo_signatory_id AND kind = 'PULMONOLOGIST' AND active) THEN
      RAISE EXCEPTION 'choose an active pulmonologist from the approved directory' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pft_form_signer_check BEFORE UPDATE ON pft_form FOR EACH ROW EXECUTE FUNCTION pft_form_signer_check();

CREATE TABLE pft_form_amendment (
  id          uuid PRIMARY KEY,
  form_id     uuid NOT NULL REFERENCES pft_form(id),
  section     text NOT NULL CHECK (section IN ('PATIENT_INFORMATION', 'TECHNICIAN_COMMENTS', 'SPIROMETRY_HISTORY', 'PURPOSE_OF_TEST', 'SMOKING_HISTORY',
                                                'MEDICATION', 'OBSERVATION', 'INTERPRETATION', 'SIGNATURES', 'OTHER')),
  text        text NOT NULL CHECK (length(text) BETWEEN 3 AND 2000),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 5 AND 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES staff(id)
);
CREATE TRIGGER pft_amendment_immutable BEFORE UPDATE OR DELETE ON pft_form_amendment FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE FUNCTION pft_amendment_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pft_form WHERE id = NEW.form_id AND status = 'FINAL' AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'amendments are added to final records only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pft_amendment_check BEFORE INSERT ON pft_form_amendment FOR EACH ROW EXECUTE FUNCTION pft_amendment_check();

-- ================================================================= import staging

CREATE TABLE import_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name      text NOT NULL CHECK (length(file_name) <= 200),
  file_sha256    text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes     integer NOT NULL CHECK (file_bytes > 0),
  service        text NOT NULL DEFAULT 'PFT' CHECK (service IN ('PFT', 'ABG', 'SPUTUM_INDUCTION')),
  workbook_year  integer CHECK (workbook_year BETWEEN 2000 AND 2100),   -- stated by the reviewer, never guessed
  sheets         jsonb NOT NULL DEFAULT '[]',                           -- per-sheet header row + column mapping
  options        jsonb NOT NULL DEFAULT '{}',                           -- reviewer declarations (date order, 24-h times, default category)
  status         text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED', 'COMMITTED', 'VOIDED', 'DISCARDED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES staff(id),
  committed_at   timestamptz,
  committed_by   uuid REFERENCES staff(id),
  closed_at      timestamptz,
  closed_by      uuid REFERENCES staff(id),
  close_reason   text CHECK (length(close_reason) <= 300),
  summary        jsonb,
  CHECK ((status = 'COMMITTED' OR status = 'VOIDED') = (committed_at IS NOT NULL)),
  CHECK ((status IN ('VOIDED', 'DISCARDED')) = (closed_at IS NOT NULL))
);
-- the same file (by checksum) cannot be live-staged or committed twice
CREATE UNIQUE INDEX import_batch_file_uq ON import_batch (file_sha256) WHERE status IN ('STAGED', 'COMMITTED');

CREATE TABLE import_row (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES import_batch(id),
  sheet_name     text NOT NULL CHECK (length(sheet_name) <= 100),
  row_number     integer NOT NULL CHECK (row_number > 0),
  raw            jsonb NOT NULL,          -- original cell values by source header (contact columns excluded, U-08)
  parsed         jsonb NOT NULL,          -- conservative parse; reviewer overrides live in `resolved`
  flags          text[] NOT NULL DEFAULT '{}',
  resolved       jsonb NOT NULL DEFAULT '{}',
  decision       text NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING', 'ACCEPT', 'REJECT')),
  decision_reason text CHECK (length(decision_reason) <= 300),
  patient_link   text CHECK (patient_link IN ('NEW', 'EXISTING', 'SAME_AS_ROW')),
  patient_id     uuid REFERENCES patient(id),
  same_as_row_id uuid REFERENCES import_row(id),
  decided_at     timestamptz,
  decided_by     uuid REFERENCES staff(id),
  appointment_id uuid REFERENCES diagnostic_appointment(id),
  created_patient boolean NOT NULL DEFAULT false,
  UNIQUE (batch_id, sheet_name, row_number),
  CHECK (decision <> 'REJECT' OR decision_reason IS NOT NULL),
  CHECK (patient_link IS DISTINCT FROM 'EXISTING' OR patient_id IS NOT NULL),
  CHECK (patient_link IS DISTINCT FROM 'SAME_AS_ROW' OR same_as_row_id IS NOT NULL)
);
CREATE INDEX import_row_batch_idx ON import_row (batch_id, sheet_name, row_number);
ALTER TABLE diagnostic_appointment ADD CONSTRAINT diag_import_row_fk FOREIGN KEY (import_row_id) REFERENCES import_row(id);

-- Rows of a committed / closed batch are frozen (except linking the created appointment during commit).
CREATE FUNCTION import_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM import_batch WHERE id = OLD.batch_id;
  IF st <> 'STAGED' AND current_setting('app.import_commit', true) IS DISTINCT FROM OLD.batch_id::text THEN
    RAISE EXCEPTION 'this import batch is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.sheet_name, NEW.row_number, NEW.batch_id) IS DISTINCT FROM (OLD.sheet_name, OLD.row_number, OLD.batch_id) OR NOT (OLD.raw @> NEW.raw) THEN
    -- the only permitted change to source values is REMOVING a column (e.g. contact details, U-08)
    RAISE EXCEPTION 'source values are never edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_row_guard BEFORE UPDATE ON import_row FOR EACH ROW EXECUTE FUNCTION import_row_guard();

-- ================================================================= grants, RLS, audit

GRANT SELECT, INSERT, UPDATE ON signatory, pft_form, import_batch, import_row TO puims_app;
GRANT SELECT, INSERT ON pft_template, pft_form_amendment TO puims_app;

ALTER TABLE signatory ENABLE ROW LEVEL SECURITY;
ALTER TABLE pft_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE pft_form ENABLE ROW LEVEL SECURITY;
ALTER TABLE pft_form_amendment ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row ENABLE ROW LEVEL SECURITY;

CREATE POLICY signatory_read ON signatory FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY signatory_insert ON signatory FOR INSERT WITH CHECK ((SELECT app_is_chief()) AND created_by = (SELECT app_active_staff_id()));
CREATE POLICY signatory_update ON signatory FOR UPDATE USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()) AND deactivated_by = (SELECT app_active_staff_id()));

CREATE POLICY pft_template_read ON pft_template FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY pft_template_insert ON pft_template FOR INSERT WITH CHECK ((SELECT app_is_chief()) AND created_by = (SELECT app_active_staff_id()));

CREATE POLICY pft_form_read ON pft_form FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY pft_form_insert ON pft_form FOR INSERT
  WITH CHECK ((SELECT app_is_rt()) AND created_by = (SELECT app_active_staff_id()) AND status = 'DRAFT' AND voided_at IS NULL);
-- Draft edits/sign/void: the author. Finalize (record pulmonologist sign-off): any RT, in their own name.
CREATE POLICY pft_form_update ON pft_form FOR UPDATE
  USING ((SELECT app_is_rt()) AND (created_by = (SELECT app_active_staff_id()) OR status = 'RT_SIGNED'))
  WITH CHECK ((SELECT app_is_rt()) AND (
    (status = 'DRAFT' AND created_by = (SELECT app_active_staff_id()))
    OR (status = 'RT_SIGNED' AND rt_signed_by = (SELECT app_active_staff_id()) AND created_by = (SELECT app_active_staff_id()))
    OR (status = 'FINAL' AND finalized_by = (SELECT app_active_staff_id()))
  ) AND (voided_at IS NULL OR voided_by = (SELECT app_active_staff_id())));

CREATE POLICY pft_amendment_read ON pft_form_amendment FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY pft_amendment_insert ON pft_form_amendment FOR INSERT WITH CHECK ((SELECT app_is_rt()) AND created_by = (SELECT app_active_staff_id()));

-- Staging holds raw workbook values: Chief RT only.
CREATE POLICY import_batch_all ON import_batch FOR ALL USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()));
CREATE POLICY import_row_all ON import_row FOR ALL USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()));

CREATE TRIGGER audit_signatory AFTER INSERT OR UPDATE ON signatory FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_pft_template AFTER INSERT ON pft_template FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_pft_form AFTER INSERT OR UPDATE ON pft_form FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_pft_amendment AFTER INSERT ON pft_form_amendment FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_import_batch AFTER INSERT OR UPDATE ON import_batch FOR EACH ROW EXECUTE FUNCTION audit_row_change();
-- Row staging inserts are summarized by an app-level event. Reviewer decisions are audited per row,
-- WITHOUT the raw/parsed workbook values (so discarding a batch really removes its staged values).
CREATE FUNCTION audit_import_decision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  keep text[] := ARRAY['id', 'batch_id', 'sheet_name', 'row_number', 'decision', 'decision_reason', 'patient_link', 'patient_id', 'same_as_row_id', 'flags'];
  b jsonb := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(keep) k);
  a jsonb := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(keep) k);
BEGIN
  a := a || jsonb_build_object('resolved_fields', (SELECT coalesce(jsonb_agg(k), '[]') FROM jsonb_object_keys(NEW.resolved) k));
  b := b || jsonb_build_object('resolved_fields', (SELECT coalesce(jsonb_agg(k), '[]') FROM jsonb_object_keys(OLD.resolved) k));
  IF a IS DISTINCT FROM b THEN
    INSERT INTO audit_log (action, table_name, record_id, before_data, after_data) VALUES ('import_row.decision', 'import_row', NEW.id::text, b, a);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_import_row AFTER UPDATE OF decision, resolved, patient_link, patient_id, same_as_row_id ON import_row FOR EACH ROW EXECUTE FUNCTION audit_import_decision();

-- ================================================================= appointment history for any signed-in user
-- The audit log is Chief-only; this exposes a safe, status-only view of one appointment's history.
CREATE FUNCTION diag_history(appt uuid)
RETURNS TABLE (at timestamptz, actor text, action text, from_status text, to_status text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.occurred_at, s.display_name, a.action,
         a.before_data ->> 'status', a.after_data ->> 'status',
         coalesce(a.after_data ->> 'void_reason', a.after_data ->> 'status_reason')
    FROM audit_log a LEFT JOIN staff s ON s.id = a.actor_id
   WHERE app_active_staff_id() IS NOT NULL
     AND a.table_name = 'diagnostic_appointment' AND a.record_id = appt::text AND a.action LIKE 'diagnostic_appointment.%'
   ORDER BY a.id
$$;
GRANT EXECUTE ON FUNCTION diag_history(uuid) TO puims_app;

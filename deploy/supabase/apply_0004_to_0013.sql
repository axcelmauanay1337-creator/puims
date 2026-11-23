-- PUIMS: paste ALL of this into Supabase > SQL Editor > New query > Run. Safe to run once; each step is its own transaction.

-- ===== 0004_patients_shifts_handover.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0004: Milestone 3 — patient registration/corrections, roster editing, handover workflow.
-- Policy decisions (2026-11-22, product owner):
--   U-07 sex: only 'M' or 'F'. NULL = not yet recorded (e.g. imported row awaiting review); never guessed.
--   U-11 one handover per shift (already enforced by UNIQUE (operational_date, shift)).
--   U-13 hospital number optional (already nullable; unique when present).

-- ---------------------------------------------------------------- patient: sex vocabulary

ALTER TABLE patient DROP CONSTRAINT patient_sex_check;
ALTER TABLE patient ALTER COLUMN sex DROP DEFAULT;
ALTER TABLE patient ALTER COLUMN sex DROP NOT NULL;
UPDATE patient SET sex = NULL WHERE sex NOT IN ('M', 'F');
ALTER TABLE patient ADD CONSTRAINT patient_sex_check CHECK (sex IN ('M', 'F'));

-- ---------------------------------------------------------------- duplicate-candidate support

-- Order-insensitive, punctuation-free name key: "Cruz, Juana" = "juana cruz". Used ONLY to
-- surface possible duplicates for a human; never to merge.
CREATE FUNCTION name_key(n text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_to_string(ARRAY(
    SELECT t FROM unnest(regexp_split_to_array(lower(regexp_replace(coalesce(n, ''), '[^[:alpha:][:space:]]', ' ', 'g')), '\s+')) t
    WHERE t <> '' ORDER BY t), ' ')
$$;
CREATE INDEX patient_name_key_idx ON patient (name_key(full_name));
CREATE INDEX patient_dob_idx ON patient (date_of_birth);

-- ---------------------------------------------------------------- patient correction history

CREATE TABLE patient_revision (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id  uuid NOT NULL REFERENCES patient(id),
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by  uuid REFERENCES staff(id),
  reason      text,
  before_data jsonb NOT NULL,
  after_data  jsonb NOT NULL
);
CREATE INDEX patient_revision_patient_idx ON patient_revision (patient_id, changed_at DESC);

-- Identity corrections (name, DOB, sex, hospital number) require a reason, passed by the app
-- as the transaction-local setting app.change_reason. Location/category moves do not.
CREATE FUNCTION patient_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.full_name, NEW.date_of_birth, NEW.sex, NEW.hospital_patient_id) IS DISTINCT FROM
     (OLD.full_name, OLD.date_of_birth, OLD.sex, OLD.hospital_patient_id)
     AND length(btrim(coalesce(current_setting('app.change_reason', true), ''))) < 5 THEN
    RAISE EXCEPTION 'a reason is required to correct patient identity details' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  NEW.id := OLD.id;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_before_update BEFORE UPDATE ON patient FOR EACH ROW EXECUTE FUNCTION patient_before_update();

CREATE FUNCTION patient_record_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cols text[] := ARRAY['hospital_patient_id', 'full_name', 'date_of_birth', 'sex', 'category', 'ward_room', 'voided_at', 'void_reason'];
  b jsonb := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(cols) k);
  a jsonb := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(cols) k);
BEGIN
  IF a IS DISTINCT FROM b THEN
    INSERT INTO patient_revision (patient_id, changed_by, reason, before_data, after_data)
    VALUES (NEW.id, app_staff_id(), nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), ''), b, a);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_revision AFTER UPDATE ON patient FOR EACH ROW EXECUTE FUNCTION patient_record_revision();

CREATE FUNCTION patient_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'patient_revision is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER patient_revision_no_change BEFORE UPDATE OR DELETE ON patient_revision FOR EACH ROW EXECUTE FUNCTION patient_revision_immutable();

-- ---------------------------------------------------------------- roster: soft removal

ALTER TABLE shift_assignment DROP CONSTRAINT shift_assignment_operational_date_shift_staff_id_key;
ALTER TABLE shift_assignment
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid REFERENCES staff(id),
  ADD COLUMN removal_reason text CHECK (length(removal_reason) <= 200),
  ADD CONSTRAINT shift_assignment_removed_chk CHECK ((removed_at IS NULL) = (removed_by IS NULL));
CREATE UNIQUE INDEX shift_assignment_active_uq ON shift_assignment (operational_date, shift, staff_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------- handover integrity

-- Identity of a handover never changes; once acknowledged it is frozen.
CREATE FUNCTION shift_handover_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'an acknowledged handover cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.operational_date, NEW.shift, NEW.outgoing_staff_id, NEW.created_at) IS DISTINCT FROM
     (OLD.operational_date, OLD.shift, OLD.outgoing_staff_id, OLD.created_at) THEN
    RAISE EXCEPTION 'handover shift, author and creation time are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.acknowledged_by IS NOT NULL AND NEW.acknowledged_by = NEW.outgoing_staff_id THEN
    RAISE EXCEPTION 'the outgoing RT cannot acknowledge their own handover' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.acknowledged_at IS NOT NULL THEN
    NEW.acknowledged_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shift_handover_guard BEFORE UPDATE ON shift_handover FOR EACH ROW EXECUTE FUNCTION shift_handover_guard();

CREATE FUNCTION handover_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM shift_handover WHERE id = NEW.handover_id AND acknowledged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'items cannot be added to an acknowledged handover' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER handover_item_guard BEFORE INSERT OR UPDATE ON handover_item FOR EACH ROW EXECUTE FUNCTION handover_item_guard();

-- ---------------------------------------------------------------- RLS / grants

GRANT SELECT ON patient_revision TO puims_app;
GRANT EXECUTE ON FUNCTION name_key(text) TO puims_app;
ALTER TABLE patient_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_revision_read ON patient_revision FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE TRIGGER audit_patient_revision AFTER INSERT ON patient_revision FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Handover: the author is the session user (or the Chief RT writing on someone's behalf is NOT allowed:
-- the Chief RT may write only as themself). Acknowledger is the session user and never the author.
DROP POLICY shift_handover_insert ON shift_handover;
CREATE POLICY shift_handover_insert ON shift_handover FOR INSERT
  WITH CHECK (outgoing_staff_id = (SELECT app_active_staff_id()) AND acknowledged_at IS NULL);
DROP POLICY shift_handover_update ON shift_handover;
CREATE POLICY shift_handover_update ON shift_handover FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL)
  WITH CHECK (
    (acknowledged_by IS NULL AND outgoing_staff_id = (SELECT app_active_staff_id()))
    OR (acknowledged_by = (SELECT app_active_staff_id()) AND acknowledged_by <> outgoing_staff_id)
  );

INSERT INTO schema_migrations (version, checksum) VALUES ('0004_patients_shifts_handover.sql', '042cfe9542d9ed02a96101bc93603aba601a436b34d7bec39a6bf80106b1ace1');
COMMIT;

-- ===== 0005_clinical_documentation.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0005: Milestone 4 — clinical documentation (nebulization, ventilation, tubing).
-- Decision 2026-11-22 (product owner): ONLY Respiratory Therapists enter nebulization orders
-- (not the Chief RT administrator).
--
-- Principles enforced here:
--  * Documented events are immutable. A mistake is corrected by VOIDING with a reason
--    (never edit, never delete) and documenting again.
--  * Expected administrations are NOT stored: they are derived from the times written on
--    the order. A row exists only once an RT documents what actually happened.
--  * Every documentation row may carry a client-generated UUID (idempotent retries / M7 sync).

CREATE FUNCTION app_is_rt() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM staff WHERE id = app_active_staff_id() AND role = 'RESPIRATORY_THERAPIST')
$$;
GRANT EXECUTE ON FUNCTION app_is_rt() TO puims_app;

-- ---------------------------------------------------------------- nebulization orders

ALTER TABLE neb_order
  ADD COLUMN discontinued_at timestamptz,
  ADD COLUMN discontinued_by uuid REFERENCES staff(id),
  ADD COLUMN discontinue_reason text CHECK (length(discontinue_reason) <= 300),
  ADD CONSTRAINT neb_order_discontinue_chk CHECK ((discontinued_at IS NULL) = (discontinue_reason IS NULL));

-- Orders are never edited; only discontinued (once, with a reason).
CREATE FUNCTION neb_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.discontinued_at IS NOT NULL THEN
    RAISE EXCEPTION 'a discontinued order cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.patient_id, NEW.order_reference, NEW.prescriber, NEW.medication_as_ordered, NEW.frequency, NEW.prescribed_times, NEW.start_at, NEW.entered_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.patient_id, OLD.order_reference, OLD.prescriber, OLD.medication_as_ordered, OLD.frequency, OLD.prescribed_times, OLD.start_at, OLD.entered_by, OLD.created_at) THEN
    RAISE EXCEPTION 'orders cannot be edited; discontinue and enter a new order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neb_order_guard BEFORE UPDATE ON neb_order FOR EACH ROW EXECUTE FUNCTION neb_order_guard();

DROP POLICY neb_order_insert ON neb_order;
CREATE POLICY neb_order_insert ON neb_order FOR INSERT
  WITH CHECK ((SELECT app_is_rt()) AND entered_by = (SELECT app_active_staff_id()));
DROP POLICY neb_order_update ON neb_order;
CREATE POLICY neb_order_update ON neb_order FOR UPDATE
  USING ((SELECT app_is_rt())) WITH CHECK ((SELECT app_is_rt()) AND discontinued_by = (SELECT app_active_staff_id()));

-- ---------------------------------------------------------------- void columns + immutability

ALTER TABLE neb_administration
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES staff(id),
  ADD COLUMN void_reason text CHECK (length(void_reason) <= 300),
  ADD CONSTRAINT neb_admin_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL));
-- One documented outcome per scheduled slot (a retry or a second RT cannot double-document it).
CREATE UNIQUE INDEX neb_admin_slot_uq ON neb_administration (order_id, scheduled_at) WHERE scheduled_at IS NOT NULL AND voided_at IS NULL;

ALTER TABLE tubing_event
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES staff(id),
  ADD COLUMN void_reason text CHECK (length(void_reason) <= 300),
  ADD CONSTRAINT tubing_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL));

-- Generic guard: after insert, only the void columns may change, and only once.
CREATE FUNCTION documented_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason'];
  n jsonb := to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason'];
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided record cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF o IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'documented events cannot be edited; void with a reason and document again' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.voided_at IS NOT NULL THEN
    NEW.voided_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neb_admin_guard BEFORE UPDATE ON neb_administration FOR EACH ROW EXECUTE FUNCTION documented_event_guard();
CREATE TRIGGER tubing_guard BEFORE UPDATE ON tubing_event FOR EACH ROW EXECUTE FUNCTION documented_event_guard();

-- Ventilator encounter: only the disconnection may be added (once). Hook-in details are immutable.
CREATE FUNCTION vent_encounter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disconnected_at IS NOT NULL THEN
    RAISE EXCEPTION 'a discontinued encounter cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['disconnected_at', 'status']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['disconnected_at', 'status']) THEN
    RAISE EXCEPTION 'hook-in details cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vent_encounter_guard BEFORE UPDATE ON vent_encounter FOR EACH ROW EXECUTE FUNCTION vent_encounter_guard();

-- Documentation is in the author's own name.
DROP POLICY neb_administration_insert ON neb_administration;
CREATE POLICY neb_administration_insert ON neb_administration FOR INSERT
  WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND performed_by = (SELECT app_active_staff_id()) AND voided_at IS NULL);
DROP POLICY neb_administration_update ON neb_administration;
CREATE POLICY neb_administration_update ON neb_administration FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL)
  WITH CHECK (voided_by = (SELECT app_active_staff_id()) AND (performed_by = (SELECT app_active_staff_id()) OR (SELECT app_is_chief())));

DROP POLICY tubing_event_insert ON tubing_event;
CREATE POLICY tubing_event_insert ON tubing_event FOR INSERT
  WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND performed_by = (SELECT app_active_staff_id()) AND voided_at IS NULL);
DROP POLICY tubing_event_update ON tubing_event;
CREATE POLICY tubing_event_update ON tubing_event FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL)
  WITH CHECK (voided_by = (SELECT app_active_staff_id()) AND (performed_by = (SELECT app_active_staff_id()) OR (SELECT app_is_chief())));

DROP POLICY vent_encounter_insert ON vent_encounter;
CREATE POLICY vent_encounter_insert ON vent_encounter FOR INSERT
  WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND responsible_staff_id = (SELECT app_active_staff_id()) AND disconnected_at IS NULL);

-- ---------------------------------------------------------------- handover can reference an order slot

ALTER TABLE handover_item DROP CONSTRAINT handover_item_kind_check;
ALTER TABLE handover_item ADD CONSTRAINT handover_item_kind_check
  CHECK (kind IN ('VENTILATOR_ENCOUNTER', 'NEBULIZATION_ADMIN', 'NEBULIZATION_ORDER', 'TUBING', 'DIAGNOSTIC'));

CREATE OR REPLACE FUNCTION handover_item_ref_exists() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  ok := CASE NEW.kind
    WHEN 'VENTILATOR_ENCOUNTER' THEN EXISTS (SELECT 1 FROM vent_encounter WHERE id = NEW.ref_id)
    WHEN 'NEBULIZATION_ADMIN'   THEN EXISTS (SELECT 1 FROM neb_administration WHERE id = NEW.ref_id)
    WHEN 'NEBULIZATION_ORDER'   THEN EXISTS (SELECT 1 FROM neb_order WHERE id = NEW.ref_id)
    WHEN 'TUBING'               THEN EXISTS (SELECT 1 FROM vent_encounter WHERE id = NEW.ref_id)
    WHEN 'DIAGNOSTIC'           THEN EXISTS (SELECT 1 FROM diagnostic_appointment WHERE id = NEW.ref_id)
  END;
  IF NOT ok THEN RAISE EXCEPTION 'handover item references a missing record' USING ERRCODE = 'foreign_key_violation'; END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- read model excludes voided events

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
    FROM diagnostic_appointment d WHERE d.status = 'COMPLETED' AND d.performed_by IS NOT NULL;

INSERT INTO schema_migrations (version, checksum) VALUES ('0005_clinical_documentation.sql', 'a0071ddd7c53438304de479359778c1aad45301d0a80be664a041ba10d1c57fc');
COMMIT;

-- ===== 0006_handover_order_slots.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0006: a handover can carry forward a specific EXPECTED dose of an order (order id + slot time),
-- since expected doses are derived, not stored. Several slots of one order may be carried.
ALTER TABLE handover_item ADD COLUMN slot_at timestamptz;
ALTER TABLE handover_item ADD CONSTRAINT handover_item_slot_chk CHECK ((kind = 'NEBULIZATION_ORDER') = (slot_at IS NOT NULL));
ALTER TABLE handover_item DROP CONSTRAINT handover_item_handover_id_kind_ref_id_key;
CREATE UNIQUE INDEX handover_item_uq ON handover_item (handover_id, kind, ref_id, coalesce(slot_at, '-infinity'::timestamptz));

INSERT INTO schema_migrations (version, checksum) VALUES ('0006_handover_order_slots.sql', '61e99017184c7c64e10e7bf76ea40b1e93b474ee7c0240d02ea8daa63c2465c0');
COMMIT;

-- ===== 0007_diagnostics_pft_import.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
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

INSERT INTO schema_migrations (version, checksum) VALUES ('0007_diagnostics_pft_import.sql', 'f0b34bbe2239dc6b512fe09bdf028611971f5cd4f40a6be5540b99650925116d');
COMMIT;

-- ===== 0008_offline_sync.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0008: Milestone 7 — approved offline devices, offline leases, idempotent sync with conflict review.
--
-- Interim policy (U-03 still open — hospital IT/DPO must approve before production use):
--  * Offline capture is OFF for every device until the Chief RT approves that specific device.
--  * Only nebulization dose documentation and tubing replacement can be captured offline.
--  * A lease lasts at most 12 hours and never beyond the signed-in session; revoking the device or
--    withdrawing approval revokes its leases. The lease key that encrypts the on-device queue is
--    stored here encrypted with PUIMS_DATA_KEY and is released only to the same staff + device + valid session.
--  * Every synchronized entry is kept in sync_event with its outcome. Nothing is silently dropped:
--    conflicts and rejections wait for a person to resolve them.

ALTER TABLE device DROP CONSTRAINT device_offline_phi_allowed_check;
ALTER TABLE device
  ADD COLUMN offline_approved_at timestamptz,
  ADD COLUMN offline_approved_by uuid REFERENCES staff(id),
  ADD CONSTRAINT device_offline_chk CHECK (NOT offline_phi_allowed OR (status = 'ACTIVE' AND offline_approved_at IS NOT NULL AND offline_approved_by IS NOT NULL));

DROP TRIGGER audit_device ON device;
CREATE TRIGGER audit_device AFTER INSERT OR UPDATE OF status, revoked_at, revoked_reason, offline_phi_allowed OR DELETE ON device FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TABLE offline_lease (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  device_id   uuid NOT NULL REFERENCES device(id),
  session_id  uuid NOT NULL REFERENCES auth_session(id),
  key_enc     text NOT NULL,                       -- AES-256-GCM(PUIMS_DATA_KEY); never returned except to its holder
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_reason text CHECK (length(revoked_reason) <= 200),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '12 hours')
);
CREATE INDEX offline_lease_device_idx ON offline_lease (device_id) WHERE revoked_at IS NULL;

-- Revoking a device, or withdrawing its offline approval, revokes its leases.
CREATE FUNCTION device_offline_revoke() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'REVOKED' AND OLD.status = 'ACTIVE' THEN
    NEW.offline_phi_allowed := false;
  END IF;
  IF OLD.offline_phi_allowed AND NOT NEW.offline_phi_allowed THEN
    UPDATE offline_lease SET revoked_at = now(), revoked_reason = CASE WHEN NEW.status = 'REVOKED' THEN 'device revoked' ELSE 'offline approval withdrawn' END
     WHERE device_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_offline_revoke BEFORE UPDATE ON device FOR EACH ROW EXECUTE FUNCTION device_offline_revoke();

CREATE TABLE sync_event (
  id                 uuid PRIMARY KEY,              -- the client-generated entry id (idempotency key)
  lease_id           uuid REFERENCES offline_lease(id),
  staff_id           uuid NOT NULL REFERENCES staff(id),
  device_id          uuid NOT NULL REFERENCES device(id),
  kind               text NOT NULL CHECK (kind IN ('NEB_DOSE', 'TUBING_REPLACEMENT')),
  payload            jsonb NOT NULL,
  recorded_at_device timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  clock_skew_ms      integer,
  outcome            text NOT NULL CHECK (outcome IN ('ACCEPTED', 'DUPLICATE', 'CONFLICT', 'REJECTED')),
  message            text CHECK (length(message) <= 400),
  record_id          uuid,
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES staff(id),
  resolution         text CHECK (resolution IN ('APPLIED', 'NOT_APPLIED')),
  resolution_note    text CHECK (length(resolution_note) <= 300),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK (resolution IS DISTINCT FROM 'NOT_APPLIED' OR resolution_note IS NOT NULL)
);
CREATE INDEX sync_event_open_idx ON sync_event (outcome) WHERE resolved_at IS NULL AND outcome IN ('CONFLICT', 'REJECTED');

-- Received entries are never edited — only resolved once.
CREATE FUNCTION sync_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'a resolved sync entry cannot change' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - ARRAY['resolved_at', 'resolved_by', 'resolution', 'resolution_note', 'record_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['resolved_at', 'resolved_by', 'resolution', 'resolution_note', 'record_id']) THEN
    RAISE EXCEPTION 'received sync entries cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_event_guard BEFORE UPDATE ON sync_event FOR EACH ROW EXECUTE FUNCTION sync_event_guard();

GRANT SELECT, INSERT, UPDATE ON offline_lease, sync_event TO puims_app;
ALTER TABLE offline_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY offline_lease_read ON offline_lease FOR SELECT USING (staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief()));
CREATE POLICY offline_lease_insert ON offline_lease FOR INSERT
  WITH CHECK (staff_id = (SELECT app_active_staff_id()) AND device_id = (SELECT app_device_id()) AND session_id = (SELECT app_session_id())
              AND EXISTS (SELECT 1 FROM device d WHERE d.id = device_id AND d.offline_phi_allowed));
CREATE POLICY offline_lease_update ON offline_lease FOR UPDATE
  USING (staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief())) WITH CHECK (revoked_at IS NOT NULL);

CREATE POLICY sync_event_read ON sync_event FOR SELECT USING (staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief()));
CREATE POLICY sync_event_insert ON sync_event FOR INSERT WITH CHECK (staff_id = (SELECT app_active_staff_id()) AND device_id = (SELECT app_device_id()));
CREATE POLICY sync_event_update ON sync_event FOR UPDATE
  USING (staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief()))
  WITH CHECK (resolved_by = (SELECT app_active_staff_id()));

-- Never copy key material (even encrypted) into the audit log.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  redact text[] := ARRAY['password_hash', 'totp_secret_enc', 'token_hash', 'key_enc'];
  b jsonb;
  a jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN b := to_jsonb(OLD) - redact; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN a := to_jsonb(NEW) - redact; END IF;
  IF TG_OP = 'UPDATE' AND a = b THEN RETURN NEW; END IF;
  INSERT INTO audit_log (action, table_name, record_id, before_data, after_data)
  VALUES (lower(TG_TABLE_NAME) || '.' || lower(TG_OP), TG_TABLE_NAME, coalesce(a ->> 'id', a ->> 'staff_id', a ->> 'key', b ->> 'id', b ->> 'staff_id', b ->> 'key'), b, a);
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER audit_offline_lease AFTER INSERT OR UPDATE ON offline_lease FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_sync_event AFTER INSERT OR UPDATE ON sync_event FOR EACH ROW EXECUTE FUNCTION audit_row_change();

INSERT INTO schema_migrations (version, checksum) VALUES ('0008_offline_sync.sql', 'a43f43f24d239578c5647ad00e4f524cd1f04225dc8a9cdb34c738853ad283b2');
COMMIT;

-- ===== 0009_policy_interlocks.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0009: policy interlocks found in the Milestone 8 review.
-- U-09 (may payment classification be stored?) is undecided → interim rule "not stored".
-- The column stays for a future, approved migration but must remain empty until the DPO decides.
UPDATE diagnostic_appointment SET payment_class = NULL WHERE payment_class IS NOT NULL;
ALTER TABLE diagnostic_appointment ADD CONSTRAINT diag_payment_u09 CHECK (payment_class IS NULL);

INSERT INTO schema_migrations (version, checksum) VALUES ('0009_policy_interlocks.sql', '8a92426fde1d2e5412b47ea5d2013dc012ea947eb839ae6ee6db79f254f26039');
COMMIT;

-- ===== 0010_pft_template_and_corrections.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0010 (2026-11-23):
-- 1. PFT template v2 taken from the hospital's own PFT guide workbook (form AS-PUL-PFT-006), supplied by the
--    product owner. Only the printed form text is used — header, address/trunkline and the item-6
--    bronchodilator sentence. No names from the signature sheets. Left "not yet confirmed": the Chief RT
--    confirms it is current (and may correct the header's spelling) by saving a new version in Settings.
-- 2. Appointment details become editable while the appointment is still open, with a required reason.
--    Every correction keeps the previous values in the audit trail and appears in the appointment history.

INSERT INTO pft_template (version, facility_header, facility_address, form_revision, bronchodilator_note, hospital_confirmed)
SELECT (SELECT max(version) FROM pft_template) + 1,
       'DILIMAN DOCTORS HOSPTAL, INC',
       E'251 COMMONWEALTH AVE., MATANDANG BALARA, QUEZON CITY\nTRUNKLINE: (632) 8883-6900',
       'AS-PUL-PFT-006 (no revision printed on the source form)',
       'Salbutamol was used as the bronchodilator and administered via metered-dose inhaler (MDI).',
       false
 WHERE NOT EXISTS (SELECT 1 FROM pft_template WHERE facility_header = 'DILIMAN DOCTORS HOSPTAL, INC');

ALTER TABLE diagnostic_appointment ADD COLUMN correction_reason text CHECK (length(correction_reason) BETWEEN 5 AND 300);

CREATE OR REPLACE FUNCTION diag_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['status', 'status_reason', 'performed_by', 'remarks', 'updated_at', 'updated_by', 'voided_at', 'voided_by', 'void_reason',
                          'operational_date', 'shift', 'correction_reason'];
  -- details that may be CORRECTED (with a reason) while the appointment is open
  correctable text[] := ARRAY['scheduled_at', 'procedure_label', 'requesting_physician', 'category'];
  why text := nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), '');
  corrected boolean;
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided appointment cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable - correctable) IS DISTINCT FROM (to_jsonb(OLD) - mutable - correctable) THEN
    RAISE EXCEPTION 'patient, service and source cannot be edited; void and book again' USING ERRCODE = 'check_violation';
  END IF;
  corrected := (SELECT bool_or(to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k) FROM unnest(correctable) k);
  IF NEW.voided_at IS NOT NULL THEN
    IF corrected OR (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by', 'correction_reason'])
                    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by', 'correction_reason']) THEN
      RAISE EXCEPTION 'void separately from other changes' USING ERRCODE = 'check_violation';
    END IF;
    NEW.voided_at := now();
    NEW.correction_reason := NULL;
    RETURN NEW;
  END IF;
  IF NOT diag_status_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'status % cannot change to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED')
     AND (to_jsonb(NEW) - ARRAY['updated_at', 'updated_by', 'correction_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'updated_by', 'correction_reason']) THEN
    RAISE EXCEPTION 'a closed appointment cannot be changed; void it with a reason' USING ERRCODE = 'check_violation';
  END IF;
  IF corrected THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'correct details separately from a status change' USING ERRCODE = 'check_violation';
    END IF;
    IF why IS NULL OR length(why) < 5 THEN
      RAISE EXCEPTION 'a reason is required to correct appointment details' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pft_form f WHERE f.appointment_id = OLD.id AND f.voided_at IS NULL AND f.status <> 'DRAFT') THEN
      RAISE EXCEPTION 'this appointment has a signed PFT record; its details cannot be corrected' USING ERRCODE = 'check_violation';
    END IF;
    NEW.correction_reason := left(why, 300);
  ELSE
    NEW.correction_reason := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP FUNCTION diag_history(uuid);
CREATE FUNCTION diag_history(appt uuid)
RETURNS TABLE (at timestamptz, actor text, action text, from_status text, to_status text, reason text, changed text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.occurred_at, s.display_name, a.action,
         a.before_data ->> 'status', a.after_data ->> 'status',
         CASE
           WHEN a.after_data ->> 'voided_at' IS NOT NULL AND a.before_data ->> 'voided_at' IS NULL THEN a.after_data ->> 'void_reason'
           WHEN a.after_data ->> 'correction_reason' IS NOT NULL THEN a.after_data ->> 'correction_reason'
           WHEN a.before_data ->> 'status' IS DISTINCT FROM a.after_data ->> 'status' THEN a.after_data ->> 'status_reason'
         END,
         ARRAY(SELECT k FROM unnest(ARRAY['scheduled_at', 'procedure_label', 'requesting_physician', 'category', 'remarks']) k
                WHERE a.before_data IS NOT NULL AND a.before_data -> k IS DISTINCT FROM a.after_data -> k)
    FROM audit_log a LEFT JOIN staff s ON s.id = a.actor_id
   WHERE app_active_staff_id() IS NOT NULL
     AND a.table_name = 'diagnostic_appointment' AND a.record_id = appt::text AND a.action LIKE 'diagnostic_appointment.%'
   ORDER BY a.id
$$;
GRANT EXECUTE ON FUNCTION diag_history(uuid) TO puims_app;

INSERT INTO schema_migrations (version, checksum) VALUES ('0010_pft_template_and_corrections.sql', 'fd13e8b8b7b432803b74388b4c1b61fb68838e9582181b82f896a0e1253286d0');
COMMIT;

-- ===== 0011_privacy_approvals_logo_originals.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0011 (2026-11-23): decisions recorded from the product owner — "everything approved by the hospital
-- privacy officer" (DPO). Applied to the privacy decisions only:
--   U-08 contact information MAY be stored → kept as a note exactly as written (never parsed as a phone number),
--        shown only on the appointment page; never in lists, exports or notifications.
--   U-09 payment classification MAY be stored.
--   Original workbooks MAY be retained → stored encrypted (AES-256-GCM, PUIMS_DATA_KEY) with the import batch,
--        Chief RT only, download requires step-up and is audited; erased when a staged batch is discarded.
-- Also: an optional hospital logo on the PFT template (PNG/JPEG only, ≤ 512 KB, versioned with the template).
-- Decisions needing hospital IT or clinical governance (U-01, U-03, U-04, U-05, U-06, U-10 content, U-18, U-19)
-- are NOT changed by this migration.

ALTER TABLE diagnostic_appointment DROP CONSTRAINT diag_payment_u09;
ALTER TABLE diagnostic_appointment ADD COLUMN contact_note text CHECK (length(contact_note) <= 300);

ALTER TABLE import_batch
  ADD COLUMN original_enc bytea,
  ADD COLUMN original_mime text CHECK (original_mime IS NULL OR original_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

ALTER TABLE pft_template
  ADD COLUMN logo bytea CHECK (logo IS NULL OR octet_length(logo) <= 524288),
  ADD COLUMN logo_mime text CHECK (logo_mime IS NULL OR logo_mime IN ('image/png', 'image/jpeg')),
  ADD CONSTRAINT pft_template_logo_chk CHECK ((logo IS NULL) = (logo_mime IS NULL));

-- Never copy binary files (logo, encrypted workbook) into the audit log; record their size instead.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  redact text[] := ARRAY['password_hash', 'totp_secret_enc', 'token_hash', 'key_enc', 'original_enc', 'logo'];
  b jsonb;
  a jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN b := to_jsonb(OLD) - redact; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN a := to_jsonb(NEW) - redact; END IF;
  IF TG_OP = 'UPDATE' AND a = b THEN RETURN NEW; END IF;
  INSERT INTO audit_log (action, table_name, record_id, before_data, after_data)
  VALUES (lower(TG_TABLE_NAME) || '.' || lower(TG_OP), TG_TABLE_NAME, coalesce(a ->> 'id', a ->> 'staff_id', a ->> 'key', b ->> 'id', b ->> 'staff_id', b ->> 'key'), b, a);
  RETURN coalesce(NEW, OLD);
END $$;

INSERT INTO schema_migrations (version, checksum) VALUES ('0011_privacy_approvals_logo_originals.sql', '2c007a4704323887a5a3a6eb0fbf34fff2ad5a2b0de6d45588375f00f4880c81');
COMMIT;

-- ===== 0012_esignatures_and_guide_import.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0012 (2026-11-23): product owner — "everything is approved" (privacy officer + clinical governance, U-18),
-- "the pulmonologist signs with an e-sign as in the Excel guide", and "don't change anything in the Excel file".
--  * Approved signatories may carry their e-signature image (PNG/JPEG ≤ 512 KB). Set once; never edited.
--  * Pulmonologist sign-off may be the approved e-signature, applied by the finalizing RT exactly as in the
--    Excel guide (method E_SIGNATURE_APPLIED_BY_RT); the wet-signature method remains available.
--  * Signatures found in the hospital's PFT guide workbook are staged as proposals (name exactly as written
--    under each image); the Chief RT accepts each one explicitly.

ALTER TABLE signatory
  ADD COLUMN signature_image bytea CHECK (signature_image IS NULL OR octet_length(signature_image) <= 524288),
  ADD COLUMN signature_mime text CHECK (signature_mime IS NULL OR signature_mime IN ('image/png', 'image/jpeg')),
  ADD COLUMN source text CHECK (length(source) <= 200),
  ADD CONSTRAINT signatory_signature_chk CHECK ((signature_image IS NULL) = (signature_mime IS NULL));

-- Entries are never edited; the only permitted additions are a signature image and an RT account link,
-- each once (from empty), plus deactivation.
CREATE OR REPLACE FUNCTION signatory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free text[] := ARRAY['active', 'deactivated_at', 'deactivated_by', 'signature_image', 'signature_mime', 'staff_id'];
BEGIN
  IF NOT OLD.active THEN RAISE EXCEPTION 'a deactivated signatory cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION 'signatory entries cannot be edited; deactivate and add a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.signature_image IS NOT NULL AND NEW.signature_image IS DISTINCT FROM OLD.signature_image)
     OR (OLD.staff_id IS NOT NULL AND NEW.staff_id IS DISTINCT FROM OLD.staff_id) THEN
    RAISE EXCEPTION 'a signature or account link, once set, cannot be changed; deactivate and add a new entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE pft_form DROP CONSTRAINT pft_form_pulmo_signoff_method_check;
ALTER TABLE pft_form ADD CONSTRAINT pft_form_pulmo_signoff_method_check
  CHECK (pulmo_signoff_method IN ('WET_SIGNATURE_ON_PRINTED_COPY', 'E_SIGNATURE_APPLIED_BY_RT'));

CREATE OR REPLACE FUNCTION pft_form_signer_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'RT_SIGNED' AND OLD.status = 'DRAFT' THEN
    IF NOT EXISTS (SELECT 1 FROM signatory WHERE id = NEW.rt_signatory_id AND kind = 'RESPIRATORY_THERAPIST' AND active AND staff_id = NEW.rt_signed_by) THEN
      RAISE EXCEPTION 'you can only sign as your own approved signatory entry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'FINAL' AND OLD.status = 'RT_SIGNED' THEN
    IF NOT EXISTS (SELECT 1 FROM signatory WHERE id = NEW.pulmo_signatory_id AND kind = 'PULMONOLOGIST' AND active
                   AND (NEW.pulmo_signoff_method <> 'E_SIGNATURE_APPLIED_BY_RT' OR signature_image IS NOT NULL)) THEN
      RAISE EXCEPTION 'choose an active pulmonologist from the approved directory (with an e-signature for e-sign)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE signatory_proposal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('RESPIRATORY_THERAPIST', 'PULMONOLOGIST')),
  display_name    text CHECK (length(display_name) <= 200),        -- exactly as written in the workbook (NULL = none found)
  signature_image bytea NOT NULL CHECK (octet_length(signature_image) <= 524288),
  signature_mime  text NOT NULL CHECK (signature_mime IN ('image/png', 'image/jpeg')),
  source          text NOT NULL CHECK (length(source) <= 200),      -- workbook sheet + cell
  file_sha256     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES staff(id),
  decided_at      timestamptz,
  decision        text CHECK (decision IN ('ACCEPTED', 'DISMISSED')),
  signatory_id    uuid REFERENCES signatory(id),
  CHECK ((decided_at IS NULL) = (decision IS NULL))
);
GRANT SELECT, INSERT, UPDATE ON signatory_proposal TO puims_app;
ALTER TABLE signatory_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY signatory_proposal_all ON signatory_proposal FOR ALL USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()));

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  redact text[] := ARRAY['password_hash', 'totp_secret_enc', 'token_hash', 'key_enc', 'original_enc', 'logo', 'signature_image'];
  b jsonb;
  a jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN b := to_jsonb(OLD) - redact; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN a := to_jsonb(NEW) - redact; END IF;
  IF TG_OP = 'UPDATE' AND a = b THEN RETURN NEW; END IF;
  INSERT INTO audit_log (action, table_name, record_id, before_data, after_data)
  VALUES (lower(TG_TABLE_NAME) || '.' || lower(TG_OP), TG_TABLE_NAME, coalesce(a ->> 'id', a ->> 'staff_id', a ->> 'key', b ->> 'id', b ->> 'staff_id', b ->> 'key'), b, a);
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER audit_signatory_proposal AFTER INSERT OR UPDATE ON signatory_proposal FOR EACH ROW EXECUTE FUNCTION audit_row_change();
-- signatory audit trigger already exists; images are redacted by the function above.
DROP TRIGGER audit_signatory ON signatory;
CREATE TRIGGER audit_signatory AFTER INSERT OR UPDATE ON signatory FOR EACH ROW EXECUTE FUNCTION audit_row_change();

INSERT INTO schema_migrations (version, checksum) VALUES ('0012_esignatures_and_guide_import.sql', 'e512c7b1fdc205bfc4d9fea28c83eea623549f16092f6c14d070c1e8b57a56d0');
COMMIT;

-- ===== 0013_signatory_update_policy.sql
BEGIN;
SET LOCAL ROLE puims_owner;
SET LOCAL search_path = public, extensions;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
-- 0013: the Chief RT may complete an active signatory entry (add its e-signature or RT account link once —
-- enforced by signatory_guard), not only deactivate it.
DROP POLICY signatory_update ON signatory;
CREATE POLICY signatory_update ON signatory FOR UPDATE
  USING ((SELECT app_is_chief()))
  WITH CHECK ((SELECT app_is_chief()) AND (active OR deactivated_by = (SELECT app_active_staff_id())));

INSERT INTO schema_migrations (version, checksum) VALUES ('0013_signatory_update_policy.sql', '718db149fd9864dab4cf8bef33bd93ee5c43e53f61fce493102b4185e41b271e');
COMMIT;

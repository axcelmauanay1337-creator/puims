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

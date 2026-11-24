-- 0018 (2026-11-24): MGH ("may go home") on the patient (product owner).
-- Marking a patient MGH discontinues all of their active nebulization orders in the same transaction, so their doses
-- disappear from the worklist, Today and alerts. This is done by the database (not only the app) so it cannot be missed.
-- Undoing MGH does not restart orders: a discontinued order is never changed; enter a new order if needed.

ALTER TABLE patient
  ADD COLUMN mgh_at timestamptz,
  ADD COLUMN mgh_by uuid REFERENCES staff(id),
  ADD CONSTRAINT patient_mgh_chk CHECK ((mgh_at IS NULL) = (mgh_by IS NULL));

CREATE FUNCTION patient_mgh_stop_nebs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.mgh_at IS NOT NULL AND OLD.mgh_at IS NULL THEN
    IF NEW.mgh_by IS DISTINCT FROM app_active_staff_id() AND app_active_staff_id() IS NOT NULL THEN
      RAISE EXCEPTION 'MGH must be recorded in your own name' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE neb_order
       SET discontinued_at = now(), discontinued_by = NEW.mgh_by, discontinue_reason = 'Patient MGH (may go home)'
     WHERE patient_id = NEW.id AND discontinued_at IS NULL AND (end_at IS NULL OR end_at > now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_mgh_stop_nebs AFTER UPDATE OF mgh_at ON patient FOR EACH ROW EXECUTE FUNCTION patient_mgh_stop_nebs();

CREATE OR REPLACE FUNCTION patient_record_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cols text[] := ARRAY['hospital_patient_id', 'full_name', 'date_of_birth', 'sex', 'category', 'ward_room', 'contact_info', 'attending_physician',
                       'height_cm', 'weight_kg', 'mgh_at', 'voided_at', 'void_reason'];
  b jsonb := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(cols) k);
  a jsonb := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(cols) k);
BEGIN
  IF a IS DISTINCT FROM b THEN
    INSERT INTO patient_revision (patient_id, changed_by, reason, before_data, after_data)
    VALUES (NEW.id, app_staff_id(), nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), ''), b, a);
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION patient_mgh_stop_nebs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_mgh_stop_nebs() TO puims_app;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION patient_mgh_stop_nebs() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

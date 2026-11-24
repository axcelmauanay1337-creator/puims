-- 0017 (2026-11-24): profile details for the Patient Master (product owner, approved design).
--  * contact_info: relative / phone exactly as given (not validated as a phone number).
--  * attending_physician: as written in the chart.
--  * height_cm / weight_kg: for PFT predicted values and dosing context.
-- These are kept in the correction history (patient_revision) like the other profile fields.

ALTER TABLE patient
  ADD COLUMN contact_info text CHECK (length(contact_info) <= 120),
  ADD COLUMN attending_physician text CHECK (length(attending_physician) <= 120),
  ADD COLUMN height_cm numeric(5, 1) CHECK (height_cm BETWEEN 20 AND 250),
  ADD COLUMN weight_kg numeric(5, 1) CHECK (weight_kg BETWEEN 0.3 AND 400);

CREATE OR REPLACE FUNCTION patient_record_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cols text[] := ARRAY['hospital_patient_id', 'full_name', 'date_of_birth', 'sex', 'category', 'ward_room', 'contact_info', 'attending_physician',
                       'height_cm', 'weight_kg', 'voided_at', 'void_reason'];
  b jsonb := (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(cols) k);
  a jsonb := (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(cols) k);
BEGIN
  IF a IS DISTINCT FROM b THEN
    INSERT INTO patient_revision (patient_id, changed_by, reason, before_data, after_data)
    VALUES (NEW.id, app_staff_id(), nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), ''), b, a);
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION patient_record_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_record_revision() TO puims_app;

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

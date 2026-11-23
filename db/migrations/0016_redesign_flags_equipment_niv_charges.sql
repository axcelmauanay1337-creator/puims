-- 0016 (2026-11-23): data for the redesigned workspace (product owner).
--
--  * patient: precautions, patient's own supplies, special endorsement (shown on every task).
--  * equipment: ventilator / HFNC / BiPAP units with preventive-maintenance date, out-of-service
--    flag and rental details. A unit can be on one patient at a time.
--  * vent_encounter.equipment_id: the unit used at hook-in (immutable with the other hook-in details).
--  * niv_encounter: HFNC / BiPAP / CPAP support, started and ended like a ventilator encounter.
--  * charge_post: machine charges posted to billing per patient per day (Chief RT; append-only).
--  * settings: machine prices per day.

-- ---------------------------------------------------------------- patient flags

ALTER TABLE patient
  ADD COLUMN precautions text[] NOT NULL DEFAULT '{}'
    CHECK (precautions <@ ARRAY['AIRBORNE', 'DROPLET', 'CONTACT', 'FALL_RISK', 'ASPIRATION', 'BLEEDING_RISK']::text[]),
  ADD COLUMN own_supplies text[] NOT NULL DEFAULT '{}'
    CHECK (own_supplies <@ ARRAY['OWN_MEDICATION', 'OWN_MESH_NEBULIZER', 'OWN_NEBULIZER_MACHINE']::text[]),
  ADD COLUMN special_endorsement text CHECK (length(special_endorsement) <= 1000);

-- ---------------------------------------------------------------- equipment

CREATE TABLE equipment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  kind            text NOT NULL CHECK (kind IN ('VENTILATOR', 'HFNC', 'BIPAP')),
  model           text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 60),
  pm_due_on       date,
  out_of_service  boolean NOT NULL DEFAULT false,
  rented_from     text CHECK (length(rented_from) <= 80),
  rented_since    date,
  rental_rate     numeric(10, 2) CHECK (rental_rate >= 0),
  retired_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES staff(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff(id),
  CHECK ((rented_from IS NULL) = (rental_rate IS NULL))
);
CREATE UNIQUE INDEX equipment_code_uq ON equipment (code);

ALTER TABLE vent_encounter ADD COLUMN equipment_id uuid REFERENCES equipment(id);
CREATE UNIQUE INDEX vent_equipment_in_use_uq ON vent_encounter (equipment_id) WHERE equipment_id IS NOT NULL AND disconnected_at IS NULL;

-- ---------------------------------------------------------------- HFNC / NIV

CREATE TABLE niv_encounter (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         uuid NOT NULL REFERENCES patient(id),
  device             text NOT NULL CHECK (device IN ('HFNC', 'BIPAP', 'CPAP')),
  setting            text NOT NULL CHECK (length(btrim(setting)) BETWEEN 1 AND 120),
  spo2_target        text CHECK (length(spo2_target) <= 20),
  equipment_id       uuid REFERENCES equipment(id),
  ward_room          text CHECK (length(ward_room) <= 60),
  started_at         timestamptz NOT NULL,
  started_by         uuid NOT NULL REFERENCES staff(id),
  ended_at           timestamptz,
  ended_by           uuid REFERENCES staff(id),
  end_reason         text CHECK (length(end_reason) <= 200),
  recorded_at_device timestamptz,
  received_at_server timestamptz NOT NULL DEFAULT now(),
  device_id          uuid REFERENCES device(id),
  operational_date   date,
  shift              text,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  EXCLUDE USING gist (patient_id WITH =, tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz)) WITH &&)
);
CREATE UNIQUE INDEX niv_equipment_in_use_uq ON niv_encounter (equipment_id) WHERE equipment_id IS NOT NULL AND ended_at IS NULL;
CREATE INDEX niv_patient_idx ON niv_encounter (patient_id);
CREATE TRIGGER niv_classify BEFORE INSERT OR UPDATE ON niv_encounter
  FOR EACH ROW EXECUTE FUNCTION set_shift_classification('started_at');

CREATE FUNCTION niv_encounter_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended HFNC/NIV encounter cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['ended_at', 'ended_by', 'end_reason', 'operational_date', 'shift'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['ended_at', 'ended_by', 'end_reason', 'operational_date', 'shift']) THEN
    RAISE EXCEPTION 'HFNC/NIV start details cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER niv_encounter_guard BEFORE UPDATE ON niv_encounter FOR EACH ROW EXECUTE FUNCTION niv_encounter_guard();

-- ---------------------------------------------------------------- charges (machines only)

CREATE TABLE charge_post (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patient(id),
  charge_date  date NOT NULL,
  lines        jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  total        numeric(12, 2) NOT NULL CHECK (total >= 0),
  posted_at    timestamptz NOT NULL DEFAULT now(),
  posted_by    uuid NOT NULL REFERENCES staff(id),
  UNIQUE (patient_id, charge_date)
);

CREATE FUNCTION charge_post_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'posted charges cannot be changed' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER charge_post_no_change BEFORE UPDATE OR DELETE ON charge_post FOR EACH ROW EXECUTE FUNCTION charge_post_immutable();

-- ---------------------------------------------------------------- settings: machine prices

ALTER TABLE setting DROP CONSTRAINT setting_value_valid;
ALTER TABLE setting ADD CONSTRAINT setting_value_valid CHECK (
  CASE key
    WHEN 'tubing.interval_days' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 1 AND 60 AND (value #>> '{}')::numeric % 1 = 0
    WHEN 'tubing.upcoming_window_hours' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 0 AND 336
    WHEN 'session.idle_minutes' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 2 AND 120 AND (value #>> '{}')::numeric % 1 = 0
    WHEN 'session.absolute_hours' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 1 AND 24 AND (value #>> '{}')::numeric % 1 = 0
    WHEN 'charges.ventilator_per_day' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 0 AND 1000000
    WHEN 'charges.hfnc_per_day' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 0 AND 1000000
    WHEN 'charges.niv_per_day' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 0 AND 1000000
    ELSE false
  END
);
INSERT INTO setting (key, value, description) VALUES
  ('charges.ventilator_per_day', '0', 'Ventilator charge per patient per day, ₱ (set by the Chief RT; rented units bill their rental rate instead)'),
  ('charges.hfnc_per_day', '0', 'HFNC machine charge per patient per day, ₱'),
  ('charges.niv_per_day', '0', 'BiPAP / CPAP machine charge per patient per day, ₱')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- audit, grants, RLS

CREATE TRIGGER audit_equipment AFTER INSERT OR UPDATE OR DELETE ON equipment FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_niv AFTER INSERT OR UPDATE OR DELETE ON niv_encounter FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_charge_post AFTER INSERT ON charge_post FOR EACH ROW EXECUTE FUNCTION audit_row_change();

GRANT SELECT, INSERT, UPDATE ON equipment, niv_encounter TO puims_app;
GRANT SELECT, INSERT ON charge_post TO puims_app;

ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY equipment_read ON equipment FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY equipment_insert ON equipment FOR INSERT WITH CHECK ((SELECT app_is_chief()) AND created_by = (SELECT app_active_staff_id()));
CREATE POLICY equipment_update ON equipment FOR UPDATE USING ((SELECT app_is_chief())) WITH CHECK (updated_by = (SELECT app_active_staff_id()));

ALTER TABLE niv_encounter ENABLE ROW LEVEL SECURITY;
CREATE POLICY niv_read ON niv_encounter FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY niv_insert ON niv_encounter FOR INSERT
  WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND started_by = (SELECT app_active_staff_id()) AND ended_at IS NULL);
CREATE POLICY niv_update ON niv_encounter FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL) WITH CHECK (ended_by = (SELECT app_active_staff_id()));

ALTER TABLE charge_post ENABLE ROW LEVEL SECURITY;
CREATE POLICY charge_read ON charge_post FOR SELECT USING ((SELECT app_is_chief()));
CREATE POLICY charge_insert ON charge_post FOR INSERT WITH CHECK ((SELECT app_is_chief()) AND posted_by = (SELECT app_active_staff_id()));

-- Keep 0015's function hardening for the functions added here.
REVOKE EXECUTE ON FUNCTION niv_encounter_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION charge_post_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION niv_encounter_guard() TO puims_app;
GRANT EXECUTE ON FUNCTION charge_post_immutable() TO puims_app;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON equipment, niv_encounter, charge_post FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION niv_encounter_guard(), charge_post_immutable() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

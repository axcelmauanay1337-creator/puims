-- 0014: what an RT actually documents on a ventilated patient.
--  * vent_setting: timestamped ventilator settings / readings (flowsheet). Documentation only —
--    values are what the RT read off the ventilator; PUIMS never suggests, interprets or alarms.
--    Ranges below only stop obvious typing errors (e.g. FiO2 210). Append-only; void with reason.
--  * vent_encounter: airway at hook-in (type / size / position) and the reason for disconnection.
--  * "Chamfecof" was a misspelling of "change of (tubing)": the default label for NEW entries is corrected;
--    documented entries are never edited (append-only), so any older rows keep their original text.

ALTER TABLE tubing_event ALTER COLUMN tubing_type SET DEFAULT 'Ventilator circuit';
UPDATE setting SET description = 'Change of tubing (ventilator circuit) interval in calendar days (policy-pending, U-04)'
 WHERE key = 'tubing.interval_days';

-- Airway + disconnection reason --------------------------------------------------------------
ALTER TABLE vent_encounter
  ADD COLUMN airway_type text CHECK (airway_type IN ('ETT', 'TRACHEOSTOMY', 'NIV_MASK', 'OTHER')),
  ADD COLUMN airway_size text CHECK (length(airway_size) <= 20),
  ADD COLUMN airway_position text CHECK (length(airway_position) <= 40),
  ADD COLUMN disconnect_reason text CHECK (disconnect_reason IN
    ('EXTUBATED', 'LIBERATED_TRACH', 'CHANGED_TO_NIV', 'TRANSFERRED', 'EXPIRED', 'EQUIPMENT_CHANGE', 'OTHER')),
  ADD COLUMN disconnect_note text CHECK (length(disconnect_note) <= 300);

CREATE OR REPLACE FUNCTION vent_encounter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disconnected_at IS NOT NULL THEN
    RAISE EXCEPTION 'a discontinued encounter cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['disconnected_at', 'status', 'disconnect_reason', 'disconnect_note'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['disconnected_at', 'status', 'disconnect_reason', 'disconnect_note']) THEN
    RAISE EXCEPTION 'hook-in details cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.disconnected_at IS NULL AND (NEW.disconnect_reason IS NOT NULL OR NEW.disconnect_note IS NOT NULL) THEN
    RAISE EXCEPTION 'a disconnection reason needs a disconnection time' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Ventilator settings flowsheet ---------------------------------------------------------------
CREATE TABLE vent_setting (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id         uuid NOT NULL REFERENCES vent_encounter(id),
  recorded_at          timestamptz NOT NULL,   -- clinical time the values were read
  mode                 text NOT NULL CHECK (mode IN
    ('VC_AC', 'PC_AC', 'PRVC', 'SIMV_VC', 'SIMV_PC', 'PSV_CPAP', 'APRV', 'NIV_BIPAP', 'NIV_CPAP', 'OTHER')),
  mode_other           text CHECK (length(mode_other) <= 40),
  fio2                 integer NOT NULL CHECK (fio2 BETWEEN 21 AND 100),             -- %
  peep                 numeric(4,1) NOT NULL CHECK (peep BETWEEN 0 AND 30),        -- cmH2O (EPAP for NIV)
  tidal_volume         integer CHECK (tidal_volume BETWEEN 20 AND 2000),           -- mL, set
  set_rate             integer CHECK (set_rate BETWEEN 0 AND 80),                  -- /min
  pressure_support     numeric(4,1) CHECK (pressure_support BETWEEN 0 AND 40),     -- cmH2O above PEEP
  inspiratory_pressure numeric(4,1) CHECK (inspiratory_pressure BETWEEN 0 AND 60), -- cmH2O (Pinsp / IPAP)
  inspiratory_time     numeric(3,2) CHECK (inspiratory_time BETWEEN 0.1 AND 5),    -- s
  peak_pressure        numeric(4,1) CHECK (peak_pressure BETWEEN 0 AND 80),        -- cmH2O, measured
  plateau_pressure     numeric(4,1) CHECK (plateau_pressure BETWEEN 0 AND 60),     -- cmH2O, measured
  total_rate           integer CHECK (total_rate BETWEEN 0 AND 90),                -- /min, measured
  exhaled_vt           integer CHECK (exhaled_vt BETWEEN 0 AND 3000),              -- mL, measured
  minute_ventilation   numeric(4,1) CHECK (minute_ventilation BETWEEN 0 AND 50),   -- L/min, measured
  spo2                 integer CHECK (spo2 BETWEEN 50 AND 100),                    -- %
  cuff_pressure        integer CHECK (cuff_pressure BETWEEN 0 AND 60),             -- cmH2O
  note                 text CHECK (length(note) <= 300),
  recorded_by          uuid NOT NULL REFERENCES staff(id),
  recorded_at_device   timestamptz,
  received_at_server   timestamptz NOT NULL DEFAULT now(),
  source               text NOT NULL DEFAULT 'ONLINE' CHECK (source IN ('ONLINE', 'OFFLINE_SYNC', 'IMPORT', 'SEED')),
  device_id            uuid REFERENCES device(id),
  operational_date     date,
  shift                text,
  voided_at            timestamptz,
  voided_by            uuid REFERENCES staff(id),
  void_reason          text CHECK (length(void_reason) <= 300),
  CHECK ((mode = 'OTHER') = (mode_other IS NOT NULL)),
  CONSTRAINT vent_setting_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX vent_setting_encounter_idx ON vent_setting (encounter_id, recorded_at DESC);

CREATE TRIGGER vent_setting_classify BEFORE INSERT OR UPDATE ON vent_setting
  FOR EACH ROW EXECUTE FUNCTION set_shift_classification('recorded_at');
CREATE TRIGGER vent_setting_guard BEFORE UPDATE ON vent_setting FOR EACH ROW EXECUTE FUNCTION documented_event_guard();
CREATE TRIGGER audit_vent_setting AFTER INSERT OR UPDATE OR DELETE ON vent_setting FOR EACH ROW EXECUTE FUNCTION audit_row_change();

GRANT SELECT, INSERT, UPDATE ON vent_setting TO puims_app;
ALTER TABLE vent_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY vent_setting_read ON vent_setting FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY vent_setting_insert ON vent_setting FOR INSERT
  WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND recorded_by = (SELECT app_active_staff_id()) AND voided_at IS NULL);
CREATE POLICY vent_setting_update ON vent_setting FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL)
  WITH CHECK (voided_by = (SELECT app_active_staff_id()) AND (recorded_by = (SELECT app_active_staff_id()) OR (SELECT app_is_chief())));

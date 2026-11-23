-- 0002: clinical schema. Nothing is ever hard-deleted (no DELETE grants; void columns instead).
-- Shift and operational date are computed HERE from the clinical event time (ADR-0004) —
-- clients cannot set them.

-- ---------------------------------------------------------------- time classification

-- Asia/Manila: Morning 06–14, Afternoon 14–22, Night 22–06; operational date changes at 06:00.
CREATE FUNCTION classify_shift(ts timestamptz, OUT operational_date date, OUT shift text)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN extract(hour FROM l) < 6 THEN (l::date - 1) ELSE l::date END,
         CASE WHEN extract(hour FROM l) >= 6 AND extract(hour FROM l) < 14 THEN 'MORNING'
              WHEN extract(hour FROM l) >= 14 AND extract(hour FROM l) < 22 THEN 'AFTERNOON'
              ELSE 'NIGHT' END
  FROM (SELECT ts AT TIME ZONE 'Asia/Manila' AS l) s
$$;

CREATE FUNCTION operational_day_bounds(d date, OUT start_at timestamptz, OUT end_at timestamptz)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT (d + time '06:00') AT TIME ZONE 'Asia/Manila', (d + 1 + time '06:00') AT TIME ZONE 'Asia/Manila'
$$;

-- Generic trigger: sets operational_date/shift from the column named in TG_ARGV[0] (or the first non-null of several).
CREATE FUNCTION set_shift_classification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ts timestamptz;
  col text;
  c record;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I', col) INTO ts USING NEW;
    EXIT WHEN ts IS NOT NULL;
  END LOOP;
  IF ts IS NULL THEN
    NEW.operational_date := NULL;
    NEW.shift := NULL;
  ELSE
    c := classify_shift(ts);
    NEW.operational_date := c.operational_date;
    NEW.shift := c.shift;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- patients

CREATE TABLE patient (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_patient_id text CHECK (hospital_patient_id IS NULL OR length(btrim(hospital_patient_id)) BETWEEN 1 AND 40),
  full_name           text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
  date_of_birth       date CHECK (date_of_birth IS NULL OR date_of_birth > '1890-01-01'),
  sex                 text NOT NULL DEFAULT 'UNKNOWN' CHECK (sex IN ('M', 'F', 'X', 'UNKNOWN')),  -- U-07
  category            text NOT NULL CHECK (category IN ('OPD', 'INP', 'OTHER')),
  ward_room           text CHECK (length(ward_room) <= 60),
  provenance          text NOT NULL DEFAULT 'MANUAL' CHECK (provenance IN ('MANUAL', 'IMPORT', 'SEED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES staff(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES staff(id),
  voided_at           timestamptz,
  voided_by           uuid REFERENCES staff(id),
  void_reason         text,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
-- Hospital number is optional (imports may lack it, U-13) but unique when present.
CREATE UNIQUE INDEX patient_hospital_id_uq ON patient (upper(btrim(hospital_patient_id))) WHERE hospital_patient_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX patient_name_idx ON patient (lower(full_name));

-- ---------------------------------------------------------------- shifts

CREATE TABLE shift_assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operational_date date NOT NULL,
  shift            text NOT NULL CHECK (shift IN ('MORNING', 'AFTERNOON', 'NIGHT')),
  staff_id         uuid NOT NULL REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES staff(id),
  UNIQUE (operational_date, shift, staff_id)
);

-- ---------------------------------------------------------------- nebulization

CREATE TABLE neb_order (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            uuid NOT NULL REFERENCES patient(id),
  order_reference       text NOT NULL CHECK (length(order_reference) <= 60),
  prescriber            text NOT NULL CHECK (length(prescriber) <= 120),
  medication_as_ordered text NOT NULL CHECK (length(medication_as_ordered) <= 300),
  frequency             text NOT NULL CHECK (frequency IN ('STAT','ONCE','BID','TID','QID','Q4H','Q6H','Q8H','Q12H','PRN','CUSTOM')),
  -- Times exactly as written on the clinician's order. Never derived from frequency.
  prescribed_times      time[] NOT NULL DEFAULT '{}',
  start_at              timestamptz NOT NULL,
  end_at                timestamptz,
  entered_by            uuid REFERENCES staff(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at IS NULL OR end_at >= start_at),
  CHECK (frequency <> 'PRN' OR cardinality(prescribed_times) = 0)
);
CREATE INDEX neb_order_patient_idx ON neb_order (patient_id);

CREATE TABLE neb_administration (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES neb_order(id),
  patient_id         uuid NOT NULL REFERENCES patient(id),
  scheduled_at       timestamptz,
  actual_at          timestamptz,
  status             text NOT NULL CHECK (status IN ('SCHEDULED','PENDING','IN_PROGRESS','COMPLETED','DELAYED','NOT_GIVEN','REFUSED','CANCELLED')),
  performed_by       uuid REFERENCES staff(id),
  reason             text CHECK (length(reason) <= 500),
  -- event provenance (offline-ready)
  recorded_at_device timestamptz,
  received_at_server timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL DEFAULT 'ONLINE' CHECK (source IN ('ONLINE', 'OFFLINE_SYNC', 'IMPORT', 'SEED')),
  device_id          uuid REFERENCES device(id),
  operational_date   date,
  shift              text,
  CHECK (scheduled_at IS NOT NULL OR actual_at IS NOT NULL),
  CHECK (status NOT IN ('NOT_GIVEN','REFUSED','CANCELLED','DELAYED') OR length(btrim(coalesce(reason, ''))) > 0),
  CHECK (status <> 'COMPLETED' OR (actual_at IS NOT NULL AND performed_by IS NOT NULL))
);
CREATE INDEX neb_admin_time_idx ON neb_administration (coalesce(scheduled_at, actual_at));
CREATE INDEX neb_admin_order_idx ON neb_administration (order_id);
CREATE TRIGGER neb_admin_classify BEFORE INSERT OR UPDATE ON neb_administration
  FOR EACH ROW EXECUTE FUNCTION set_shift_classification('actual_at', 'scheduled_at');

CREATE FUNCTION neb_admin_patient_matches_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neb_order o WHERE o.id = NEW.order_id AND o.patient_id = NEW.patient_id) THEN
    RAISE EXCEPTION 'administration patient does not match order patient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neb_admin_patient_check BEFORE INSERT OR UPDATE ON neb_administration
  FOR EACH ROW EXECUTE FUNCTION neb_admin_patient_matches_order();

-- ---------------------------------------------------------------- ventilation & tubing

CREATE TABLE vent_encounter (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           uuid NOT NULL REFERENCES patient(id),
  hooked_at            timestamptz NOT NULL,
  disconnected_at      timestamptz,
  ventilator_ref       text NOT NULL CHECK (length(ventilator_ref) <= 60),
  ward_room            text NOT NULL CHECK (length(ward_room) <= 60),
  responsible_staff_id uuid REFERENCES staff(id),
  status               text GENERATED ALWAYS AS (CASE WHEN disconnected_at IS NULL THEN 'ACTIVE' ELSE 'DISCONTINUED' END) STORED,
  recorded_at_device   timestamptz,
  received_at_server   timestamptz NOT NULL DEFAULT now(),
  source               text NOT NULL DEFAULT 'ONLINE' CHECK (source IN ('ONLINE', 'OFFLINE_SYNC', 'IMPORT', 'SEED')),
  device_id            uuid REFERENCES device(id),
  operational_date     date,
  shift                text,
  CHECK (disconnected_at IS NULL OR disconnected_at >= hooked_at),
  -- A patient cannot be on two overlapping ventilator encounters (to confirm with the unit).
  EXCLUDE USING gist (patient_id WITH =, tstzrange(hooked_at, coalesce(disconnected_at, 'infinity'::timestamptz)) WITH &&)
);
CREATE TRIGGER vent_classify BEFORE INSERT OR UPDATE ON vent_encounter
  FOR EACH ROW EXECUTE FUNCTION set_shift_classification('hooked_at');

CREATE TABLE tubing_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id       uuid NOT NULL REFERENCES vent_encounter(id),
  tubing_type        text NOT NULL DEFAULT 'Chamfecof' CHECK (length(tubing_type) <= 60),
  installed_at       timestamptz NOT NULL,
  -- Interval in force when documented (kept per row so history survives policy changes).
  interval_days      integer NOT NULL CHECK (interval_days BETWEEN 1 AND 60),
  next_due_at        timestamptz NOT NULL,
  performed_by       uuid NOT NULL REFERENCES staff(id),
  reason             text NOT NULL CHECK (length(reason) <= 300),
  recorded_at_device timestamptz,
  received_at_server timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL DEFAULT 'ONLINE' CHECK (source IN ('ONLINE', 'OFFLINE_SYNC', 'IMPORT', 'SEED')),
  device_id          uuid REFERENCES device(id),
  operational_date   date,
  shift              text
);
CREATE INDEX tubing_encounter_idx ON tubing_event (encounter_id, installed_at DESC);

CREATE FUNCTION tubing_event_derive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hook timestamptz;
BEGIN
  SELECT hooked_at INTO hook FROM vent_encounter WHERE id = NEW.encounter_id;
  IF NEW.installed_at < hook THEN
    RAISE EXCEPTION 'tubing installed before the encounter began' USING ERRCODE = 'check_violation';
  END IF;
  NEW.next_due_at := NEW.installed_at + make_interval(days => NEW.interval_days);
  RETURN NEW;
END $$;
CREATE TRIGGER tubing_derive BEFORE INSERT OR UPDATE ON tubing_event FOR EACH ROW EXECUTE FUNCTION tubing_event_derive();
CREATE TRIGGER tubing_classify BEFORE INSERT OR UPDATE ON tubing_event
  FOR EACH ROW EXECUTE FUNCTION set_shift_classification('installed_at');

-- ---------------------------------------------------------------- diagnostics

CREATE TABLE diagnostic_appointment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           uuid NOT NULL REFERENCES patient(id),
  service              text NOT NULL CHECK (service IN ('PFT', 'ABG', 'SPUTUM_INDUCTION')),
  scheduled_at         timestamptz NOT NULL,
  status               text NOT NULL CHECK (status IN ('SCHEDULED','PENDING','COMPLETED','NO_SHOW','CANCELLED','FOR_RESCHEDULE','RESCHEDULED')),
  raw_status           text CHECK (length(raw_status) <= 80),          -- as entered/imported
  procedure_label      text NOT NULL CHECK (length(procedure_label) <= 160),  -- as recorded; no inference
  requesting_physician text CHECK (length(requesting_physician) <= 120),
  category             text NOT NULL CHECK (category IN ('OPD', 'INP', 'OTHER')),
  scheduler_id         uuid REFERENCES staff(id),
  performed_by         uuid REFERENCES staff(id),
  reschedules_id       uuid REFERENCES diagnostic_appointment(id),   -- lineage; both rows kept
  remarks              text CHECK (length(remarks) <= 1000),
  recorded_at_device   timestamptz,
  received_at_server   timestamptz NOT NULL DEFAULT now(),
  source               text NOT NULL DEFAULT 'ONLINE' CHECK (source IN ('ONLINE', 'OFFLINE_SYNC', 'IMPORT', 'SEED')),
  device_id            uuid REFERENCES device(id),
  operational_date     date,
  shift                text,
  CHECK (reschedules_id IS NULL OR reschedules_id <> id)
);
CREATE INDEX diag_time_idx ON diagnostic_appointment (service, scheduled_at);
CREATE INDEX diag_patient_idx ON diagnostic_appointment (patient_id);
CREATE TRIGGER diag_classify BEFORE INSERT OR UPDATE ON diagnostic_appointment
  FOR EACH ROW EXECUTE FUNCTION set_shift_classification('scheduled_at');

-- ---------------------------------------------------------------- handover

CREATE TABLE shift_handover (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operational_date   date NOT NULL,
  shift              text NOT NULL CHECK (shift IN ('MORNING', 'AFTERNOON', 'NIGHT')),
  outgoing_staff_id  uuid NOT NULL REFERENCES staff(id),
  incoming_staff_id  uuid REFERENCES staff(id),
  equipment_concerns text CHECK (length(equipment_concerns) <= 2000),
  notes              text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_at    timestamptz,
  acknowledged_by    uuid REFERENCES staff(id),
  UNIQUE (operational_date, shift),  -- U-11: one per shift for now
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);

-- Open items carried forward BY REFERENCE to the original record — never copies.
CREATE TABLE handover_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id uuid NOT NULL REFERENCES shift_handover(id),
  kind        text NOT NULL CHECK (kind IN ('VENTILATOR_ENCOUNTER', 'NEBULIZATION_ADMIN', 'TUBING', 'DIAGNOSTIC')),
  ref_id      uuid NOT NULL,
  summary     text NOT NULL CHECK (length(summary) <= 200),
  UNIQUE (handover_id, kind, ref_id)
);

CREATE FUNCTION handover_item_ref_exists() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  ok := CASE NEW.kind
    WHEN 'VENTILATOR_ENCOUNTER' THEN EXISTS (SELECT 1 FROM vent_encounter WHERE id = NEW.ref_id)
    WHEN 'NEBULIZATION_ADMIN'   THEN EXISTS (SELECT 1 FROM neb_administration WHERE id = NEW.ref_id)
    WHEN 'TUBING'               THEN EXISTS (SELECT 1 FROM vent_encounter WHERE id = NEW.ref_id)
    WHEN 'DIAGNOSTIC'           THEN EXISTS (SELECT 1 FROM diagnostic_appointment WHERE id = NEW.ref_id)
  END;
  IF NOT ok THEN RAISE EXCEPTION 'handover item references a missing record' USING ERRCODE = 'foreign_key_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER handover_item_ref BEFORE INSERT OR UPDATE ON handover_item FOR EACH ROW EXECUTE FUNCTION handover_item_ref_exists();

-- ---------------------------------------------------------------- documented service events (read model)

CREATE VIEW service_event_v WITH (security_invoker = true) AS
  SELECT a.id::text AS id, 'NEBULIZATION'::text AS service, a.patient_id, a.performed_by AS staff_id,
         coalesce(a.actual_at, a.scheduled_at) AS occurred_at, a.status, a.id AS source_id
    FROM neb_administration a WHERE a.performed_by IS NOT NULL
  UNION ALL
  SELECT e.id::text || ':hook', 'MECHANICAL_VENTILATION', e.patient_id, e.responsible_staff_id, e.hooked_at, 'HOOK_IN', e.id
    FROM vent_encounter e WHERE e.responsible_staff_id IS NOT NULL
  UNION ALL
  SELECT e.id::text || ':disc', 'MECHANICAL_VENTILATION', e.patient_id, e.responsible_staff_id, e.disconnected_at, 'DISCONNECTION', e.id
    FROM vent_encounter e WHERE e.disconnected_at IS NOT NULL AND e.responsible_staff_id IS NOT NULL
  UNION ALL
  SELECT t.id::text, 'TUBING_REPLACEMENT', e.patient_id, t.performed_by, t.installed_at, 'COMPLETED', t.id
    FROM tubing_event t JOIN vent_encounter e ON e.id = t.encounter_id
  UNION ALL
  SELECT d.id::text, d.service, d.patient_id, d.performed_by, d.scheduled_at, 'COMPLETED', d.id
    FROM diagnostic_appointment d WHERE d.status = 'COMPLETED' AND d.performed_by IS NOT NULL;

-- ---------------------------------------------------------------- audit triggers

CREATE TRIGGER audit_patient AFTER INSERT OR UPDATE OR DELETE ON patient FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_shift_assignment AFTER INSERT OR UPDATE OR DELETE ON shift_assignment FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_neb_order AFTER INSERT OR UPDATE OR DELETE ON neb_order FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_neb_admin AFTER INSERT OR UPDATE OR DELETE ON neb_administration FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_vent AFTER INSERT OR UPDATE OR DELETE ON vent_encounter FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_tubing AFTER INSERT OR UPDATE OR DELETE ON tubing_event FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_diag AFTER INSERT OR UPDATE OR DELETE ON diagnostic_appointment FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_handover AFTER INSERT OR UPDATE OR DELETE ON shift_handover FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_handover_item AFTER INSERT OR UPDATE OR DELETE ON handover_item FOR EACH ROW EXECUTE FUNCTION audit_row_change();

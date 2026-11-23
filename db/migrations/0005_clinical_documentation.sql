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

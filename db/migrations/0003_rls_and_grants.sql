-- 0003: least-privilege grants for puims_app and row-level security on EVERY table.
--
-- RLS is a second, independent enforcement layer behind the app's own permission
-- checks: a query issued without a valid, MFA-verified, unexpired session for an
-- ACTIVE staff member on an ACTIVE device returns no rows and cannot write.
-- The 'auth' context (login/activation) only reaches identity tables, never clinical ones.

-- ---------------------------------------------------------------- grants (no DELETE/TRUNCATE anywhere)

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM puims_app;

GRANT SELECT, INSERT, UPDATE ON
  staff, device, auth_credential, auth_token, auth_session, setting,
  patient, shift_assignment, neb_order, neb_administration, vent_encounter, tubing_event,
  diagnostic_appointment, shift_handover, handover_item
TO puims_app;
GRANT SELECT, INSERT ON audit_log TO puims_app;
GRANT SELECT ON service_event_v TO puims_app;

GRANT EXECUTE ON FUNCTION
  app_staff_id(), app_session_id(), app_device_id(), app_auth_context(), app_active_staff_id(), app_is_chief(),
  classify_shift(timestamptz), operational_day_bounds(date)
TO puims_app;

-- ---------------------------------------------------------------- RLS

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE device ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE neb_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE neb_administration ENABLE ROW LEVEL SECURITY;
ALTER TABLE vent_encounter ENABLE ROW LEVEL SECURITY;
ALTER TABLE tubing_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover_item ENABLE ROW LEVEL SECURITY;

-- Identity ------------------------------------------------------------------

CREATE POLICY staff_read ON staff FOR SELECT
  USING ((SELECT app_active_staff_id()) IS NOT NULL OR (SELECT app_auth_context()));
CREATE POLICY staff_insert ON staff FOR INSERT
  WITH CHECK ((SELECT app_is_chief()) AND role = 'RESPIRATORY_THERAPIST');
CREATE POLICY staff_update ON staff FOR UPDATE
  USING ((SELECT app_is_chief()) OR (SELECT app_auth_context()))
  WITH CHECK ((SELECT app_is_chief()) OR (SELECT app_auth_context()));

CREATE POLICY credential_auth_only ON auth_credential FOR ALL
  USING ((SELECT app_auth_context())) WITH CHECK ((SELECT app_auth_context()));

CREATE POLICY token_auth_only ON auth_token FOR ALL
  USING ((SELECT app_auth_context())) WITH CHECK ((SELECT app_auth_context()));

CREATE POLICY session_read ON auth_session FOR SELECT
  USING ((SELECT app_auth_context()) OR staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief()));
CREATE POLICY session_insert ON auth_session FOR INSERT WITH CHECK ((SELECT app_auth_context()));
CREATE POLICY session_update ON auth_session FOR UPDATE
  USING ((SELECT app_auth_context()) OR staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief()))
  WITH CHECK ((SELECT app_auth_context()) OR staff_id = (SELECT app_active_staff_id()) OR (SELECT app_is_chief()));

CREATE POLICY device_read ON device FOR SELECT
  USING ((SELECT app_auth_context()) OR (SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY device_insert ON device FOR INSERT WITH CHECK ((SELECT app_auth_context()));
CREATE POLICY device_update ON device FOR UPDATE
  USING ((SELECT app_auth_context()) OR (SELECT app_is_chief()))
  WITH CHECK ((SELECT app_auth_context()) OR (SELECT app_is_chief()));

CREATE POLICY setting_read ON setting FOR SELECT
  USING ((SELECT app_auth_context()) OR (SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY setting_update ON setting FOR UPDATE
  USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()));

-- Audit: anyone in a request may append (actor is stamped by trigger); only the Chief RT reads.
CREATE POLICY audit_append ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_read ON audit_log FOR SELECT USING ((SELECT app_is_chief()));

-- Clinical (unit-scoped read for every active RT — assumption A-02) -----------

CREATE POLICY patient_read ON patient FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY patient_write ON patient FOR INSERT WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL AND created_by = (SELECT app_active_staff_id()));
CREATE POLICY patient_update ON patient FOR UPDATE
  USING ((SELECT app_active_staff_id()) IS NOT NULL) WITH CHECK (updated_by = (SELECT app_active_staff_id()));

CREATE POLICY shift_read ON shift_assignment FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL);
CREATE POLICY shift_insert ON shift_assignment FOR INSERT WITH CHECK ((SELECT app_is_chief()));
CREATE POLICY shift_update ON shift_assignment FOR UPDATE USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['neb_order', 'neb_administration', 'vent_encounter', 'tubing_event', 'diagnostic_appointment', 'shift_handover', 'handover_item'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING ((SELECT app_active_staff_id()) IS NOT NULL)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL)', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING ((SELECT app_active_staff_id()) IS NOT NULL) WITH CHECK ((SELECT app_active_staff_id()) IS NOT NULL)', t || '_update', t);
  END LOOP;
END $$;

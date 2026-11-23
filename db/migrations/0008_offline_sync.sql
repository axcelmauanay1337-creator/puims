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

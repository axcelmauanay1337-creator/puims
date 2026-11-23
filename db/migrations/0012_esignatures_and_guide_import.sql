-- 0012 (2026-11-23): product owner — "everything is approved" (privacy officer + clinical governance, U-18),
-- "the pulmonologist signs with an e-sign as in the Excel guide", and "don't change anything in the Excel file".
--  * Approved signatories may carry their e-signature image (PNG/JPEG ≤ 512 KB). Set once; never edited.
--  * Pulmonologist sign-off may be the approved e-signature, applied by the finalizing RT exactly as in the
--    Excel guide (method E_SIGNATURE_APPLIED_BY_RT); the wet-signature method remains available.
--  * Signatures found in the hospital's PFT guide workbook are staged as proposals (name exactly as written
--    under each image); the Chief RT accepts each one explicitly.

ALTER TABLE signatory
  ADD COLUMN signature_image bytea CHECK (signature_image IS NULL OR octet_length(signature_image) <= 524288),
  ADD COLUMN signature_mime text CHECK (signature_mime IS NULL OR signature_mime IN ('image/png', 'image/jpeg')),
  ADD COLUMN source text CHECK (length(source) <= 200),
  ADD CONSTRAINT signatory_signature_chk CHECK ((signature_image IS NULL) = (signature_mime IS NULL));

-- Entries are never edited; the only permitted additions are a signature image and an RT account link,
-- each once (from empty), plus deactivation.
CREATE OR REPLACE FUNCTION signatory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free text[] := ARRAY['active', 'deactivated_at', 'deactivated_by', 'signature_image', 'signature_mime', 'staff_id'];
BEGIN
  IF NOT OLD.active THEN RAISE EXCEPTION 'a deactivated signatory cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  IF (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION 'signatory entries cannot be edited; deactivate and add a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.signature_image IS NOT NULL AND NEW.signature_image IS DISTINCT FROM OLD.signature_image)
     OR (OLD.staff_id IS NOT NULL AND NEW.staff_id IS DISTINCT FROM OLD.staff_id) THEN
    RAISE EXCEPTION 'a signature or account link, once set, cannot be changed; deactivate and add a new entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE pft_form DROP CONSTRAINT pft_form_pulmo_signoff_method_check;
ALTER TABLE pft_form ADD CONSTRAINT pft_form_pulmo_signoff_method_check
  CHECK (pulmo_signoff_method IN ('WET_SIGNATURE_ON_PRINTED_COPY', 'E_SIGNATURE_APPLIED_BY_RT'));

CREATE OR REPLACE FUNCTION pft_form_signer_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'RT_SIGNED' AND OLD.status = 'DRAFT' THEN
    IF NOT EXISTS (SELECT 1 FROM signatory WHERE id = NEW.rt_signatory_id AND kind = 'RESPIRATORY_THERAPIST' AND active AND staff_id = NEW.rt_signed_by) THEN
      RAISE EXCEPTION 'you can only sign as your own approved signatory entry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'FINAL' AND OLD.status = 'RT_SIGNED' THEN
    IF NOT EXISTS (SELECT 1 FROM signatory WHERE id = NEW.pulmo_signatory_id AND kind = 'PULMONOLOGIST' AND active
                   AND (NEW.pulmo_signoff_method <> 'E_SIGNATURE_APPLIED_BY_RT' OR signature_image IS NOT NULL)) THEN
      RAISE EXCEPTION 'choose an active pulmonologist from the approved directory (with an e-signature for e-sign)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE signatory_proposal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('RESPIRATORY_THERAPIST', 'PULMONOLOGIST')),
  display_name    text CHECK (length(display_name) <= 200),        -- exactly as written in the workbook (NULL = none found)
  signature_image bytea NOT NULL CHECK (octet_length(signature_image) <= 524288),
  signature_mime  text NOT NULL CHECK (signature_mime IN ('image/png', 'image/jpeg')),
  source          text NOT NULL CHECK (length(source) <= 200),      -- workbook sheet + cell
  file_sha256     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES staff(id),
  decided_at      timestamptz,
  decision        text CHECK (decision IN ('ACCEPTED', 'DISMISSED')),
  signatory_id    uuid REFERENCES signatory(id),
  CHECK ((decided_at IS NULL) = (decision IS NULL))
);
GRANT SELECT, INSERT, UPDATE ON signatory_proposal TO puims_app;
ALTER TABLE signatory_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY signatory_proposal_all ON signatory_proposal FOR ALL USING ((SELECT app_is_chief())) WITH CHECK ((SELECT app_is_chief()));

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  redact text[] := ARRAY['password_hash', 'totp_secret_enc', 'token_hash', 'key_enc', 'original_enc', 'logo', 'signature_image'];
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
CREATE TRIGGER audit_signatory_proposal AFTER INSERT OR UPDATE ON signatory_proposal FOR EACH ROW EXECUTE FUNCTION audit_row_change();
-- signatory audit trigger already exists; images are redacted by the function above.
DROP TRIGGER audit_signatory ON signatory;
CREATE TRIGGER audit_signatory AFTER INSERT OR UPDATE ON signatory FOR EACH ROW EXECUTE FUNCTION audit_row_change();

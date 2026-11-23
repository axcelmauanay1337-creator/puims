-- 0011 (2026-11-23): decisions recorded from the product owner — "everything approved by the hospital
-- privacy officer" (DPO). Applied to the privacy decisions only:
--   U-08 contact information MAY be stored → kept as a note exactly as written (never parsed as a phone number),
--        shown only on the appointment page; never in lists, exports or notifications.
--   U-09 payment classification MAY be stored.
--   Original workbooks MAY be retained → stored encrypted (AES-256-GCM, PUIMS_DATA_KEY) with the import batch,
--        Chief RT only, download requires step-up and is audited; erased when a staged batch is discarded.
-- Also: an optional hospital logo on the PFT template (PNG/JPEG only, ≤ 512 KB, versioned with the template).
-- Decisions needing hospital IT or clinical governance (U-01, U-03, U-04, U-05, U-06, U-10 content, U-18, U-19)
-- are NOT changed by this migration.

ALTER TABLE diagnostic_appointment DROP CONSTRAINT diag_payment_u09;
ALTER TABLE diagnostic_appointment ADD COLUMN contact_note text CHECK (length(contact_note) <= 300);

ALTER TABLE import_batch
  ADD COLUMN original_enc bytea,
  ADD COLUMN original_mime text CHECK (original_mime IS NULL OR original_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

ALTER TABLE pft_template
  ADD COLUMN logo bytea CHECK (logo IS NULL OR octet_length(logo) <= 524288),
  ADD COLUMN logo_mime text CHECK (logo_mime IS NULL OR logo_mime IN ('image/png', 'image/jpeg')),
  ADD CONSTRAINT pft_template_logo_chk CHECK ((logo IS NULL) = (logo_mime IS NULL));

-- Never copy binary files (logo, encrypted workbook) into the audit log; record their size instead.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  redact text[] := ARRAY['password_hash', 'totp_secret_enc', 'token_hash', 'key_enc', 'original_enc', 'logo'];
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

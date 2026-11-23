-- 0001: identity, sessions, devices, settings, append-only audit.
-- Runs as puims_owner. See docs/DATA_DICTIONARY.md for column meanings.

-- ---------------------------------------------------------------- request context
-- The app sets these per transaction with set_config(..., true) (transaction-local):
--   app.staff_id, app.session_id, app.device_id, app.context ('auth' for login/activation flows)

CREATE FUNCTION app_staff_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.staff_id', true), '')::uuid
$$;

CREATE FUNCTION app_session_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.session_id', true), '')::uuid
$$;

CREATE FUNCTION app_device_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.device_id', true), '')::uuid
$$;

CREATE FUNCTION app_auth_context() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.context', true), '') = 'auth'
$$;

-- ---------------------------------------------------------------- staff

CREATE TABLE staff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  display_name    text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  role            text NOT NULL CHECK (role IN ('CHIEF_RT_ADMIN', 'RESPIRATORY_THERAPIST')),
  status          text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'DEACTIVATED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES staff(id),
  activated_at    timestamptz,
  deactivated_at  timestamptz,
  deactivated_by  uuid REFERENCES staff(id),
  last_login_at   timestamptz,
  CHECK ((status = 'DEACTIVATED') = (deactivated_at IS NOT NULL))
);
CREATE UNIQUE INDEX staff_username_uq ON staff (lower(username));
-- Exactly one designated (non-deactivated) Chief RT administrator.
CREATE UNIQUE INDEX staff_single_chief_uq ON staff ((true)) WHERE role = 'CHIEF_RT_ADMIN' AND status <> 'DEACTIVATED';

-- ---------------------------------------------------------------- devices & sessions

CREATE TABLE device (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label               text NOT NULL CHECK (length(label) <= 120),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  revoked_at          timestamptz,
  revoked_by          uuid REFERENCES staff(id),
  revoked_reason      text,
  -- ADR-0003: no offline PHI on any device until a platform passes review (M7).
  offline_phi_allowed boolean NOT NULL DEFAULT false CHECK (offline_phi_allowed = false),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE TABLE auth_credential (
  staff_id            uuid PRIMARY KEY REFERENCES staff(id),
  password_hash       text,           -- Argon2id PHC string
  totp_secret_enc     text,           -- AES-256-GCM, key from PUIMS_DATA_KEY (never stored in DB)
  totp_enabled_at     timestamptz,
  totp_last_step      bigint,         -- replay protection
  failed_attempts     integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  password_changed_at timestamptz
);

CREATE TABLE auth_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id),
  purpose     text NOT NULL CHECK (purpose IN ('ACTIVATE', 'RESET')),
  token_hash  text NOT NULL UNIQUE,  -- SHA-256 of the one-time token; the token itself is never stored
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES staff(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_token_staff_idx ON auth_token (staff_id);

CREATE TABLE auth_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          text NOT NULL UNIQUE,  -- SHA-256 of the cookie token
  staff_id            uuid NOT NULL REFERENCES staff(id),
  device_id           uuid NOT NULL REFERENCES device(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  mfa_verified_at     timestamptz,          -- NULL = password ok, second factor pending
  reauth_at           timestamptz,          -- last step-up re-authentication
  mfa_failures        integer NOT NULL DEFAULT 0 CHECK (mfa_failures >= 0),
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  inet,
  user_agent          text CHECK (length(user_agent) <= 400)
);
CREATE INDEX auth_session_staff_idx ON auth_session (staff_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_session_device_idx ON auth_session (device_id) WHERE revoked_at IS NULL;

-- Active, fully-authenticated staff for the current request, or NULL.
-- Verifies the SESSION too, so a revoked/expired session cannot act even if app code forgets to check.
CREATE FUNCTION app_active_staff_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id
  FROM staff s
  JOIN auth_session x ON x.staff_id = s.id
  JOIN device d ON d.id = x.device_id
  WHERE s.id = app_staff_id()
    AND x.id = app_session_id()
    AND s.status = 'ACTIVE'
    AND d.status = 'ACTIVE'
    AND x.revoked_at IS NULL
    AND x.mfa_verified_at IS NOT NULL
    AND x.idle_expires_at > now()
    AND x.absolute_expires_at > now()
$$;

CREATE FUNCTION app_is_chief() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM staff WHERE id = app_active_staff_id() AND role = 'CHIEF_RT_ADMIN')
$$;

-- ---------------------------------------------------------------- settings

CREATE TABLE setting (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES staff(id),
  CONSTRAINT setting_value_valid CHECK (
    CASE key
      WHEN 'tubing.interval_days' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 1 AND 60 AND (value #>> '{}')::numeric % 1 = 0
      WHEN 'tubing.upcoming_window_hours' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 0 AND 336
      WHEN 'session.idle_minutes' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 2 AND 120 AND (value #>> '{}')::numeric % 1 = 0
      WHEN 'session.absolute_hours' THEN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN 1 AND 24 AND (value #>> '{}')::numeric % 1 = 0
      ELSE false
    END
  )
);

INSERT INTO setting (key, value, description) VALUES
  ('tubing.interval_days', '7', 'Chamfecof replacement interval in calendar days (policy-pending, U-04)'),
  ('tubing.upcoming_window_hours', '48', 'Hours before due at which tubing is flagged upcoming (policy-pending, U-04)'),
  ('session.idle_minutes', '15', 'Sign-out after this many minutes without activity (U-14)'),
  ('session.absolute_hours', '12', 'Maximum session length regardless of activity');

-- ---------------------------------------------------------------- audit (append-only)

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id     uuid,
  session_id   uuid,
  device_id    uuid,
  action       text NOT NULL CHECK (length(action) <= 80),
  table_name   text,
  record_id    text,
  before_data  jsonb,
  after_data   jsonb,
  detail       jsonb
);
CREATE INDEX audit_log_time_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id);

-- Actor, session, device and time are taken from the request context — callers cannot forge them.
CREATE FUNCTION audit_log_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.occurred_at := clock_timestamp();
  NEW.actor_id := app_staff_id();
  NEW.session_id := app_session_id();
  NEW.device_id := app_device_id();
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_stamp BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_stamp();

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Generic row-change audit. Secrets are redacted before they reach the log.
CREATE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  redact text[] := ARRAY['password_hash', 'totp_secret_enc', 'token_hash'];
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

CREATE TRIGGER audit_staff AFTER INSERT OR UPDATE OR DELETE ON staff FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_credential AFTER INSERT OR UPDATE OR DELETE ON auth_credential FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_token AFTER INSERT OR UPDATE OR DELETE ON auth_token FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_device AFTER INSERT OR UPDATE OF status, revoked_at, revoked_reason OR DELETE ON device FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_setting AFTER INSERT OR UPDATE OR DELETE ON setting FOR EACH ROW EXECUTE FUNCTION audit_row_change();
-- Sessions: only creation and revocation are audited (not every last_seen bump).
CREATE TRIGGER audit_session AFTER INSERT OR UPDATE OF revoked_at, mfa_verified_at ON auth_session FOR EACH ROW EXECUTE FUNCTION audit_row_change();

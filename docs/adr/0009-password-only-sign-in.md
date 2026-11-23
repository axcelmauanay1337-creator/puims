# ADR-0009: Password-only sign-in (authenticator removed)

Status: Accepted 2026-11-23 — amends ADR-0006. Decided by the product owner.

## Decision

- The authenticator-app (TOTP) second factor is removed from sign-in, account activation and step-up re-authentication.
- Sign-in: username + password creates the full session directly (`auth_session.mfa_verified_at` is set at creation; the column name is kept for compatibility with existing RLS functions).
- Step-up ("Confirm it's you") asks for the password again; the 5-minute window is unchanged.
- Activation and access reset: the RT only sets a password. Any old TOTP secret is cleared when a password is set.
- Unchanged: Argon2id, ≥ 12-character passwords, lockout after 10 failures (15 min), rate limits, generic errors, 15 min idle / 12 h absolute sessions, device revocation, audit.
- The `/login/verify` route now redirects to `/login`. `src/lib/auth/totp.ts`, `dev:totp` and the `qrcode` dependency are removed.

## Consequences

- A stolen or shared password alone now gives access to patient data (threat T-01/T-20). Hospital IT and the DPO must accept this before real data, or a second factor must be restored.
- The `totp_*` columns in `auth_credential` stay (always NULL for new passwords) so restoring a second factor later needs no data migration.

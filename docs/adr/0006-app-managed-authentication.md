# ADR-0006: Accounts managed inside PUIMS (password + TOTP, server-side sessions)

Status: Accepted (M2) — supersedes ADR-0005 (demo session). Decision U-02 answered by the product owner: "build accounts managed inside PUIMS".

## Decision

- **Accounts**: individual `staff` rows; exactly one non-deactivated Chief RT (unique partial index). The Chief RT is provisioned by an operator CLI (`npm run admin:bootstrap`); RT accounts are created by the Chief RT in the UI. Users never choose a role — the server hard-codes `RESPIRATORY_THERAPIST` for every account the Chief creates, and the database RLS policy rejects anything else.
- **Provisioning**: one-time activation link (256-bit random token, SHA-256 stored, 72 h, single use). The token travels in the URL **fragment** (`/activate#…`) so it never reaches server or proxy logs; the page reads it and scrubs it from the address bar.
- **Passwords**: Argon2id (m = 19 MiB, t = 2, p = 1 — OWASP baseline) via `@node-rs/argon2`. Policy per NIST SP 800-63B: ≥ 12 characters, no composition rules, common/contextual passwords blocked, no forced rotation.
- **Second factor (mandatory)**: TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step), implemented on `node:crypto` and verified against the RFC vectors. Secrets are encrypted at rest with AES-256-GCM under `PUIMS_DATA_KEY` (outside the DB and outside DB backups). Replay protection: the last accepted step is stored per user.
- **Sessions**: opaque 256-bit token in an `HttpOnly; Secure; SameSite=Strict; __Host-` cookie; only its SHA-256 is stored. Validated against the database on every request, so logout, deactivation, access reset and device revocation take effect immediately. Idle timeout (default 15 min, setting `session.idle_minutes`) and absolute lifetime (default 12 h).
- **Lockout**: 10 consecutive failures → 15 min lock (password, TOTP and re-auth failures all count). Per-IP and per-username rate limits on sign-in. All user-facing messages are generic.
- **Step-up re-authentication**: password + fresh TOTP within the last 5 minutes for invite, reset, deactivate, device revocation and settings changes.
- **Devices**: a device is a browser profile identified by an HttpOnly cookie. Revoking it ends its sessions and blocks future sign-ins from it. (Strong, approved device binding is Milestone 7.)
- **Recovery**: no self-service reset (no e-mail/SMS dependency on a hospital network). The Chief RT resets access; that clears password and authenticator and issues a new activation link. Losing the Chief RT's own authenticator requires the operator CLI procedure in `docs/SETUP.md`.

## Consequences

- No dependency on hospital AD/SSO; can be swapped for OIDC later behind `src/server/auth/service.ts` (sessions, RLS context and audit stay the same).
- TOTP replay protection means automated tests must use a fresh 30 s window per account (tests coordinate this).
- `PUIMS_DATA_KEY` loss forces every user to re-enrol their authenticator (passwords unaffected).

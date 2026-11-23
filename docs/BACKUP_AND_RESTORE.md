# PUIMS — Backup and Restore Runbook

## What is backed up

| Item                | How                                                                           | Notes                                                                  |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| PostgreSQL database | `scripts/backup.sh` — `pg_dump -Fc` streamed into `age` public-key encryption | Plaintext never touches disk. Manifest records SHA-256 and row counts. |
| `PUIMS_DATA_KEY`    | Separately, in the hospital's secret store / sealed envelope                  | **Never** in the same place as DB backups (it decrypts TOTP secrets).  |
| age private key     | Offline (e.g. two sealed copies held by IT + Chief RT's manager)              | The backup server holds only the public key.                           |
| App release         | Git tag + build artifact                                                      | Re-deployable from source.                                             |

## Schedule (proposal — confirm with hospital IT, U-12)

- Nightly full encrypted dump, retained 35 days; monthly retained 12 months.
- Copy to a second location (off-host; hospital-approved).
- WAL archiving / point-in-time recovery when the hospital's PostgreSQL platform supports it (target RPO ≤ 15 min, RTO ≤ 4 h).

## Backup

```bash
export MIGRATION_DATABASE_URL=postgres://puims_owner:...@db-host:5432/puims
export PUIMS_BACKUP_AGE_RECIPIENT=age1...   # public key only
export PUIMS_BACKUP_DIR=/srv/puims-backups
./scripts/backup.sh
```

## Restore drill (run at least quarterly, and after every schema migration)

```bash
./scripts/restore-drill.sh /srv/puims-backups/puims-<stamp>.dump.age /secure/media/age-identity.txt
```

The drill verifies the checksum, decrypts and restores into a **scratch** database, compares every row count in the manifest, confirms row-level security is enabled on every table and the audit-immutability triggers exist, then drops the scratch database.

### Drill evidence

| Date (UTC) | Environment                                  | Result                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-22 | Local dev, synthetic data (PostgreSQL 16.15) | **PASSED** — checksum ✓; staff 8, patient 48, neb_administration 1190, diagnostic_appointment 919, vent_encounter 16, tubing_event 16, audit_log 4678, schema_migrations 3 all matched; RLS on all tables ✓; audit triggers ✓; scratch DB dropped ✓. |

## Real restore (disaster recovery)

1. Declare the incident; stop the app (`systemctl stop puims` or equivalent) so no writes land on a damaged DB.
2. Provision a fresh PostgreSQL 16 and run `db/bootstrap.sql` (creates roles and `btree_gist`).
3. Restore the latest good backup as in the drill, but into the production database name.
4. Restore `PUIMS_DATA_KEY` from the secret store to the app host.
5. Start the app; verify `/api/health`, sign in as the Chief RT, check the audit log for the last expected entries.
6. Record the recovery point (data after the backup time is lost unless PITR exists) and inform clinical leadership so paper downtime records can be reconciled.

## Security notes

- The owner role (`puims_owner`) can disable triggers; its credentials are break-glass only and not present on the app server.
- Restored databases contain PHI: drill only in approved environments; scratch DBs are always dropped.

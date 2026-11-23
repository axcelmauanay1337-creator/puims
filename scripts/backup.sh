#!/usr/bin/env bash
# Encrypted logical backup of the PUIMS database.
#
#   MIGRATION_DATABASE_URL   owner connection (pg_dump must see every row; the owner is not subject to RLS)
#   PUIMS_BACKUP_AGE_RECIPIENT  age PUBLIC key (age1...). The private key is kept OFFLINE, not on this server.
#   PUIMS_BACKUP_DIR         destination directory (default ./backups)
#
# Output: puims-<UTC timestamp>.dump.age  +  .manifest (row counts, sizes, SHA-256 of the encrypted file).
# Plaintext never touches disk: pg_dump streams straight into age.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?}" "${PUIMS_BACKUP_AGE_RECIPIENT:?age public key required}"
dir="${PUIMS_BACKUP_DIR:-./backups}"
mkdir -p "$dir" && chmod 700 "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/puims-$stamp.dump.age"
umask 077
pg_dump --format=custom --no-owner --no-privileges --dbname="$MIGRATION_DATABASE_URL" | age --encrypt -r "$PUIMS_BACKUP_AGE_RECIPIENT" -o "$out"
{
  echo "file=$(basename "$out")"
  echo "created_utc=$stamp"
  echo "sha256=$(sha256sum "$out" | cut -d' ' -f1)"
  echo "bytes=$(stat -c %s "$out")"
  psql "$MIGRATION_DATABASE_URL" -AtX -c "SELECT 'rows.' || t || '=' || n FROM (VALUES
    ('staff',(SELECT count(*) FROM staff)),('patient',(SELECT count(*) FROM patient)),
    ('neb_administration',(SELECT count(*) FROM neb_administration)),('diagnostic_appointment',(SELECT count(*) FROM diagnostic_appointment)),
    ('vent_encounter',(SELECT count(*) FROM vent_encounter)),('tubing_event',(SELECT count(*) FROM tubing_event)),
    ('audit_log',(SELECT count(*) FROM audit_log)),('schema_migrations',(SELECT count(*) FROM schema_migrations))) v(t,n)"
} > "$out.manifest"
echo "Backup written: $out"

#!/usr/bin/env bash
# Restore drill: proves a backup can be decrypted and restored, then checks it.
# Restores into a SCRATCH database (never the live one), verifies, and drops it.
#
#   scripts/restore-drill.sh <backup.dump.age> <age-identity-file>
#   Requires local superuser access (sudo -u postgres) to create/drop the scratch DB.
set -euo pipefail
backup="$1"; identity="$2"; manifest="$backup.manifest"
scratch="puims_restore_drill_$(date -u +%s)"
test -f "$manifest" || { echo "missing manifest $manifest"; exit 1; }
expected_sha=$(grep '^sha256=' "$manifest" | cut -d= -f2)
[ "$(sha256sum "$backup" | cut -d' ' -f1)" = "$expected_sha" ] || { echo "FAIL: checksum mismatch"; exit 1; }
echo "✓ checksum matches manifest"
sudo -u postgres createdb -O puims_owner "$scratch"
sudo -u postgres psql -qX -d "$scratch" -c "CREATE EXTENSION IF NOT EXISTS btree_gist; ALTER SCHEMA public OWNER TO puims_owner;"
trap 'sudo -u postgres dropdb --if-exists "$scratch"' EXIT
# (The TOC list holds object names only, no row data — readable by the postgres OS user.)
# Extension objects are pre-created above by the superuser; restore everything else as the owner role.
# Two streaming passes (TOC list, then restore) so no plaintext dump is written to disk.
list=$(mktemp); chmod 644 "$list"; trap 'rm -f "$list"; sudo -u postgres dropdb --if-exists "$scratch"' EXIT
# pg_restore --list stops reading after the TOC, so age may exit 141 (SIGPIPE) here; the full pass below re-reads everything.
{ age --decrypt -i "$identity" "$backup" || [ $? -eq 141 ]; } | pg_restore --list | grep -v ' EXTENSION ' > "$list"
age --decrypt -i "$identity" "$backup" | sudo -u postgres pg_restore --no-owner --role=puims_owner --use-list="$list" --dbname="$scratch" --exit-on-error
echo "✓ decrypted and restored into $scratch"
fail=0
while IFS='=' read -r key want; do
  [[ "$key" == rows.* ]] || continue
  t="${key#rows.}"
  got=$(sudo -u postgres psql -AtX -d "$scratch" -c "SELECT count(*) FROM $t")
  if [ "$got" = "$want" ]; then echo "✓ $t: $got rows"; else echo "✗ $t: expected $want, got $got"; fail=1; fi
done < "$manifest"
rls=$(sudo -u postgres psql -AtX -d "$scratch" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'schema_migrations' AND NOT c.relrowsecurity")
[ "$rls" = "0" ] && echo "✓ row-level security enabled on every table" || { echo "✗ $rls table(s) without RLS"; fail=1; }
trg=$(sudo -u postgres psql -AtX -d "$scratch" -c "SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_log_no_update','audit_log_no_truncate','audit_log_stamp')")
[ "$trg" = "3" ] && echo "✓ audit immutability triggers present" || { echo "✗ audit triggers missing"; fail=1; }
[ "$fail" = 0 ] && echo "RESTORE DRILL PASSED" || { echo "RESTORE DRILL FAILED"; exit 1; }

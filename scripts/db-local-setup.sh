#!/usr/bin/env bash
# Local development only: creates roles + the dev and test databases on a local PostgreSQL
# using the passwords from .env.local. Requires local superuser access (sudo -u postgres).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local; set +a
: "${PUIMS_DB_OWNER_PASSWORD:?set in .env.local}" "${PUIMS_DB_APP_PASSWORD:?set in .env.local}"
for db in puims puims_test; do
  sudo -u postgres psql -q -v owner_password="$PUIMS_DB_OWNER_PASSWORD" -v app_password="$PUIMS_DB_APP_PASSWORD" -v db_name="$db" -f db/bootstrap.sql
done
echo "Roles and databases ready. Next: npm run db:migrate && npm run db:seed"

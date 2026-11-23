#!/usr/bin/env bash
# Local development only: DROPS and recreates the local dev and test databases, then migrates.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local; set +a
case "${PUIMS_DEPLOYMENT_PROFILE:-development}" in development|uat) ;; *) echo "Refusing: profile is ${PUIMS_DEPLOYMENT_PROFILE}"; exit 1;; esac
for db in puims puims_test; do sudo -u postgres dropdb --if-exists "$db"; done
./scripts/db-local-setup.sh
node scripts/migrate.mjs
MIGRATION_DATABASE_URL="$TEST_MIGRATION_DATABASE_URL" node scripts/migrate.mjs

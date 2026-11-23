#!/bin/sh
# Runs once, on first start of an empty volume: creates the PUIMS roles and the dev + test databases.
set -e
for db in puims puims_test; do
  psql -v ON_ERROR_STOP=1 -U postgres -v owner_password="$PUIMS_DB_OWNER_PASSWORD" -v app_password="$PUIMS_DB_APP_PASSWORD" -v db_name="$db" -f /puims/bootstrap.sql
done

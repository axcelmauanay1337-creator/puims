#!/bin/sh
# First start of an empty database volume: create the PUIMS roles and the `puims` database.
set -e
psql -v ON_ERROR_STOP=1 -U postgres -v owner_password="$PUIMS_DB_OWNER_PASSWORD" -v app_password="$PUIMS_DB_APP_PASSWORD" -v db_name=puims -f /puims/bootstrap.sql

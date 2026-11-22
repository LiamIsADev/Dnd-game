#!/usr/bin/env bash
# Runs the Supabase migrations and the security tests against a throwaway
# local PostgreSQL database. Needs psql and a running server; set PGHOST,
# PGPORT and PGUSER if it isn't the default.
#   bash tests/db/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=dndgame_test
psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB"
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1"; }
run tests/db/supabase-shim.sql
for f in supabase/migrations/*.sql; do run "$f"; done
# Run them all a second time: they must be safe to re-run.
for f in supabase/migrations/*.sql; do run "$f"; done
run tests/db/security.test.sql
echo "Database tests passed."

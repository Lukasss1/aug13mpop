#!/usr/bin/env bash
# pos-live-smoke.sh — LIVE proof of the POS sync layer on a local Postgres.
# Applies migration_pos_sync.sql VERBATIM (after a stub prelude that provides
# only what Supabase itself provides) and executes the scenario suite. A
# clean exit + the final ALL SCENARIOS PASSED row is the pass.
#
# Machine-side check (needs a local postgres); NOT part of `npm run verify`.
#   ./scripts/pos-live-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB="possmoke_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 \
  -f scripts/pos-live-smoke-prelude.sql \
  -f supabase/migration_pos_sync.sql \
  -f supabase/migration_pos_catalog.sql \
  -f scripts/pos-live-smoke-scenarios.sql

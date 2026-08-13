#!/usr/bin/env bash
# ============================================================================
#  migration-baseline.test.sh — EXECUTABLE migration + behaviour proof
#  (WP01.1/02.1/04R patch pack; spec §14 step 6 and §18)
#
#  Boots a throwaway PostgreSQL cluster, shims the Supabase surface the SQL
#  actually touches (auth.uid/jwt, storage.buckets/objects, the three API
#  roles), applies schema.FRESH-INSTALL-ONLY.sql plus EVERY migration in launch.sh order against
#  that fresh baseline, and then runs scripts/migration-baseline.assert.sql:
#  structural assertions (columns, constraints), PRIVILEGE assertions
#  (set role anon → RPCs must be denied), and BEHAVIOURAL assertions
#  (idempotency replay, hash conflict, rate-limit reservation, two-phase
#  media attachment, cleanup state machine). This is the test class the
#  original WP-04 defect proved regex suites cannot replace: the collision
#  with the legacy media_assets table was invisible to every static check
#  and is caught here on the first apply.
#
#  Run: npm run test:baseline      (safe to re-run; cluster is recreated)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
# initdb/postgres refuse to run as root — drop to the postgres system user.
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/migration-baseline.test.sh"
fi
PGDATA="/tmp/milkpop-baseline-pg"
PGSOCK="/tmp/milkpop-baseline-sock"
export PGHOST="$PGSOCK"
DB=milkpop_baseline
PSQL="$PGBIN/psql -v ON_ERROR_STOP=1 -q -X -h $PGSOCK -d $DB"

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- 1. Fresh cluster --------------------------------------------------------
cleanup
rm -rf "$PGDATA" "$PGSOCK"; mkdir -p "$PGDATA" "$PGSOCK"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -c listen_addresses='' -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h "$PGSOCK" -U postgres -d postgres -c "create database $DB" >/dev/null

# --- 2. Supabase surface shim (exactly what the SQL references) --------------
# R4.10 Increment 4: the Supabase privilege/surface shim is no longer written
# out here. Every database harness executes ONE shared file so they all start
# from the same posture as production — see scripts/lib/supabase-local-privileges.sql
# for why that matters (a harness that starts MORE locked down than production
# can prove a REVOKE worked but can never see a relation left readable).
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

# --- 3. Apply the exact fresh baseline + every migration in manifest order ----
apply() {
  local f="$1"
  if ! "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$f" >/tmp/baseline-apply.log 2>&1; then
    echo "✖ MIGRATION FAILED against fresh baseline: $f"
    tail -12 /tmp/baseline-apply.log | sed 's/^/    /'
    exit 1
  fi
  echo "✔ applied $f"
}

# The authoritative manifest is the single source of both fresh-baseline and
# migration order. T13.3.28 deliberately includes seed.sql here: the real
# production failure proved that schema/seed compatibility is deployment
# correctness, not merely content. Mirror launch.sh by applying schema + seed
# in one transaction.
# shellcheck source=launch/migration-manifest.sh
source launch/migration-manifest.sh
if [ "${#MP_FRESH_ONLY[@]}" -ne 2 ] || \
   [ "${MP_FRESH_ONLY[0]}" != "supabase/schema.FRESH-INSTALL-ONLY.sql" ] || \
   [ "${MP_FRESH_ONLY[1]}" != "supabase/seed.sql" ]; then
  echo "✖ fresh baseline manifest must be exactly schema + seed"; exit 1
fi
if ! "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -1 -h "$PGSOCK" -U postgres -d "$DB" \
    -f "${MP_FRESH_ONLY[0]}" -f "${MP_FRESH_ONLY[1]}" >/tmp/baseline-apply.log 2>&1; then
  echo "✖ ATOMIC FRESH BASELINE FAILED"
  tail -12 /tmp/baseline-apply.log | sed 's/^/    /'
  exit 1
fi
echo "✔ applied atomic fresh baseline: ${MP_FRESH_ONLY[*]}"
MIGRATIONS=( "${MP_MIGRATIONS[@]}" )
if [ "${#MIGRATIONS[@]}" -lt 10 ]; then echo "✖ migration manifest parse failed"; exit 1; fi
for m in "${MIGRATIONS[@]}"; do apply "$m"; done

# --- 4. Structural, privilege and behavioural assertions ---------------------
if ! "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f scripts/migration-baseline.assert.sql; then
  echo "✖ BASELINE ASSERTIONS FAILED"
  exit 1
fi
echo ""
echo "MIGRATION BASELINE — schema + production seed + ${#MIGRATIONS[@]} migrations applied clean; all assertions passed"

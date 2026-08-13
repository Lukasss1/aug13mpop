#!/usr/bin/env bash
# ============================================================================
#  retention.test.sh — WS9 EXECUTABLE RETENTION PROOF (R4.5.1)
#
#  Boots a throwaway PostgreSQL cluster with the same Supabase-surface shim as
#  the baseline suite, applies schema.FRESH-INSTALL-ONLY.sql plus EVERY migration in manifest
#  order (the chain now ends in migration_stage3_ws9_retention.sql), and runs
#  scripts/retention.assert.sql: the behavioural proof that
#
#    • a REFERENCED CV is never claimed and never deleted (claim-time
#      re-check; the HOSTING.md carry-over blocker);
#    • deletion is idempotent, logged in retention_runs, and queue-driven
#      (confirmed Storage deletes only — no direct object removal);
#    • the contact / franchise / declined-application sweeps and the orphan
#      sweep delete exactly what the retention table says and nothing else;
#    • none of it is reachable from the anon/authenticated roles.
#
#  This suite passing on the deployed chain is what the
#  RETENTION_INVARIANT_TESTS_PASSED=true marker attests (env validator R8) —
#  MEDIA_CLEANUP_ENABLED must stay off until it has.
#
#  Run: npm run test:retention      (safe to re-run; cluster is recreated)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
# initdb/postgres refuse to run as root — drop to the postgres system user.
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/retention.test.sh"
fi
PGDATA="/tmp/milkpop-retention-pg"
PGSOCK="/tmp/milkpop-retention-sock"
export PGHOST="$PGSOCK"
DB=milkpop_retention

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- 1. Fresh cluster --------------------------------------------------------
cleanup
rm -rf "$PGDATA" "$PGSOCK"; mkdir -p "$PGDATA" "$PGSOCK"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -c listen_addresses='' -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h "$PGSOCK" -U postgres -d postgres -c "create database $DB" >/dev/null

# --- 2. Supabase surface shim (identical to the baseline suite) --------------
# R4.10 Increment 4: the Supabase privilege/surface shim is no longer written
# out here. Every database harness executes ONE shared file so they all start
# from the same posture as production — see scripts/lib/supabase-local-privileges.sql
# for why that matters (a harness that starts MORE locked down than production
# can prove a REVOKE worked but can never see a relation left readable).
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

# --- 3. Apply schema.FRESH-INSTALL-ONLY.sql + the full manifest chain ---------------------------
apply() {
  local f="$1"
  if ! "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$f" >/tmp/retention-apply.log 2>&1; then
    echo "✖ MIGRATION FAILED against fresh baseline: $f"
    tail -12 /tmp/retention-apply.log | sed 's/^/    /'
    exit 1
  fi
}
apply supabase/schema.FRESH-INSTALL-ONLY.sql
# shellcheck source=launch/migration-manifest.sh
source launch/migration-manifest.sh
if [ "${#MP_MIGRATIONS[@]}" -lt 10 ]; then echo "✖ migration manifest parse failed"; exit 1; fi
for m in "${MP_MIGRATIONS[@]}"; do apply "$m"; done
echo "✔ schema + ${#MP_MIGRATIONS[@]} migrations applied (chain ends: ${MP_MIGRATIONS[${#MP_MIGRATIONS[@]}-1]})"

# --- 4. The behavioural retention assertions ---------------------------------
if ! "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f scripts/retention.assert.sql; then
  echo "✖ WS9 RETENTION ASSERTIONS FAILED"
  exit 1
fi
echo ""
echo "WS9 RETENTION — claim-time invariant, sweeps, orphan queue, logging and privileges all proven"

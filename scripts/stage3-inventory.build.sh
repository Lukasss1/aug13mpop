#!/usr/bin/env bash
# ============================================================================
# stage3-inventory.build.sh — Workstream 1: current-schema inventory.
#
# Boots a disposable PostgreSQL 17 cluster, applies the FULL effective
# migration chain (schema.FRESH-INSTALL-ONLY.sql + manifest order — the same application model
# as migration-baseline.test.sh), then introspects the LIVE catalogs with
# scripts/stage3-schema-snapshot.mjs. The inventory therefore describes the
# effective final state, never a per-file scan.
#
# Outputs:
#   artifacts/stage3-schema-inventory.json   canonical machine-readable state
#   docs/STAGE3-SCHEMA-INVENTORY.md          human summary + audit findings
#
# The SAME snapshot engine is reused by Workstream 14 (baseline equivalence):
# two databases → two snapshots → canonical diff.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/stage3-inventory.build.sh"
fi

PGDATA="/tmp/milkpop-inv-pg"
PGPORT=54332
DB=milkpop_inventory

PSQL() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" "$@"; }
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
rm -rf "$PGDATA"; mkdir -p "$PGDATA" artifacts
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='127.0.0.1' -c port=$PGPORT -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database $DB" >/dev/null

# Supabase surface shim — mirrors upgrade-replay.test.sh §1 / baseline §2.
# R4.10 Increment 4: shim body replaced by the ONE shared file so every
# database harness starts from the same posture as production.
PSQL < "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

# Full effective chain: schema.FRESH-INSTALL-ONLY.sql then the manifest order.
# shellcheck source=/dev/null
source launch/migration-manifest.sh
echo "applying schema.FRESH-INSTALL-ONLY.sql + ${#MP_MIGRATIONS[@]} migrations…"
PSQL -f supabase/schema.FRESH-INSTALL-ONLY.sql >/dev/null
for f in "${MP_MIGRATIONS[@]}"; do PSQL -f "$f" >/dev/null; done
echo "chain applied"

# Snapshot + summarise.
PGHOST=127.0.0.1 PGPORT=$PGPORT PGDB=$DB PGBINDIR="$PGBIN" \
  node scripts/stage3-schema-snapshot.mjs artifacts/stage3-schema-inventory.json
PGHOST=127.0.0.1 PGPORT=$PGPORT PGDB=$DB PGBINDIR="$PGBIN" \
  node scripts/stage3-inventory-report.mjs \
    artifacts/stage3-schema-inventory.json docs/STAGE3-SCHEMA-INVENTORY.md
echo "inventory written: artifacts/stage3-schema-inventory.json + docs/STAGE3-SCHEMA-INVENTORY.md"

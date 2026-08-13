#!/usr/bin/env bash
# pos-local-e2e/run.sh — execute the UNMODIFIED pos-e2e-live.mjs against a
# LOCAL full stack: Postgres 17 + PostgREST + the three REAL Edge Functions
# under Deno + a mini-gateway. This is the strongest proof available without
# production credentials: the exact wire, the exact function code.
#   Requires: postgres running, postgrest + deno + node on PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PGRST_JWT_SECRET='local-e2e-secret-must-be-32-bytes!!'
DB="pose2e_$$"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

createdb "$DB"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 \
  -f scripts/pos-local-e2e/prelude-rest.sql \
  -f supabase/migration_pos_sync.sql \
  -f supabase/migration_pos_catalog.sql

cat > /tmp/pgrst-$$.conf <<CONF
db-uri = "postgres://authenticator:e2e-local-pw@127.0.0.1:5432/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$PGRST_JWT_SECRET"
server-port = 3000
CONF
postgrest /tmp/pgrst-$$.conf >/tmp/pgrst-$$.log 2>&1 & PIDS+=($!)

SERVICE_JWT=$(node scripts/pos-local-e2e/mint.mjs service_role)
ANON_JWT=$(node scripts/pos-local-e2e/mint.mjs anon)
for fn in pos-pair:9101 pos-ingest:9102 pos-catalog:9103; do
  name="${fn%%:*}"; port="${fn##*:}"
  FN_PORT="$port" FN_ENTRY="$(pwd)/supabase/functions/$name/index.ts" \
  SUPABASE_URL="http://127.0.0.1:54321" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_JWT" \
  deno run --allow-net --allow-env --allow-read scripts/pos-local-e2e/bootstrap.ts \
    >/tmp/fn-$name-$$.log 2>&1 & PIDS+=($!)
done
node scripts/pos-local-e2e/gateway.mjs >/tmp/gateway-$$.log 2>&1 & PIDS+=($!)
sleep 3

SUPABASE_URL="http://127.0.0.1:54321" SUPABASE_ANON_KEY="$ANON_JWT" \
OWNER_EMAIL="owner@local" OWNER_PW="local" \
node scripts/pos-e2e-live.mjs

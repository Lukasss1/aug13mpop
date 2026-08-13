#!/usr/bin/env bash
# ============================================================================
# stage3-ws6g-upgrade.test.sh — the Round-9d → Round-9e UPGRADE PATH
# ============================================================================
# Round-9e audit finding 1: the gift-card reconciliation in WS6g was written as
# TWO statements. An ACTIVE store whose ONLY configured method was gift_card
# would, after the first statement, hold payment_methods = [] while still
# ACTIVE — and `stores_setup_coherent` is a plain CHECK, evaluated per row as
# that statement runs, NOT at end of transaction. The migration therefore
# failed instead of demoting the store to DRAFT.
#
# The matrix could never catch this: it asserts the POST-migration state of a
# database built by applying the whole chain at once, where no such store
# exists. Only a genuine upgrade from the PREVIOUS chain state can.
#
# This test builds the database at the Round-9d chain (everything BEFORE
# WS6g), creates the exact pre-state the field could hold — including the
# gift-card-only ACTIVE store — then applies WS6g alone and asserts the
# outcome the report claims.
#
#   Run: npm run test:ws6g-upgrade
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/stage3-ws6g-upgrade.test.sh"
fi
PGDATA="/tmp/milkpop-ws6g-pg"
PGSOCK="/tmp/milkpop-ws6g-sock"
export PGHOST="$PGSOCK"
DB=milkpop_ws6g
PSQL="$PGBIN/psql -v ON_ERROR_STOP=1 -q -X -h $PGSOCK -U postgres -d $DB"
Q() { "$PGBIN/psql" -tA -X -h "$PGSOCK" -U postgres -d "$DB" -c "$1"; }

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASS=0; FAIL=0
chk() { # $1 label, $2 got, $3 want
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✔ $1";
  else FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want: $3"; fi
}

cleanup
rm -rf "$PGDATA" "$PGSOCK"; mkdir -p "$PGDATA" "$PGSOCK"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -c listen_addresses='' -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h "$PGSOCK" -U postgres -d postgres -c "create database $DB" >/dev/null

# --- Supabase surface shim (same as the baseline harness) --------------------
# R4.10 Increment 4: the Supabase privilege/surface shim is no longer written
# out here. Every database harness executes ONE shared file so they all start
# from the same posture as production — see scripts/lib/supabase-local-privileges.sql
# for why that matters (a harness that starts MORE locked down than production
# can prove a REVOKE worked but can never see a relation left readable).
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

WS6G="supabase/migration_stage3_ws6g_operational_closure.sql"

# --- 1. Build the database at the ROUND-9d chain (everything before WS6G) ----
echo "— building the pre-upgrade (Round-9d) database —"
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f supabase/schema.FRESH-INSTALL-ONLY.sql >/dev/null
# shellcheck source=launch/migration-manifest.sh
source launch/migration-manifest.sh
COUNT=0
for m in "${MP_MIGRATIONS[@]}"; do
  [ "$m" = "$WS6G" ] && break
  "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$m" >/dev/null
  COUNT=$((COUNT+1))
done
echo "  applied $COUNT migrations (chain state immediately before WS6g)"
chk "the pre-state does NOT yet carry the WS6g constraint" \
    "$(Q "select count(*) from pg_constraint where conname = 'stores_payment_methods_supported'")" "0"

# --- 2. The exact pre-states the field could hold ---------------------------
$PSQL <<'PRE' >/dev/null
insert into stores (id, name, address, postcode, vat_config_confirmed_at,
                    setup_status, timezone, currency_code, payment_methods) values
  -- The blocker: ACTIVE with gift_card as its ONLY method.
  ('s_gc_only', 'Gift Card Only', '1 Upgrade Way', 'U1 1AA', now(),
   'ACTIVE', 'Europe/London', 'GBP', '["gift_card"]'::jsonb),
  -- A mixed set: must keep trading, minus gift_card.
  ('s_gc_mixed', 'Gift Card Mixed', '2 Upgrade Way', 'U2 2BB', now(),
   'ACTIVE', 'Europe/London', 'GBP', '["card","gift_card","cash"]'::jsonb),
  -- Untouched control.
  ('s_plain', 'Plain', '3 Upgrade Way', 'U3 3CC', now(),
   'ACTIVE', 'Europe/London', 'GBP', '["card"]'::jsonb),
  -- A DRAFT store carrying gift_card in a partial configuration.
  ('s_gc_draft', 'Draft With Gift', '4 Upgrade Way', 'U4 4DD', null,
   'DRAFT', null, null, '["gift_card"]'::jsonb);
PRE
chk "pre-state: the gift-card-only store is ACTIVE" \
    "$(Q "select setup_status from stores where id = 's_gc_only'")" "ACTIVE"

# --- 3. THE UPGRADE ---------------------------------------------------------
echo "— applying WS6g (the upgrade under test) —"
if "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" \
     -f "$WS6G" >/tmp/ws6g-upgrade.log 2>&1; then
  PASS=$((PASS+1)); echo "  ✔ WS6g applied cleanly over the Round-9d database"
else
  FAIL=$((FAIL+1)); echo "  ✖ WS6g FAILED to apply over the Round-9d database"
  tail -14 /tmp/ws6g-upgrade.log | sed 's/^/      /'
fi

# --- 4. The outcome the report claims ---------------------------------------
chk "gift-card-only ACTIVE store demoted to DRAFT" \
    "$(Q "select setup_status from stores where id = 's_gc_only'")" "DRAFT"
chk "…and its unusable configuration cleared" \
    "$(Q "select coalesce(payment_methods::text, 'NULL') from stores where id = 's_gc_only'")" "NULL"
chk "mixed store keeps trading with gift_card stripped" \
    "$(Q "select setup_status || '/' || payment_methods::text from stores where id = 's_gc_mixed'")" \
    'ACTIVE/["card", "cash"]'
chk "control store untouched" \
    "$(Q "select setup_status || '/' || payment_methods::text from stores where id = 's_plain'")" \
    'ACTIVE/["card"]'
chk "DRAFT store also reconciled (stays DRAFT, gift_card gone)" \
    "$(Q "select setup_status || '/' || coalesce(payment_methods::text, 'NULL') from stores where id = 's_gc_draft'")" \
    "DRAFT/NULL"
chk "no store anywhere retains gift_card" \
    "$(Q "select count(*) from stores where payment_methods ? 'gift_card'")" "0"
chk "the launch-vocabulary CHECK now exists" \
    "$(Q "select count(*) from pg_constraint where conname = 'stores_payment_methods_supported'")" "1"
chk "every surviving row satisfies stores_setup_coherent" \
    "$(Q "select count(*) from stores where setup_status = 'ACTIVE' and (payment_methods is null or jsonb_array_length(payment_methods) = 0)")" "0"

# --- 5. Re-applying the migration is a no-op (idempotence) ------------------
if "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" \
     -f "$WS6G" >/tmp/ws6g-upgrade2.log 2>&1; then
  PASS=$((PASS+1)); echo "  ✔ WS6g is idempotent (second apply clean)"
else
  FAIL=$((FAIL+1)); echo "  ✖ WS6g second apply FAILED"
  tail -8 /tmp/ws6g-upgrade2.log | sed 's/^/      /'
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✔ WS6g UPGRADE PATH — $PASS passed, 0 failed  (pre-state: $COUNT migrations)"
else
  echo "✖ WS6g UPGRADE PATH — $PASS passed, $FAIL failed"
  exit 1
fi

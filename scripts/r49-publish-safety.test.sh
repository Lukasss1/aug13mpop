#!/usr/bin/env bash
# ============================================================================
#  r49-publish-safety.test.sh — R4.10 P0-2
# ============================================================================
#  replace_collection() is a WHOLE-COLLECTION publish: step 3 of
#  migration_fix7_sensitive_collections.sql is
#      delete from <table> where <pk> <> all($1)
#  so any row absent from the payload is deleted.
#
#  R4.9 G4 pointed the anonymous menu read at menu_items_public, which contains
#  only AVAILABLE products — and the admin publisher read the same array. An
#  owner who edited one price and pressed Publish would therefore have sent a
#  snapshot with every hidden product missing, and destroyed them.
#
#  HISTORY OF THIS SUITE — an honest repoint, not a weakening.
#  As written for R4.9, §1 asserted the hazard AS CURRENT BEHAVIOUR ("a
#  partial snapshot deletes what it omits") because the only defence was
#  client-side: the Admin Panel hydrating the FULL authenticated copy. The
#  third external audit (R4.10) required the SERVER to refuse a snapshot that
#  does not match the collection, so migration_r410_publication_boundary.sql
#  made the snapshot total MANDATORY on replace_collection. The hazard call
#  from §1 is now REFUSED — this suite asserts the refusal and the hidden
#  row's survival, which is strictly stronger than documenting the loss.
#
#  This proves both halves against a real database:
#    §1 the hazard is CLOSED — a publisher sending the anonymous (filtered)
#       copy states the count it saw; the server holds more; the call is
#       refused as collection_snapshot_stale and the hidden product survives
#    §2 the fix path — the full authenticated snapshot, with its matching
#       total, still applies the edit while preserving hidden rows
#
#    Run: npm run test:r49-publish-safety
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/r49-publish-safety.test.sh"
fi
PGDATA=/tmp/milkpop-r49pub-pg; SOCK=/tmp/milkpop-r49pub-sock; DB=milkpop_r49pub
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
rm -rf "$PGDATA" "$SOCK"; mkdir -p "$PGDATA" "$SOCK"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $SOCK -c listen_addresses='' -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h "$SOCK" -U postgres -d postgres -c "create database $DB" >/dev/null

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✔ $1";
        else FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want: $3"; fi; }
Q()  { "$PGBIN/psql" -tA -X -h "$SOCK" -U postgres -d "$DB" -c "$1"; }
QF() { { "$PGBIN/psql" -tA -X -h "$SOCK" -U postgres -d "$DB" -c "$1" 2>&1 || true; } | tr '\n' ' '; }
OWNER=00000000-0000-4000-8000-0000000000b1
AS() { QF "select set_config('request.jwt.claims','{\"sub\":\"$OWNER\",\"role\":\"authenticated\",\"aal\":\"aal2\"}',false);
           set role authenticated; $1"; }

# R4.10 Increment 4: the Supabase privilege/surface shim is no longer written
# out here. Every database harness executes ONE shared file so they all start
# from the same posture as production — see scripts/lib/supabase-local-privileges.sql
# for why that matters (a harness that starts MORE locked down than production
# can prove a REVOKE worked but can never see a relation left readable).
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$DB" >/dev/null -f "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$DB" -f supabase/schema.FRESH-INSTALL-ONLY.sql >/dev/null
# shellcheck source=launch/migration-manifest.sh
source launch/migration-manifest.sh
for m in "${MP_MIGRATIONS[@]}"; do
  "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$DB" -f "$m" >/dev/null
done
echo "chain: ${#MP_MIGRATIONS[@]} migrations applied"

"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$DB" >/dev/null <<SEED
insert into stores (id,name,address,postcode,opening_hours,status,setup_status,
                    timezone,currency_code,payment_methods,vat_config_confirmed_at)
values ('s1','Store','1 Way','S1 1AA','Mon-Sun 09:00-21:00','coming_soon','ACTIVE',
        'Europe/London','GBP','["cash","card"]'::jsonb,now());
insert into staff_profiles (id,name,email,role,store_id,store_name,auth_id)
values ('p_owner','Olive Owner','o@t.local','owner','s1','Store','$OWNER');
delete from menu_items;
-- INC11: a LIVE fixture must satisfy the publication contract (final-state
-- validation runs on every later touch), so the published row carries a real
-- image and the payloads echo it.
insert into menu_items (id,name,category,price,image,available) values
  ('m_visible','Visible Shake','milkshakes',5.00,'/fx.webp',true),
  ('m_hidden','Withdrawn Shake','milkshakes',6.00,'/fx.webp',false);
SEED

VIS='{"id":"m_visible","name":"Visible Shake","category":"milkshakes","price":5.50,"image":"/fx.webp","description":"","calories":0,"tags":[],"allergens":[]}'
HID='{"id":"m_hidden","name":"Withdrawn Shake","category":"milkshakes","price":6.00,"image":"/fx.webp","description":"","calories":0,"tags":[],"allergens":[]}'

echo; echo "— §1 the hazard is CLOSED: the filtered snapshot is refused, nothing dies —"
chk "the catalogue holds one visible and one hidden product" "$(Q "select count(*) from menu_items")" "2"
chk "the anonymous surface shows only the visible one" "$(Q "select count(*) from menu_items_public")" "1"
# The publisher hydrated the ANONYMOUS projection, so the count it believes in
# is 1 — that is the total an honest client sends, and it cannot match the
# base table. (R4.10: the total argument is mandatory; the old two-argument
# call no longer exists, so this suite states what the stale client would.)
# INC11: the caller states BOTH facts it hydrated. The anon-fed publisher can
# read the CURRENT revision (it is the total that exposes the filtered view),
# so this hazard call passes a fresh revision and a stale total — the TOTAL
# path must still refuse on its own, proving the secondary defence never
# rotted behind the new primary one.
PARTIAL="$(AS "select replace_collection('menu_items', '[$VIS]'::jsonb, 1,
  (select revision from collection_revisions where table_key='menu_items'));")"
case "$PARTIAL" in *collection_snapshot_stale*) STALE=yes;; *) STALE="no: $PARTIAL";; esac
chk "publishing the ANONYMOUS copy is REFUSED as a stale snapshot" "$STALE" "yes"
chk "the hidden product SURVIVES the refused call" \
    "$(Q "select count(*) from menu_items where id='m_hidden'")" "1"
chk "…and the refused call changed nothing (the edit did NOT land)" \
    "$(Q "select price::text from menu_items where id='m_visible'")" "5.00"

echo; echo "— §2 the fix: the full authenticated snapshot, with its total, applies cleanly —"
FULL="$(AS "select (replace_collection('menu_items', '[$VIS,$HID]'::jsonb, 2,
  (select revision from collection_revisions where table_key='menu_items')))->'rows';")"
chk "publishing the FULL catalogue keeps the hidden product" \
    "$(Q "select count(*) from menu_items where id='m_hidden'")" "1"
chk "…still hidden — availability is server truth, never published" \
    "$(Q "select available::text from menu_items where id='m_hidden'")" "false"
chk "…and the edit to the visible product still lands" \
    "$(Q "select price::text from menu_items where id='m_visible'")" "5.50"
chk "…and the visible product is still visible" \
    "$(Q "select available::text from menu_items where id='m_visible'")" "true"
chk "the anonymous surface is unchanged by any of it" \
    "$(Q "select count(*) from menu_items_public")" "1"

echo
if [ "$FAIL" = "0" ]; then echo "✔ R49 PUBLISH SAFETY — $PASS passed, 0 failed";
else echo "✖ R49 PUBLISH SAFETY — $PASS passed, $FAIL failed"; fi
exit "$([ "$FAIL" = "0" ] && echo 0 || echo 1)"

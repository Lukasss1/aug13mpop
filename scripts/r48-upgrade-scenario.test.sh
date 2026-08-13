#!/usr/bin/env bash
# ============================================================================
#  r48-upgrade-scenario.test.sh — the v4.7 → v4.8 UPGRADE PATH
#  R4.9 · Gate G3 (round 2 — strengthened after the external G2/G3 audit)
# ============================================================================
#  Every other database suite builds the schema by applying the whole chain at
#  once. That can never show what an EXISTING database does when the R4.8
#  migrations arrive. This suite drives the REAL ledger runner —
#  launch/launch.sh --db-fresh / --db-upgrade — over a genuine v4.7 database
#  carrying business data, and asserts both the SQL state transformation and
#  the runner mechanics (ledger rows, ordinals, checksums, second-run no-op).
#
#  §4 tests the claim from the external audit of v4.8.0:
#     "The allergen trigger only checks a future transition from unavailable to
#      available. Existing available = true rows are not revalidated when gates
#      are armed."
#
#  §7 tests the recovery path the R4.9 manifest REORDER creates. A deployment
#  attempt against the ORIGINAL v4.8.0 order would have applied and recorded
#  the 58 v4.7 migrations plus migration_r48_truth_and_people.sql, then died
#  inside migration_r48_allergens.sql, leaving a 59-row ledger. The corrected
#  manifest moves gates ahead of allergens — AFTER that recorded prefix. This
#  section proves a database in exactly that state upgrades cleanly, keeps the
#  recorded prefix's ordinals and checksums, and applies the rest exactly once.
#
#    Run: npm run test:r48-upgrade
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/r48-upgrade-scenario.test.sh"
fi
PGDATA="/tmp/milkpop-r48up-pg"
PGPORT="${MP_R48UP_PORT:-55488}"
SB="/tmp/milkpop-r48up-sb"
OUT="/tmp/milkpop-r48up-out"
PW="r48up$$"

PASS=0; FAIL=0
chk() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✔ $1";
  else FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want: $3"; fi
}
chk_has() {
  case "$2" in
    *"$3"*) PASS=$((PASS+1)); echo "  ✔ $1" ;;
    *) FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want to contain: $3" ;;
  esac
}

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -rf "$PGDATA" "$SB" "$OUT"; mkdir -p "$PGDATA" "$SB" "$OUT"
PWFILE="$(mktemp)"; printf '%s\n' "$PW" > "$PWFILE"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=scram-sha-256 --pwfile="$PWFILE" >/dev/null
rm -f "$PWFILE"
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c fsync=off" -w start >/dev/null

Q()     { PGPASSWORD="$PW" "$PGBIN/psql" -tA -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" -c "$2"; }
QFAIL() { { PGPASSWORD="$PW" "$PGBIN/psql" -tA -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" -c "$2" 2>&1 || true; } | tr '\n' ' '; }
QQ()    { PGPASSWORD="$PW" "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1"; }

# --- Supabase surface shim (MIRRORS scripts/migration-baseline.test.sh §2) ---
shim() {
# R4.10 Increment 4: shim body replaced by the ONE shared file so every
# database harness starts from the same posture as production.
  QQ "$1" >/dev/null < "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"
}

# --- Sandbox: the REAL launch driver + the REAL SQL --------------------------
mkdir -p "$SB/launch" "$SB/supabase"
cp "$REPO/package.json" "$SB/"
cp "$REPO/launch/launch.sh" "$SB/launch/"
cp "$REPO/supabase"/*.sql "$SB/supabase/"

# shellcheck source=launch/migration-manifest.sh
source "$REPO/launch/migration-manifest.sh"
FULL=("${MP_MIGRATIONS[@]}")
FULL_N=${#FULL[@]}
V47_N=0
for i in "${!FULL[@]}"; do
  if [ "${FULL[$i]}" = "supabase/migration_r48_truth_and_people.sql" ]; then V47_N=$i; break; fi
done

# write_manifest <count> — a sandbox manifest holding the first <count> entries
write_manifest() {
  local n="$1" i
  { echo 'MP_FRESH_ONLY=('
    echo '  "supabase/schema.FRESH-INSTALL-ONLY.sql"'
    echo '  "supabase/seed.sql"'
    echo ')'
    echo 'MP_BASELINE_MIGRATIONS=('
    for ((i=0;i<n;i++)); do printf '  "%s"\n' "${FULL[$i]}"; done
    echo ')'
    echo 'MP_FUTURE_MIGRATIONS=()'
    echo 'MP_MIGRATIONS=("${MP_BASELINE_MIGRATIONS[@]}")'
    echo 'case "${1:-}" in'
    echo '  fresh) printf "%s\n" "${MP_FRESH_ONLY[@]}" "${MP_MIGRATIONS[@]}" ;;'
    echo '  upgrade|migrations) printf "%s\n" "${MP_MIGRATIONS[@]}" ;;'
    echo '  all) printf "%s\n" "${MP_FRESH_ONLY[@]}" "${MP_MIGRATIONS[@]}" ;;'
    echo 'esac'
  } > "$SB/launch/migration-manifest.sh"
}

run_launch() { # <name> <stdin> <args…>
  local name="$1" input="$2"; shift 2
  ( cd "$SB" && export SUPABASE_DB_URL="postgresql://postgres:${PW}@127.0.0.1:${PGPORT}/${DB}" \
      && printf '%s' "$input" | bash launch/launch.sh "$@" ) >"$OUT/$name.log" 2>&1 && RC=0 || RC=$?
}
ledger() { Q "$DB" "select count(*) from public.mp_migration_ledger"; }

echo "chain: $FULL_N migrations; v4.7 prefix: $V47_N"

# ===========================================================================
#  PART A — v4.7 → v4.8 over a real ledger, with business data
# ===========================================================================
DB=milkpop_r48_a
Q postgres "create database $DB" >/dev/null
shim "$DB"

echo; echo "— §1 build the v4.7 database through the REAL runner —"
write_manifest "$V47_N"
run_launch a_fresh $'ERASE AND INSTALL\nDONE\n' --db-fresh
chk "--db-fresh exits 0 on the v4.7 manifest" "$RC" "0"
chk "the ledger records exactly the v4.7 chain" "$(ledger)" "$V47_N"
# The CURRENT fresh installer carries menu_items.available so the CURRENT
# production seed can run before historical migration replay. This scenario
# intentionally models an OLD pre-R4.8 live database, where that column did not
# exist yet, so remove only that compatibility column before the upgrade test.
Q "$DB" "alter table menu_items drop column if exists available;" >/dev/null
chk "pre-state: menu_items has NO 'available' column" \
    "$(Q "$DB" "select count(*) from information_schema.columns where table_name='menu_items' and column_name='available'")" "0"
chk "pre-state: there is no launch_settings table" \
    "$(Q "$DB" "select count(*) from information_schema.tables where table_name='launch_settings'")" "0"

echo; echo "— §2 the business data a live database would be holding —"
QQ "$DB" >/dev/null <<'PRE'
insert into stores (id, name, address, postcode, opening_hours, vat_config_confirmed_at,
                    setup_status, timezone, currency_code, payment_methods)
values ('s_live', 'Live Store', '1 Upgrade Way', 'U1 1AA', 'Mon-Sun 09:00-21:00', now(),
        'ACTIVE', 'Europe/London', 'GBP', '["cash","card"]'::jsonb);
insert into menu_items (id, name, category, price, image, allergens) values
  ('mp_up_1', 'Classic Shake',  'milkshakes', 6.00, '', '["Dairy"]'::jsonb),
  ('mp_up_2', 'Nutty Shake',    'milkshakes', 6.50, '', '["Dairy","Nuts"]'::jsonb),
  ('mp_up_3', 'Sorbet Slush',   'slush',      4.00, '', '[]'::jsonb);
insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
values ('emp_owner', 'Olive Owner', 'owner@test.local', 'owner', 's_live', 'Live Store',
        '00000000-0000-4000-8000-00000000000a');
PRE
FP_MENU="select md5(string_agg(r,'|' order by r)) from (select concat_ws('~',id,name,category,price::text,image,allergens::text) r from menu_items where id <> 'mp_up_new') t"
FP_STORE="select md5(string_agg(r,'|' order by r)) from (select concat_ws('~',id,name,address,postcode,opening_hours,status::text,setup_status,payment_methods::text) r from stores) t"
FP_STAFF="select md5(string_agg(r,'|' order by r)) from (select concat_ws('~',id,name,email,role::text,store_id) r from staff_profiles) t"
FP_MENU_BEFORE="$(Q "$DB" "$FP_MENU")"
FP_STORE_BEFORE="$(Q "$DB" "$FP_STORE")"
FP_STAFF_BEFORE="$(Q "$DB" "$FP_STAFF")"
chk "pre-state: the storefront is OPEN" "$(Q "$DB" "select status from stores where id='s_live'")" "open"
N_PROD="$(Q "$DB" "select count(*) from menu_items")"
chk "pre-state: a populated catalogue exists (seed + the three added here)" \
    "$([ "$N_PROD" -ge 3 ] && echo yes)" "yes"

echo; echo "— §3 THE REAL --db-upgrade —"
write_manifest "$FULL_N"
run_launch a_up $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "--db-upgrade exits 0 over the v4.7 database" "$RC" "0"
chk "the ledger now holds the whole chain" "$(ledger)" "$FULL_N"
# INC11 repoint: the old filter counted files named %migration_r4% — a NAME
# pattern, which silently stopped matching the moment the chain gained files
# named migration_inc11_*. The protected property is "every post-v4.7 chain
# entry was newly recorded", and the ledger's contiguous ordinals state that
# name-free: newly recorded == ordinal at-or-beyond the v4.7 anchor
# (ledger ordinals are 0-BASED, so the anchor itself is ordinal V47_N).
chk "exactly $((FULL_N-V47_N)) post-v4.7 migrations were newly recorded" \
    "$(Q "$DB" "select count(*) from public.mp_migration_ledger where ordinal >= ${V47_N}")" "$((FULL_N-V47_N))"
chk "every ledger row carries an ordinal and a 64-hex checksum" \
    "$(Q "$DB" "select count(*) from public.mp_migration_ledger where ordinal is null or checksum !~ '^[0-9a-f]{64}\$'")" "0"
chk "ledger ordinals are distinct, one per chain entry" \
    "$(Q "$DB" "select count(distinct ordinal) from public.mp_migration_ledger")" "$FULL_N"
chk "…and contiguous (max - min = chain length - 1)" \
    "$(Q "$DB" "select max(ordinal) - min(ordinal) from public.mp_migration_ledger")" "$((FULL_N-1))"
run_launch a_up2 $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "a SECOND --db-upgrade exits 0" "$RC" "0"
chk "…and applies ZERO (ledger unchanged)" "$(ledger)" "$FULL_N"

echo; echo "— §4 the fail-open window —"
chk "EVERY pre-existing product is now available = true (column default)" \
    "$(Q "$DB" "select count(*) from menu_items where available")" "$N_PROD"
chk "…and NONE of them has an approved allergen declaration" \
    "$(Q "$DB" "select count(*) from menu_items mi where mi.available and not exists
         (select 1 from product_allergen_declarations d
           where d.menu_item_id = mi.id and d.state='approved')")" "$N_PROD"

OWNER_CLAIMS='{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","email":"owner@test.local","aal":"aal2"}'
# INC11 repoint: launch_settings is now written only through its save RPC
# (the singleton guard closes direct API-role writes). The properties under
# test are unchanged — the arm/disarm guard triggers fire on the underlying
# UPDATE and their refusals (launch_arm_blocked / launch_disarm_blocked)
# bubble straight through the RPC.
arm() { QFAIL "$DB" "select set_config('request.jwt.claims', '$OWNER_CLAIMS', false);
                     set role authenticated;
                     select save_launch_settings('{\"enforce_public_gates\": true}'::jsonb,
                       (select revision from collection_revisions where table_key='launch_settings'));
                     reset role;
                     select 'armed=' || enforce_public_gates from launch_settings where id;"; }

# Until R4.9 G5 these three assertions read the other way round: arming SUCCEEDED
# with every inherited product visible and revalidated nothing. That was the
# audit's central finding and this suite proved it. They are inverted here
# because the gate now exists — which is exactly the flip the change map said to
# expect.
chk_has "arming is REFUSED while the launch identity is blank" "$(arm)" "launch_arm_blocked"
chk_has "…and the refusal NAMES what is missing" "$(arm)" "legal_business_name"
chk "…and the gates really did not arm" \
    "$(Q "$DB" "select enforce_public_gates from launch_settings where id")" "f"

Q "$DB" "update launch_settings set
  legal_business_name='Upgrade Ltd', registered_address='1 Upgrade Way',
  public_contact_email='hello@example.invalid', privacy_contact_email='dpo@example.invalid',
  public_telephone='+44 0000 000000', canonical_url='https://example.invalid',
  receipt_identity_footer='Upgrade Ltd', vat_state_confirmed=true where id;" >/dev/null

chk_has "with the identity complete the OWNER (aal2) CAN arm the gates" "$(arm)" "armed=t"
chk "the inherited products are still available — the upgrade did not withdraw them" \
    "$(Q "$DB" "select count(*) from menu_items where available")" "$N_PROD"
# …but the public surface makes no allergen claim about them, which is what the
# armed gate is actually guaranteeing in the default posture.
chk "the default posture publishes NO product-level allergen data" \
    "$(Q "$DB" "select count(*) from menu_items_public where allergens <> '[]'::jsonb")" "0"
chk "…while the base table still holds the legacy values (nothing was destroyed)" \
    "$(Q "$DB" "select (count(*) > 0)::text from menu_items where allergens <> '[]'::jsonb")" "true"

# THE REVALIDATION THE AUDIT ASKED FOR. Switching to the publishing posture with
# inherited, undeclared products must be refused — arming now re-checks the
# CURRENT state, not just future transitions.
# The gates cannot be disarmed here — a storefront is open, which is the other
# new invariant — so the revalidation is proved against the predicate the arming
# trigger itself calls, rather than by fighting that invariant.
# R4.10 Increment 8: these assertions used to enter the `declared` posture and
# prove the gate behaved correctly inside it — including, explicitly, that "the
# public view starts publishing the legacy values in that posture". That WAS the
# two-truth-source defect: menu_items.allergens published while the gate checked
# product_allergen_declarations, so the gate could not see what the site claimed.
# Increment 8 removes the posture outright rather than trying to make two sources
# agree. The assertions are REPOINTED to the stronger property — the posture is
# now unreachable, which subsumes every guarantee about behaviour inside it.
# R4.10 (candidate-state validation): while the gates are ARMED — as they are
# at this point in the scenario — the transition trigger now judges the
# PROPOSED row first, so `declared` with unapproved products is refused as
# `launch_degrade_blocked: missing allergen_declarations` BEFORE the CHECK
# constraint ever evaluates. Disarmed, the CHECK refuses the same write as
# `launch_settings_allergen_mode_chk`. Both are named guards proving the same
# property this assertion protects — the posture is UNREACHABLE — so either
# refusal passes; anything else (including success) fails. The two asserts
# below (mode unchanged, no public leak) hold regardless of which line fired.
DECLARED_REFUSAL="$(QFAIL "$DB" "update launch_settings set allergen_disclosure_mode = 'declared' where id;")"
case "$DECLARED_REFUSAL" in
  *launch_settings_allergen_mode_chk*|*launch_degrade_blocked*) DECLARED_VERDICT="refused-by-named-guard" ;;
  *) DECLARED_VERDICT="NOT refused by a named guard: $DECLARED_REFUSAL" ;;
esac
chk "the PUBLISHING posture is refused outright — the two-source path is gone" \
    "$DECLARED_VERDICT" "refused-by-named-guard"
chk "…so the mode is unchanged and no product-level claim is published" \
    "$(Q "$DB" "select allergen_disclosure_mode from launch_settings")" "in_store_only"
chk "…and no public row carries a legacy allergen array" \
    "$(Q "$DB" "select (count(*) = 0)::text from menu_items_public where allergens <> '[]'::jsonb")" "true"
chk "in the default posture the readiness check passes" \
    "$(Q "$DB" "select state from launch_blocking_reasons() where key='allergen_declarations'")" "not_applicable"

Q "$DB" "insert into menu_items (id, name, category, price, image, available)
         values ('mp_up_new', 'New Shake', 'milkshakes', 7.00, '', false);" >/dev/null
# R4.9 G5: what the menu gate protects is the CLAIM, not the product. In the
# default posture no allergen data is published, so publishing a product is
# legitimate and must NOT be blocked — blocking it would be gate theatre. In the
# publishing posture the same transition is refused until a declaration exists.
chk "in the default posture a new product publishes freely (no claim is made)" \
    "$(QFAIL "$DB" "update menu_items set available = true where id = 'mp_up_new';" | tr -d ' ')" "UPDATE1"
Q "$DB" "update menu_items set available = false where id = 'mp_up_new';" >/dev/null
# R4.10 Increment 8: the publishing-posture branch of this test is gone with the
# posture. What it protected — that a product cannot publish an unbacked claim —
# is now guaranteed structurally: no posture publishes a product-level claim at all.
chk "the new product is back to draft and stays off the public view" \
    "$(Q "$DB" "select (count(*) = 0)::text from menu_items_public where id = 'mp_up_new'")" "true"

# The REAL readiness RPC — the very function whose creation broke the chain.
READY="$(QFAIL "$DB" "select set_config('request.jwt.claims', '$OWNER_CLAIMS', false);
                      set role authenticated;
                      select launch_readiness()::text;")"
chk_has "launch_readiness() EXECUTES for an owner/aal2 identity" "$READY" '"ok": true'
chk_has "…it reports the allergen item" "$READY" '"key": "allergen_declarations"'
chk_has "…with its fix link" "$READY" '/admin/menu/'
ALLERGEN_STATE="$(Q "$DB" "select set_config('request.jwt.claims', '$OWNER_CLAIMS', false);
                           set role authenticated;
                           select i->>'state' from jsonb_array_elements(launch_readiness()->'items') i
                            where i->>'key' = 'allergen_declarations';" | tail -1)"
chk "…and its state matches the posture (not_applicable while nothing is claimed)" "$ALLERGEN_STATE" "not_applicable"
case "$READY" in
  *"does not exist"*|*not_permitted*) FAIL=$((FAIL+1)); echo "  ✖ launch_readiness() did not run cleanly: $READY" ;;
  *) PASS=$((PASS+1)); echo "  ✔ no undefined-object or permission error from launch_readiness()" ;;
esac

echo; echo "— §5 store lifecycle and historical data preservation —"
chk "the already-open storefront survives the upgrade untouched" \
    "$(Q "$DB" "select status from stores where id='s_live'")" "open"
chk "…and its trading configuration is intact" \
    "$(Q "$DB" "select setup_status from stores where id='s_live'")" "ACTIVE"
chk "menu rows are value-identical across the upgrade" "$(Q "$DB" "$FP_MENU")" "$FP_MENU_BEFORE"
chk "store rows are value-identical across the upgrade" "$(Q "$DB" "$FP_STORE")" "$FP_STORE_BEFORE"
chk "staff rows are value-identical across the upgrade" "$(Q "$DB" "$FP_STAFF")" "$FP_STAFF_BEFORE"

echo; echo "— §6 the store-open gate on the upgraded database —"
# R4.9 G5: stores.status no longer defaults to 'open', so a bare insert is no
# longer a nothing→open transition and creates a coming_soon storefront instead.
Q "$DB" "insert into stores (id, name, address, postcode, opening_hours)
         values ('s_new', 'New Store', '2 Upgrade Way', 'U2 2BB', 'Mon-Sun 09:00-21:00');" >/dev/null
chk "a bare store insert no longer publishes as OPEN" \
    "$(Q "$DB" "select status from stores where id='s_new'")" "coming_soon"

NOHOURS="$(QFAIL "$DB" "insert into stores (id, name, address, postcode, status)
                        values ('s_nohours', 'No Hours', '3 Upgrade Way', 'U3 3CC', 'open');")"
chk_has "a store cannot open without its own address and opening hours" "$NOHOURS" "store_open_blocked"
chk_has "…and the refusal NAMES the missing facts (R4.9 G2 correction)" "$NOHOURS" "opening_hours"
case "$NOHOURS" in
  *"malformed array literal"*) FAIL=$((FAIL+1)); echo "  ✖ the R4.8 22P02 defect is still present" ;;
  *) PASS=$((PASS+1)); echo "  ✔ no 22P02 malformed-array-literal regression" ;;
esac

chk "a complete store CAN open once the identity is recorded and the gates armed" \
    "$(QFAIL "$DB" "update stores set status='open' where id='s_new'; select status from stores where id='s_new';" | tr -d ' ')" "UPDATE1open"
chk_has "the gates cannot be DISARMED while a storefront is open" \
    "$(QFAIL "$DB" "select set_config('request.jwt.claims', '$OWNER_CLAIMS', false);
                    set role authenticated;
                    select save_launch_settings('{\"enforce_public_gates\": false}'::jsonb,
                      (select revision from collection_revisions where table_key='launch_settings'));")" "launch_disarm_blocked"

# ===========================================================================
#  PART B — recovery from a PARTIALLY APPLIED original v4.8.0
# ===========================================================================
echo; echo "— §7 recovery from a partially applied ORIGINAL v4.8.0 —"
DB=milkpop_r48_b
Q postgres "create database $DB" >/dev/null
shim "$DB"
write_manifest "$((V47_N+1))"
run_launch b_fresh $'ERASE AND INSTALL\nDONE\n' --db-fresh
chk "the partial-v4.8 database builds (v4.7 + truth_and_people)" "$RC" "0"
chk "its ledger holds the $((V47_N+1))-row prefix" "$(ledger)" "$((V47_N+1))"
TRUTH_ORD="$(Q "$DB" "select ordinal from public.mp_migration_ledger where filename='supabase/migration_r48_truth_and_people.sql'")"
TRUTH_CS="$(Q "$DB" "select checksum from public.mp_migration_ledger where filename='supabase/migration_r48_truth_and_people.sql'")"

write_manifest "$FULL_N"   # the CORRECTED order: gates now precedes allergens
run_launch b_up $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "the CORRECTED manifest upgrades that database (preflight accepts the prefix)" "$RC" "0"
chk "the ledger completes to the full chain" "$(ledger)" "$FULL_N"
chk "truth_and_people keeps its ordinal across the reorder" \
    "$(Q "$DB" "select ordinal from public.mp_migration_ledger where filename='supabase/migration_r48_truth_and_people.sql'")" "$TRUTH_ORD"
chk "…and its checksum is untouched" \
    "$(Q "$DB" "select checksum from public.mp_migration_ledger where filename='supabase/migration_r48_truth_and_people.sql'")" "$TRUTH_CS"
chk "gates is recorded AFTER truth_and_people" \
    "$(Q "$DB" "select (select ordinal from public.mp_migration_ledger where filename like '%r48_outbox_and_gates%')
                     > (select ordinal from public.mp_migration_ledger where filename like '%r48_truth_and_people%')")" "t"
chk "allergens is recorded AFTER gates" \
    "$(Q "$DB" "select (select ordinal from public.mp_migration_ledger where filename like '%r48_allergens%')
                     > (select ordinal from public.mp_migration_ledger where filename like '%r48_outbox_and_gates%')")" "t"
run_launch b_up2 $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "a SECOND upgrade of the recovered database exits 0" "$RC" "0"
chk "…and applies ZERO" "$(ledger)" "$FULL_N"

# ===========================================================================
#  PART C — FRESH vs UPGRADED must converge on the same schema
# ===========================================================================
echo; echo "— §8 fresh-install and upgraded databases converge —"
#  The two supported deployment paths are --db-fresh on the whole chain and
#  --db-upgrade over an existing database. If they can land on different schemas
#  then every other proof in this suite only covers one of them. This compares
#  the live CATALOG of both, using the canonical snapshot tool.
DB_UP=milkpop_r48_a          # PART A: v4.7, then upgraded to the full chain
DB=milkpop_r48_c             # built fresh from the same manifest
Q postgres "create database $DB" >/dev/null
shim "$DB"
write_manifest "$FULL_N"
run_launch c_fresh $'ERASE AND INSTALL\nDONE\n' --db-fresh
chk "--db-fresh exits 0 on the full manifest" "$RC" "0"
chk "the fresh ledger holds the whole chain" "$(ledger)" "$FULL_N"

SNAP_DIR=/tmp/milkpop-r48up-snap; rm -rf "$SNAP_DIR"; mkdir -p "$SNAP_DIR"
for pair in "upgraded:$DB_UP" "fresh:$DB"; do
  name="${pair%%:*}"; db="${pair##*:}"
  PGPASSWORD="$PW" PGHOST=127.0.0.1 PGPORT="$PGPORT" PGUSER=postgres PGDB="$db" \
    PGBINDIR="$PGBIN" node scripts/stage3-schema-snapshot.mjs "$SNAP_DIR/$name.json" >/dev/null
done
DIFF="$(node -e '
// The tool nests everything under `sections`; `generated_for` is a label, not
// schema, so the comparison is over the sections themselves.
const a=require("'"$SNAP_DIR"'/upgraded.json").sections, b=require("'"$SNAP_DIR"'/fresh.json").sections;
const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
const bad=[];
for(const k of keys){
  const x=JSON.stringify(a[k]), y=JSON.stringify(b[k]);
  if(x!==y) bad.push(k+" ("+(a[k]?.length??"?")+" vs "+(b[k]?.length??"?")+")");
}
console.log(bad.length?bad.join(", "):"IDENTICAL");
')"
chk "every catalog section is identical between the two paths" "$DIFF" "IDENTICAL"
# A vacuous "IDENTICAL" over two empty snapshots would prove nothing, so the
# comparison is required to have inspected a real catalogue.
chk "…and the comparison inspected a populated catalogue (>30 tables)" \
    "$(node -e 'const s=require("'"$SNAP_DIR"'/fresh.json").sections;console.log((s.tables||[]).length>30?"yes":"no")')" "yes"
chk "…across every section the snapshot tool produces" \
    "$(node -e 'const s=require("'"$SNAP_DIR"'/fresh.json").sections;console.log(Object.keys(s).length>=6?"yes":"no")')" "yes"

echo
if [ "$FAIL" = "0" ]; then
  echo "✔ R48 UPGRADE SCENARIO — $PASS passed, 0 failed  (real --db-upgrade; v4.7→$FULL_N, partial-v4.8 recovery, fresh≡upgraded)"
else
  echo "✖ R48 UPGRADE SCENARIO — $PASS passed, $FAIL failed"
fi
exit "$([ "$FAIL" = "0" ] && echo 0 || echo 1)"

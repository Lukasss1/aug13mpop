#!/usr/bin/env bash
# ============================================================================
#  pre-ledger-adopt.test.sh — EXECUTABLE proof of OPT-01.2 (pre-ledger ledger
#  adoption). Boots a throwaway PostgreSQL cluster (TCP, trust auth), copies the
#  repo's launch driver + SQL + verify-current-baseline.sql into a SANDBOX, and
#  drives the REAL launch.sh --db-upgrade / --db-adopt-ledger paths against
#  live databases built to the fully-migrated FINAL schema WITHOUT a ledger.
#
#  Proves:
#    A  --db-upgrade REFUSES to replay history on a pre-ledger DB (exact
#       message); --db-adopt-ledger then records all N migrations WITHOUT
#       executing any (DDL-event canary proves zero non-ledger DDL ran),
#       sentinel data + policies stay byte-identical, and a follow-up
#       --db-upgrade runs zero.
#    B  a database missing ONE required baseline object fails adoption and
#       writes NO ledger rows.
#    C  a database carrying a known obsolete permissive policy fails adoption
#       and writes NO ledger rows.
#    D  after adoption, ONE genuinely new migration applies EXACTLY once and
#       commits with its ledger row; a second upgrade runs zero.
#    E  altering an already-adopted migration file is caught by the full
#       preflight BEFORE any new migration runs.
#    F  the deployment advisory lock prevents a second concurrent runner
#       (both --db-upgrade and --db-adopt-ledger).
#
#  The Supabase surface shim MIRRORS scripts/migration-baseline.test.sh §2.
#  Run: npm run test:adopt        (safe to re-run; the cluster is recreated)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/pre-ledger-adopt.test.sh"
fi

PGDATA="/tmp/milkpop-adopt-pg"
PGPORT=54331
SB="/tmp/milkpop-adopt-sandbox"
OUT="/tmp/milkpop-adopt-out"
DECOY_PW='S3cr3t-DECOY-Pw'
export MP_LOCK_KEY1_CHK=79215 MP_LOCK_KEY2_CHK=76207   # must match launch.sh

ADMIN() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres "$@"; }
DB()    { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" "${@:2}"; }
Q()     { "$PGBIN/psql" -tA -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" -c "$2"; }

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "✔ $1"; }
bad() { FAIL=$((FAIL+1)); echo "✖ $1${2:+
    $2}"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2', expected '$3'"; fi; }
yes_if() { [ "$1" -ne 0 ] && echo yes || echo no; }   # $1=exit code → 'yes' if non-zero

# --- 0. Fresh cluster -------------------------------------------------------
cleanup
rm -rf "$PGDATA" "$SB" "$OUT"; mkdir -p "$PGDATA" "$OUT"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='127.0.0.1' -c port=$PGPORT -c fsync=off -c max_locks_per_transaction=256" -w start >/dev/null

# --- 1. Sandbox repo copy (launch driver + SQL + verifier) ------------------
mkdir -p "$SB/launch" "$SB/supabase" "$SB/.pristine"
cp package.json "$SB/"
cp launch/launch.sh launch/migration-manifest.sh launch/verify-current-baseline.sql "$SB/launch/"
cp supabase/*.sql "$SB/supabase/"
cp -r "$SB/supabase" "$SB/launch" "$SB/.pristine/"

restore_sandbox() {   # revert any per-test manifest/file tampering
  rm -f "$SB"/supabase/*.sql
  cp "$SB"/.pristine/supabase/*.sql "$SB/supabase/"
  cp "$SB"/.pristine/launch/migration-manifest.sh "$SB/launch/migration-manifest.sh"
}

# shellcheck source=/dev/null
source "$SB/launch/migration-manifest.sh"
N=${#MP_MIGRATIONS[@]}
echo "chain length from manifest: $N migrations"
# R4.10 Increment 4: shim body replaced by the ONE shared file so every
# database harness starts from the same posture as production.

SHIM_SQL="$(cat "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql")"

# build_final_db <db> — a fully-migrated FINAL schema with NO ledger (pre-ledger)
build_final_db() {
  local db="$1"
  ADMIN -c "drop database if exists $db" >/dev/null
  ADMIN -c "create database $db" >/dev/null
  DB "$db" -c "$SHIM_SQL" >/dev/null
  DB "$db" -f "$SB/supabase/schema.FRESH-INSTALL-ONLY.sql" >/dev/null
  local m
  for m in "${MP_MIGRATIONS[@]}"; do DB "$db" -f "$SB/$m" >/dev/null; done
}

# ledger row count that is safe when the table is absent (0), for assertions
ledger_count() {
  local db="$1" ex
  ex="$(Q "$db" "select to_regclass('public.mp_migration_ledger') is not null")"
  if [ "$ex" = "t" ]; then Q "$db" "select count(*) from public.mp_migration_ledger"; else echo 0; fi
}

# run_launch <name> <db> <stdin> <arg…>  → captures output + exit code into RC
run_launch() {
  local name="$1" db="$2" input="$3"; shift 3
  local url="postgresql://postgres:${DECOY_PW}@127.0.0.1:${PGPORT}/${db}"
  ( cd "$SB" && printf '%s' "$input" | env SUPABASE_DB_URL="$url" PATH="$PGBIN:$PATH" \
      MP_LOCK_TIMEOUT="${MP_LOCK_TIMEOUT:-30}" bash launch/launch.sh "$@" ) \
      >"$OUT/$name.log" 2>&1 && RC=0 || RC=$?
}
grepc() { grep -acE "$1" "$OUT/$2.log" || true; }

# ============================================================================
echo; echo "════ TEST A — successful adoption ════"
DBA=mp_adopt_a
build_final_db "$DBA"
chk "A.0 built pre-ledger DB (ledger absent)" "$(Q "$DBA" "select to_regclass('public.mp_migration_ledger') is null")" "t"
# sentinel business data + a DDL-event canary in a NON-public schema so it does
# not itself violate the 'RLS on every public table' baseline invariant.
DB "$DBA" <<SQL >/dev/null
insert into news_posts (id, title, content, status)
  values ('adopt-e2e', 'Adopt proof', 'must survive adoption untouched', 'published');
create schema mp_test;
create table mp_test.ddl_audit (id serial primary key, tag text, obj text, sch text);
create or replace function mp_test.ddl_rec() returns event_trigger language plpgsql as \$f\$
declare r record;
begin
  for r in select command_tag, object_identity, schema_name from pg_event_trigger_ddl_commands() loop
    -- Ledger DDL is expected; migration DDL lands in public/storage/auth. pg_temp
    -- helpers from the verifier are ignored. Anything else = a migration ran.
    if coalesce(r.schema_name,'') in ('public','storage','auth')
       and coalesce(r.object_identity,'') not like '%mp_migration_ledger%' then
      insert into mp_test.ddl_audit(tag,obj,sch) values (r.command_tag, r.object_identity, r.schema_name);
    end if;
  end loop;
end \$f\$;
create event trigger mp_ddl_audit_trg on ddl_command_end execute function mp_test.ddl_rec();
SQL
DATA_BEFORE="$(Q "$DBA" "select md5(string_agg(t.r,'|')) from (select row(np.*)::text r from news_posts np order by id) t")"
POL_BEFORE="$(Q "$DBA" "select md5(string_agg(r,'|' order by r)) from (select concat_ws(':',schemaname,tablename,policyname,cmd,coalesce(qual,''),coalesce(with_check,''),array_to_string(roles,',')) r from pg_policies) s")"

run_launch a_up "$DBA" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "A.1 --db-upgrade on pre-ledger DB exits non-zero" "$(yes_if "$RC")" "yes"
chk "A.2 exact 3-line pre-ledger refusal is printed" \
  "$(grep -Fxc 'Existing pre-ledger Milk Pop database detected.' "$OUT/a_up.log")$(grep -Fxc 'Historical migrations will not be replayed automatically.' "$OUT/a_up.log")$(grep -Fxc 'Run --db-adopt-ledger after creating and verifying a backup.' "$OUT/a_up.log")" "111"
chk "A.3 upgrade applied/skipped NOTHING (no migration ran)" "$(grepc '→ apply|= skip' a_up)" "0"

run_launch a_adopt "$DBA" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "A.4 adoption exits 0" "$RC" "0"
chk "A.5 adoption reports NONE executed" "$(grepc 'NONE were executed' a_adopt)" "1"
chk "A.6 password never printed" "$(grepc "$DECOY_PW" a_adopt)" "0"
chk "A.7 host:port/db target IS shown" "$(grepc "127.0.0.1:${PGPORT}/${DBA}" a_adopt)" "1"
chk "A.8 ZERO non-ledger DDL executed during adoption (event canary empty)" \
  "$(Q "$DBA" 'select count(*) from mp_test.ddl_audit')" "0"
chk "A.9 all $N migrations recorded" "$(Q "$DBA" 'select count(*) from public.mp_migration_ledger')" "$N"
chk "A.10 every row method=verified_existing_baseline" \
  "$(Q "$DBA" "select count(*) from public.mp_migration_ledger where method='verified_existing_baseline'")" "$N"
chk "A.11 no row is marked executed" \
  "$(Q "$DBA" "select count(*) from public.mp_migration_ledger where method='executed'")" "0"
chk "A.12 adopted_at + baseline_version populated on every row" \
  "$(Q "$DBA" "select count(*) from public.mp_migration_ledger where adopted_at is not null and baseline_version is not null")" "$N"
chk "A.13 ledger filenames == manifest set exactly" \
  "$(Q "$DBA" "select count(*) from public.mp_migration_ledger") $(Q "$DBA" "select count(*) from (select filename from public.mp_migration_ledger except values $(printf "('%s')," "${MP_MIGRATIONS[@]}" | sed 's/,$//')) x")" "$N 0"
DATA_AFTER="$(Q "$DBA" "select md5(string_agg(t.r,'|')) from (select row(np.*)::text r from news_posts np order by id) t")"
POL_AFTER="$(Q "$DBA" "select md5(string_agg(r,'|' order by r)) from (select concat_ws(':',schemaname,tablename,policyname,cmd,coalesce(qual,''),coalesce(with_check,''),array_to_string(roles,',')) r from pg_policies) s")"
chk "A.14 sentinel business data byte-identical after adoption" "$DATA_AFTER" "$DATA_BEFORE"
chk "A.15 full RLS policy set byte-identical after adoption" "$POL_AFTER" "$POL_BEFORE"
chk "A.16 all three obsolete direct-order policies are ABSENT (WS7b closed the ledger)" \
  "$(Q "$DBA" "select count(*) from pg_policies where tablename='orders' and policyname in ('orders_insert_owner_import','orders_update_mgr','orders_delete_mgr')")" "0"
# R4.9 G2: this assertion previously required orders_insert_owner_import to be
# PRESENT with an is_owner() check. migration_stage3_ws7b_payment_authority.sql
# deliberately DROPS it (together with orders_update_mgr and orders_delete_mgr)
# because while they existed, "every completed order originates through
# finalise_order_payment()" was false. The assertion had simply never been run
# since WS7b was appended to the chain, so it still pinned the pre-WS7b shape.
# Repointed to assert the absence the chain actually guarantees; A.15 above
# still proves the FULL policy set is byte-identical across adoption, which is
# what this section is really testing.

Q "$DBA" "drop event trigger if exists mp_ddl_audit_trg" >/dev/null
run_launch a_up2 "$DBA" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "A.17 post-adoption upgrade exits 0" "$RC" "0"
chk "A.18 post-adoption upgrade applies ZERO ($N skipped)" \
  "$(grepc "0 migration\(s\) applied, $N already-applied skipped" a_up2)" "1"
chk "A.19 post-adoption upgrade ran no migration" "$(grepc '→ apply' a_up2)" "0"

# ============================================================================
echo; echo "════ TEST B — incomplete baseline (missing required object) ════"
DBB=mp_adopt_b
build_final_db "$DBB"
Q "$DBB" "drop trigger trg_staff_self_update_lock on staff_profiles" >/dev/null
run_launch b_adopt "$DBB" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "B.1 adoption exits non-zero" "$(yes_if "$RC")" "yes"
chk "B.2 failure is a BASELINE FAIL / ADOPTION ABORTED" \
  "$([ "$(grepc 'BASELINE FAIL|ADOPTION ABORTED' b_adopt)" -ge 1 ] && echo yes || echo no)" "yes"
chk "B.3 NO ledger rows written (transaction rolled back)" "$(ledger_count "$DBB")" "0"

# ============================================================================
echo; echo "════ TEST C — obsolete permissive policy present ════"
DBC=mp_adopt_c
build_final_db "$DBC"
Q "$DBC" "create policy orders_insert_staff on orders for insert to authenticated with check (true)" >/dev/null
run_launch c_adopt "$DBC" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "C.1 adoption exits non-zero" "$(yes_if "$RC")" "yes"
chk "C.2 failure names the obsolete policy (orders_insert_staff)" \
  "$([ "$(grepc 'orders_insert_staff' c_adopt)" -ge 1 ] && echo yes || echo no)" "yes"
chk "C.3 NO ledger rows written" "$(ledger_count "$DBC")" "0"

# ============================================================================
echo; echo "════ TEST D — future migration applies exactly once ════"
DBD=mp_adopt_d
build_final_db "$DBD"
run_launch d_adopt "$DBD" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "D.1 adoption exits 0" "$RC" "0"
# Append a genuinely new (deliberately non-idempotent) migration to the sandbox.
NEWM="supabase/migration_zz_adopt_probe.sql"
cat > "$SB/$NEWM" <<'SQL'
-- non-idempotent probe: a replay would insert a second row.
create table adopt_probe (id serial primary key, note text not null);
insert into adopt_probe (note) values ('applied-once');
SQL
printf '\nMP_MIGRATIONS+=("%s")\n' "$NEWM" >> "$SB/launch/migration-manifest.sh"
run_launch d_up "$DBD" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "D.2 upgrade exits 0" "$RC" "0"
chk "D.3 exactly one new migration applied ($N skipped)" \
  "$(grepc "1 migration\(s\) applied, $N already-applied skipped" d_up)" "1"
chk "D.4 probe committed with a ledger row (method=executed)" \
  "$(Q "$DBD" "select count(*) from public.mp_migration_ledger where filename='$NEWM' and method='executed'")" "1"
chk "D.5 probe side effect present exactly once" "$(Q "$DBD" 'select count(*) from adopt_probe')" "1"
run_launch d_up2 "$DBD" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "D.6 second upgrade applies zero" "$(grepc "0 migration\(s\) applied, $((N+1)) already-applied skipped" d_up2)" "1"
chk "D.7 probe still exactly once" "$(Q "$DBD" 'select count(*) from adopt_probe')" "1"
restore_sandbox

# ============================================================================
echo; echo "════ TEST E — checksum/preflight failure before any new migration ════"
DBE=mp_adopt_e
build_final_db "$DBE"
run_launch e_adopt "$DBE" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "E.1 adoption exits 0" "$RC" "0"
# Tamper an ALREADY-ADOPTED migration file, and add a separate NEW migration.
TAMPER="supabase/migration_security_lockdown.sql"
printf '\n-- tampered byte\n' >> "$SB/$TAMPER"
ENEW="supabase/migration_zz_e_new.sql"
printf 'create table e_new (id int);\n' > "$SB/$ENEW"
printf '\nMP_MIGRATIONS+=("%s")\n' "$ENEW" >> "$SB/launch/migration-manifest.sh"
run_launch e_up "$DBE" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "E.2 upgrade exits non-zero" "$(yes_if "$RC")" "yes"
chk "E.3 CHECKSUM MISMATCH named for the tampered file" "$(grepc "CHECKSUM MISMATCH: $TAMPER" e_up)" "1"
chk "E.4 the NEW migration never ran (no ledger row)" \
  "$(Q "$DBE" "select count(*) from public.mp_migration_ledger where filename='$ENEW'")" "0"
chk "E.5 the NEW migration's side effect is absent (caught before apply)" \
  "$(Q "$DBE" "select to_regclass('public.e_new') is null")" "t"
restore_sandbox

# ============================================================================
echo; echo "════ TEST F — advisory lock blocks a second concurrent runner ════"
# F1: --db-upgrade contends with a held SESSION advisory lock.
DBF=mp_adopt_f
build_final_db "$DBF"
run_launch f_adopt "$DBF" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "F.0 baseline adoption for lock test exits 0" "$RC" "0"
"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DBF" \
  -c "select pg_advisory_lock($MP_LOCK_KEY1_CHK,$MP_LOCK_KEY2_CHK); select pg_sleep(25);" >/dev/null 2>&1 &
HOLDER=$!
# wait until the lock is actually held
for _ in $(seq 1 20); do
  held="$(Q "$DBF" "select count(*) from pg_locks where locktype='advisory' and objid=$MP_LOCK_KEY2_CHK and granted")"
  [ "$held" -ge 1 ] && break; sleep 0.2
done
MP_LOCK_TIMEOUT=2 run_launch f_up "$DBF" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "F.1 contended --db-upgrade exits non-zero" "$(yes_if "$RC")" "yes"
chk "F.2 it reports the deployment lock is held" \
  "$([ "$(grepc 'Deployment lock is held by another run|held by another run' f_up)" -ge 1 ] && echo yes || echo no)" "yes"
chk "F.3 no migration was applied while blocked" "$(grepc '→ apply' f_up)" "0"

# F2: --db-adopt-ledger contends with a held SESSION advisory lock (xact try-lock).
DBF2=mp_adopt_f2
build_final_db "$DBF2"
"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DBF2" \
  -c "select pg_advisory_lock($MP_LOCK_KEY1_CHK,$MP_LOCK_KEY2_CHK); select pg_sleep(25);" >/dev/null 2>&1 &
HOLDER2=$!
for _ in $(seq 1 20); do
  held="$(Q "$DBF2" "select count(*) from pg_locks where locktype='advisory' and objid=$MP_LOCK_KEY2_CHK and granted")"
  [ "$held" -ge 1 ] && break; sleep 0.2
done
run_launch f2_adopt "$DBF2" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "F.4 contended --db-adopt-ledger exits non-zero" "$(yes_if "$RC")" "yes"
chk "F.5 adoption wrote NO ledger rows while blocked" "$(ledger_count "$DBF2")" "0"
kill "$HOLDER" "$HOLDER2" 2>/dev/null || true; wait 2>/dev/null || true

# ============================================================================
echo; echo "════ TEST G — inserting before an applied migration is rejected (order drift) ════"
DBG=mp_adopt_g
build_final_db "$DBG"
run_launch g_adopt "$DBG" $'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' --db-adopt-ledger
chk "G.1 adoption exits 0" "$RC" "0"
# Splice a NEW migration into the MIDDLE of the manifest (before applied ones).
MIDM="supabase/migration_zz_g_mid.sql"
printf 'create table g_mid (id int);\n' > "$SB/$MIDM"
printf '\nMP_MIGRATIONS=("${MP_MIGRATIONS[@]:0:5}" "%s" "${MP_MIGRATIONS[@]:5}")\n' "$MIDM" >> "$SB/launch/migration-manifest.sh"
run_launch g_up "$DBG" $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "G.2 upgrade exits non-zero" "$(yes_if "$RC")" "yes"
chk "G.3 preflight names order drift / prefix violation" \
  "$([ "$(grepc 'order drift|prefix|inserted before' g_up)" -ge 1 ] && echo yes || echo no)" "yes"
chk "G.4 the mid-inserted migration never ran (no ledger row)" \
  "$(Q "$DBG" "select count(*) from public.mp_migration_ledger where filename='$MIDM'")" "0"
chk "G.5 its side effect is absent (caught before apply)" \
  "$(Q "$DBG" "select to_regclass('public.g_mid') is null")" "t"
restore_sandbox

# ============================================================================
echo; echo "════ TEST H — PGPASSFILE + adoption temp are always cleaned up; one EXIT trap ════"
DBH=mp_adopt_h
build_final_db "$DBH"
HTMP="/tmp/milkpop-adopt-htmp"; rm -rf "$HTMP"; mkdir -p "$HTMP"
( cd "$SB" && printf 'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' \
    | env SUPABASE_DB_URL="postgresql://postgres:${DECOY_PW}@127.0.0.1:${PGPORT}/${DBH}" \
          PATH="$PGBIN:$PATH" TMPDIR="$HTMP" bash launch/launch.sh --db-adopt-ledger ) \
    >"$OUT/h_adopt.log" 2>&1 && RC=0 || RC=$?
chk "H.1 standalone adoption exits 0" "$RC" "0"
chk "H.2 no PGPASSFILE left behind on exit" "$(find "$HTMP" -name 'mp-pgpass.*' | wc -l | tr -d ' ')" "0"
chk "H.3 no adoption temp SQL left behind on exit" "$(find "$HTMP" -name 'mp-adopt.*.sql' | wc -l | tr -d ' ')" "0"
# Structural (OPT-01.2A §3): exactly one EXIT trap, and it is exit_cleanup;
# final_gate must not install its own EXIT trap.
chk "H.4 launch.sh installs exactly one EXIT trap" \
  "$(grep -cE "trap '[^']*' EXIT" "$SB/launch/launch.sh")" "1"
chk "H.5 the sole EXIT trap is exit_cleanup" \
  "$(grep -cE "trap 'exit_cleanup' EXIT" "$SB/launch/launch.sh")" "1"
chk "H.6 exit_cleanup covers both preview kill and db_cleanup" \
  "$([ "$(grep -cE 'kill "\$PREVIEW_PID"' "$SB/launch/launch.sh")" -ge 1 ] && grep -q 'db_cleanup' "$SB/launch/launch.sh" && echo yes || echo no)" "yes"

# ============================================================================
echo; echo "════ TEST I — a password containing ':' and '\\' authenticates (.pgpass escaping) ════"
# scram-authenticate one dedicated role over TCP while admin stays on trust.
"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres \
  -c "set password_encryption='scram-sha-256'; drop role if exists escuser; create role escuser login password 'p:a\\ss';" >/dev/null 2>&1
ADMIN -c "drop database if exists esc_test" >/dev/null; ADMIN -c "create database esc_test owner escuser" >/dev/null
HBA="$PGDATA/pg_hba.conf"
if ! grep -q '^host all escuser' "$HBA"; then
  printf 'host all escuser 127.0.0.1/32 scram-sha-256\nhost all escuser ::1/128 scram-sha-256\n' | cat - "$HBA" > "$HBA.new" && mv "$HBA.new" "$HBA"
fi
"$PGBIN/pg_ctl" -D "$PGDATA" reload >/dev/null 2>&1; sleep 1
# Negative control: scram must actually be enforced for escuser, otherwise the
# escaping below would pass trivially via a trust rule.
PGPASSWORD=definitely-wrong "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U escuser -d esc_test -c 'select 1' >/dev/null 2>&1 && SCRAM_OK=no || SCRAM_OK=yes
chk "I.0 scram is enforced for escuser (a wrong password is rejected)" "$SCRAM_OK" "yes"
# ':' → %3A, '\' → %5C so the URL parser reconstructs p:a\ss, which pgpass_escape
# must then escape correctly for libpq to authenticate.
( cd "$SB" && printf 'BACKED UP\nADOPT EXISTING BASELINE\nDONE\n' \
    | env SUPABASE_DB_URL='postgresql://escuser:p%3Aa%5Css@127.0.0.1:'"${PGPORT}"'/esc_test' \
          PATH="$PGBIN:$PATH" bash launch/launch.sh --db-adopt-ledger ) \
    >"$OUT/i_esc.log" 2>&1 && RC=0 || RC=$?
# esc_test is empty → adoption should CONNECT then refuse with "no application
# tables" (proving auth via the escaped .pgpass). A connection/auth failure would
# instead print "could not classify".
chk "I.1 connected via escaped .pgpass (no auth/connection failure)" \
  "$(grepc 'could not classify|connection failed|authentication failed|password authentication' i_esc)" "0"
chk "I.2 reached the empty-DB branch (proves the query ran under scram auth)" \
  "$([ "$(grepc 'no Milk Pop application tables' i_esc)" -ge 1 ] && echo yes || echo no)" "yes"
chk "I.3 the raw password never appears in output" "$(grepc 'p:a' i_esc)" "0"

# ============================================================================
echo
echo "PRE-LEDGER ADOPT — $PASS passed, $FAIL failed  (chain: $N migrations)"
[ "$FAIL" -eq 0 ] || exit 1

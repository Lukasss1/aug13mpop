#!/usr/bin/env bash
# ============================================================================
#  upgrade-replay.test.sh — EXECUTABLE proof of the migration ledger
#  (OPT-01.1 correction §2/§3/§5/§6)
#
#  Boots a throwaway PostgreSQL cluster (TCP, trust auth), copies the repo's
#  launch driver + SQL into a SANDBOX, and drives the REAL launch.sh
#  --db-fresh / --db-upgrade paths through their confirmation gates. It proves,
#  against a live database:
#
#    0. the known T13.3.28 partial-fresh incident is executable/recoverable: a
#       simulated platform Auth user makes recovery refuse without deleting the
#       baseline, then the exact known state recovers to a clean project;
#    1. a fully migrated database runs ZERO migrations on a second upgrade
#       (ledger skip; data, policies and applied_at timestamps untouched);
#    2. existing business data and RLS policies remain byte-identical;
#    3. ONE new migration is applied EXACTLY ONCE (a deliberately
#       non-idempotent probe would double its row count on any replay);
#    4. changing the checksum of an applied migration is a HARD FAILURE
#       before anything is applied;
#    5. a FAILED migration receives NO ledger entry, its DDL is rolled back
#       (file + ledger row share one transaction), and the run STOPS at the
#       first error (a later new migration is never reached);
#   plus: credentials are never printed (host:port/db only), --db-fresh
#   refuses any non-empty public schema and FAILS CLOSED when the emptiness
#   check cannot run, the psql prerequisite check fires, and the ledger table
#   itself is invisible to the anon/authenticated API roles.
#
#  The Supabase surface shim below MIRRORS scripts/migration-baseline.test.sh
#  §2 — if a new migration needs a new shim element, update both together.
#
#  Run: npm run test:upgrade-replay      (safe to re-run; cluster is recreated)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
# initdb/postgres refuse to run as root — drop to the postgres system user.
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/upgrade-replay.test.sh"
fi

PGDATA="/tmp/milkpop-replay-pg"
PGPORT=54329
DB=milkpop_replay
SB="/tmp/milkpop-replay-sandbox"          # sandbox repo copy — tampering never touches the real tree
OUT="/tmp/milkpop-replay-out"             # per-scenario captured launch.sh output
# Decoy password: trust auth ignores it, so if it EVER appears in output the
# driver leaked credentials. The URL's host:port/db half SHOULD appear.
DECOY_PW='S3cr3t-DECOY-Pw'
export SUPABASE_DB_URL="postgresql://postgres:${DECOY_PW}@127.0.0.1:${PGPORT}/${DB}"

PSQL() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" "$@"; }
Q()    { PSQL -tA -c "$1"; }

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "✔ $1"; }
bad() { FAIL=$((FAIL+1)); echo "✖ $1${2:+
    $2}"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2', expected '$3'"; fi; }

# --- 0. Fresh cluster (TCP so the driver's URL parsing is exercised) ---------
cleanup
rm -rf "$PGDATA" "$SB" "$OUT"; mkdir -p "$PGDATA" "$OUT"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='127.0.0.1' -c port=$PGPORT -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database $DB" >/dev/null

# --- 1. Supabase surface shim (mirrors migration-baseline.test.sh §2) --------
# R4.10 Increment 4: shim body replaced by the ONE shared file so every
# database harness starts from the same posture as production.
PSQL < "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

# --- 2. Sandbox repo copy (launch driver + SQL only) --------------------------
mkdir -p "$SB/launch" "$SB/supabase" "$SB/ops" "$SB/.pristine"
cp package.json "$SB/"
cp launch/launch.sh launch/migration-manifest.sh "$SB/launch/"
cp supabase/*.sql "$SB/supabase/"
cp ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql "$SB/ops/"
cp -r "$SB/supabase" "$SB/launch" "$SB/.pristine/"

# shellcheck source=/dev/null
source "$SB/launch/migration-manifest.sh"
N=${#MP_MIGRATIONS[@]}
echo "chain length from manifest: $N migrations"

# run_launch <name> <stdin-string> <arg…>  → captures output, records exit code
run_launch() {
  local name="$1" input="$2"; shift 2
  local rcfile="$OUT/$name.rc"
  ( cd "$SB" && printf '%s' "$input" | bash launch/launch.sh "$@" ) \
      >"$OUT/$name.log" 2>&1 && echo 0 >"$rcfile" || echo $? >"$rcfile"
  RC="$(cat "$rcfile")"
}
log() { cat "$OUT/$1.log"; }

# ============================================================================
echo; echo "— S0: psql prerequisite check fails closed —"
STUB="$SB/.stubpath"; mkdir -p "$STUB"; ln -sf "$(command -v dirname)" "$STUB/dirname"
( cd "$SB" && env PATH="$STUB" /bin/bash launch/launch.sh --db-upgrade </dev/null ) \
    >"$OUT/s0.log" 2>&1 && RC=0 || RC=$?
chk "S0.1 --db-upgrade without psql on PATH exits non-zero" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S0.2 failure names the missing psql prerequisite" \
    "$(grep -c 'PREREQUISITE MISSING: psql' "$OUT/s0.log" || true)" "1"

# ============================================================================
echo; echo "— S0b: a seed failure rolls the entire fresh baseline back —"
printf '\nselect 1/0; -- T13.3.28 forced seed rollback probe\n' >> "$SB/supabase/seed.sql"
run_launch s0b $'ERASE AND INSTALL\n' --db-fresh
chk "S0b.1 forced seed failure exits non-zero" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S0b.2 failure states the atomic baseline rolled back" \
    "$(grep -c 'FRESH BASELINE FAILED: schema + seed were rolled back together' "$OUT/s0b.log" || true)" "1"
chk "S0b.3 no public tables survive the failed baseline" \
    "$(Q "select count(*) from pg_catalog.pg_tables where schemaname='public'")" "0"
chk "S0b.4 no cvs bucket metadata survives the failed baseline" \
    "$(Q "select count(*) from storage.buckets where id='cvs'")" "0"
chk "S0b.5 no migration ledger survives the failed baseline" \
    "$(Q "select case when to_regclass('public.mp_migration_ledger') is null then 0 else 1 end")" "0"
cp "$SB/.pristine/supabase/seed.sql" "$SB/supabase/seed.sql"

# ============================================================================
echo; echo "— S0c: the known T13.3.28 partial-fresh incident is rehearsed and recovered —"
# Supabase owns auth.users in production. The shared local shim intentionally
# models auth.uid()/jwt() but not the platform table, so add the minimum platform
# surface this recovery guard needs without changing every other DB harness.
PSQL -c 'create table if not exists auth.users (id uuid primary key)' >/dev/null

# The real hosted project also contains Supabase's documented optional RLS
# auto-enable safety pair. It is not MilkPop application state, so reproduce it
# exactly and prove recovery/fresh preserve and validate it rather than treating
# it as a generic public routine exception.
PSQL <<'EOSQL' >/dev/null
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS EVENT_TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;
DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls
ON ddl_command_end
WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
EXECUTE FUNCTION public.rls_auto_enable();
EOSQL
chk "S0c.0 exact Supabase RLS auto-enable safety pair exists before incident reconstruction" \
  "$(Q "select count(*) from pg_catalog.pg_event_trigger e join pg_catalog.pg_proc p on p.oid=e.evtfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace where e.evtname='ensure_rls' and e.evtenabled='O' and n.nspname='public' and p.proname='rls_auto_enable'")" "1"

# Recreate the historical failed state. The current fresh schema contains the
# T13.3.28 correction, so remove `available` after schema creation to reproduce
# the pre-fix incident before committing only the first site_settings seed row.
PSQL < "$SB/supabase/schema.FRESH-INSTALL-ONLY.sql" >/dev/null
PSQL -c 'alter table public.menu_items drop column if exists available' >/dev/null
awk '{ print; if ($0 ~ /^on conflict \(id\) do nothing;[[:space:]]*$/) exit }' \
  "$SB/supabase/seed.sql" > "$OUT/s0c-site-settings.sql"
PSQL < "$OUT/s0c-site-settings.sql" >/dev/null
chk "S0c.1 historical partial state has exactly one site_settings seed row" \
  "$(Q 'select count(*) from public.site_settings')" "1"
chk "S0c.2 historical partial state has the private empty cvs bucket" \
  "$(Q "select count(*) from storage.buckets where id='cvs' and public=false")" "1"

# Prove the safety exception is exact, not name-based: a disabled ensure_rls
# trigger must make recovery refuse without deleting the partial baseline.
PSQL -c 'alter event trigger ensure_rls disable' >/dev/null
set +e
PSQL < "$SB/ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql" >"$OUT/s0c-rls-refuse.log" 2>&1
RC=$?
set -e
chk "S0c.2a malformed RLS safety pair makes recovery fail closed" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S0c.2b RLS safety refusal leaves the partial baseline untouched" \
  "$(Q 'select count(*) from public.site_settings')" "1"
PSQL -c 'alter event trigger ensure_rls enable' >/dev/null

# Prove a changed platform state refuses recovery BEFORE deletion and the open
# transaction is rolled back when psql exits on the raised exception.
Q "insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001')" >/dev/null
set +e
PSQL < "$SB/ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql" >"$OUT/s0c-refuse.log" 2>&1
RC=$?
set -e
chk "S0c.3 Auth state makes recovery fail closed" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S0c.4 refused recovery leaves the partial baseline untouched" \
  "$(Q 'select count(*) from public.site_settings')" "1"
Q "delete from auth.users where id='00000000-0000-0000-0000-000000000001'" >/dev/null

PSQL < "$SB/ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql" >"$OUT/s0c-recover.log" 2>&1
chk "S0c.5 exact known incident recovery removes every public table" \
  "$(Q "select count(*) from pg_catalog.pg_tables where schemaname='public'")" "0"
chk "S0c.6 exact known incident recovery removes Storage state" \
  "$(Q 'select count(*) from storage.buckets')" "0"
chk "S0c.7 exact known incident recovery leaves platform Auth empty" \
  "$(Q 'select count(*) from auth.users')" "0"
chk "S0c.8 exact recovery preserves the approved RLS safety pair" \
  "$(Q "select count(*) from pg_catalog.pg_event_trigger e join pg_catalog.pg_proc p on p.oid=e.evtfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace where e.evtname='ensure_rls' and e.evtenabled='O' and n.nspname='public' and p.proname='rls_auto_enable'")" "1"

# Fresh must reject a same-name helper whose exact event-trigger state drifts,
# then accept the restored official pair. This exercises db_target_empty(), not
# merely the recovery SQL.
PSQL -c 'alter event trigger ensure_rls disable' >/dev/null
run_launch s0d $'ERASE AND INSTALL\n' --db-fresh
chk "S0d.1 fresh rejects malformed RLS safety pair" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S0d.2 fresh refusal identifies the RLS safety helper" \
  "$(grep -c 'RLS auto-enable safety helper mismatch' "$OUT/s0d.log" || true)" "1"
PSQL -c 'alter event trigger ensure_rls enable' >/dev/null

# ============================================================================
echo; echo "— S1: --db-fresh on an empty target installs and populates the ledger —"
run_launch s1 $'ERASE AND INSTALL\n' --db-fresh
chk "S1.1 fresh install exits 0" "$RC" "0"
chk "S1.2 emptiness verified before the destructive gate" \
    "$(grep -c 'Target verified empty' "$OUT/s1.log" || true)" "1"
chk "S1.3 ledger row count equals the manifest chain length" "$(Q 'select count(*) from public.mp_migration_ledger')" "$N"
MISMATCH=0
for f in "${MP_MIGRATIONS[@]}"; do
  want="$(sha256sum "$SB/$f" | awk '{print $1}')"
  got="$(Q "select checksum from public.mp_migration_ledger where filename = '$f'")"
  [ "$want" = "$got" ] || MISMATCH=$((MISMATCH+1))
done
chk "S1.4 every recorded checksum matches the file's real SHA-256" "$MISMATCH" "0"
chk "S1.5 every ledger row carries an applied_at timestamp" \
    "$(Q 'select count(*) from public.mp_migration_ledger where applied_at is null')" "0"
chk "S1.6 fresh accepts and preserves the exact Supabase RLS safety pair" \
    "$(Q "select count(*) from pg_catalog.pg_event_trigger e join pg_catalog.pg_proc p on p.oid=e.evtfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace where e.evtname='ensure_rls' and e.evtenabled='O' and n.nspname='public' and p.proname='rls_auto_enable'")" "1"

echo; echo "— S1b: credentials are never printed —"
chk "S1b.1 password absent from all output" "$(grep -c "$DECOY_PW" "$OUT/s1.log" || true)" "0"
chk "S1b.2 userinfo ('postgres:') absent from all output" "$(grep -c 'postgres:S3cr3t' "$OUT/s1.log" || true)" "0"
chk "S1b.3 raw URL absent from all output" "$(grep -cF "$SUPABASE_DB_URL" "$OUT/s1.log" || true)" "0"
chk "S1b.4 host:port/db target line IS shown" "$(grep -c "127.0.0.1:${PGPORT}/${DB}" "$OUT/s1.log" || true)" "1"

echo; echo "— S2: ledger is invisible to the API roles; seed business data —"
chk "S2.1 anon cannot read the ledger" \
    "$(PSQL -tA -c "set role anon; select count(*) from public.mp_migration_ledger;" 2>&1 | grep -c 'permission denied' || true)" "1"
chk "S2.2 authenticated cannot read the ledger" \
    "$(PSQL -tA -c "set role authenticated; select count(*) from public.mp_migration_ledger;" 2>&1 | grep -c 'permission denied' || true)" "1"
Q "insert into news_posts (id, title, content, status) values ('replay-e2e', 'Replay proof', 'must survive upgrades untouched', 'published')" >/dev/null
DATA_BEFORE="$(Q "select md5(string_agg(t.r, '|')) from (select row(np.*)::text as r from news_posts np order by id) t")"
POL_BEFORE="$(Q "select md5(string_agg(r, '|' order by r)) from (select concat_ws(':',schemaname,tablename,policyname,cmd,coalesce(qual,''),coalesce(with_check,''),array_to_string(roles,',')) as r from pg_policies) s")"
TS_BEFORE="$(Q 'select max(applied_at)::text from public.mp_migration_ledger')"

# ============================================================================
echo; echo "— S3: second upgrade on a fully migrated database applies ZERO migrations —"
run_launch s3 $'BACKED UP\nAPPLY MIGRATIONS\n' --db-upgrade
chk "S3.1 upgrade exits 0" "$RC" "0"
chk "S3.2 zero applied, all $N skipped (summary line)" \
    "$(grep -c "0 migration(s) applied, $N already-applied skipped" "$OUT/s3.log" || true)" "1"
chk "S3.3 no 'apply' action ran" "$(grep -c '→ apply' "$OUT/s3.log" || true)" "0"
chk "S3.4 ledger row count unchanged" "$(Q 'select count(*) from public.mp_migration_ledger')" "$N"
chk "S3.5 applied_at timestamps untouched" "$(Q 'select max(applied_at)::text from public.mp_migration_ledger')" "$TS_BEFORE"
DATA_AFTER="$(Q "select md5(string_agg(t.r, '|')) from (select row(np.*)::text as r from news_posts np order by id) t")"
POL_AFTER="$(Q "select md5(string_agg(r, '|' order by r)) from (select concat_ws(':',schemaname,tablename,policyname,cmd,coalesce(qual,''),coalesce(with_check,''),array_to_string(roles,',')) as r from pg_policies) s")"
chk "S3.6 business data byte-identical" "$DATA_AFTER" "$DATA_BEFORE"
chk "S3.7 RLS policy set byte-identical" "$POL_AFTER" "$POL_BEFORE"

# ============================================================================
echo; echo "— S4: one NEW migration is applied exactly once —"
PROBE="supabase/migration_zz_replay_probe.sql"
cat > "$SB/$PROBE" <<'SQL'
-- replay probe: DELIBERATELY NOT idempotent — a second application would
-- insert a second row, so marker count == 1 proves exactly-once semantics.
create table replay_probe (id serial primary key, note text not null);
insert into replay_probe (note) values ('applied-once');
SQL
# Register it AFTER phase_b — the OPT-01.2A model is append-only, and inserting
# before an already-applied migration is now correctly rejected by preflight.
printf '\nMP_MIGRATIONS+=("%s")\n' "$PROBE" >> "$SB/launch/migration-manifest.sh"
run_launch s4 $'BACKED UP\nAPPLY MIGRATIONS\n' --db-upgrade
chk "S4.1 upgrade exits 0" "$RC" "0"
chk "S4.2 exactly one applied, $N skipped" \
    "$(grep -c "1 migration(s) applied, $N already-applied skipped" "$OUT/s4.log" || true)" "1"
chk "S4.3 probe has a ledger entry" "$(Q "select count(*) from public.mp_migration_ledger where filename = '$PROBE'")" "1"
chk "S4.4 probe marker row count is 1" "$(Q 'select count(*) from replay_probe')" "1"
run_launch s4b $'BACKED UP\nAPPLY MIGRATIONS\n' --db-upgrade
chk "S4.5 immediate re-run applies zero (probe now skipped too)" \
    "$(grep -c "0 migration(s) applied, $((N+1)) already-applied skipped" "$OUT/s4b.log" || true)" "1"
chk "S4.6 probe marker row count is STILL 1 after re-run" "$(Q 'select count(*) from replay_probe')" "1"

# ============================================================================
echo; echo "— S5: changing an applied migration's checksum is a HARD failure —"
TAMPER="supabase/migration_security_lockdown.sql"   # first file in the chain
printf '\n-- tampered byte\n' >> "$SB/$TAMPER"
run_launch s5 $'BACKED UP\nAPPLY MIGRATIONS\n' --db-upgrade
chk "S5.1 upgrade exits non-zero" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S5.2 failure names CHECKSUM MISMATCH and the file" \
    "$(grep -c "CHECKSUM MISMATCH: $TAMPER" "$OUT/s5.log" || true)" "1"
chk "S5.3 it stopped BEFORE applying or skipping anything" "$(grep -c '→ apply\|= skip' "$OUT/s5.log" || true)" "0"
chk "S5.4 ledger untouched (count)" "$(Q 'select count(*) from public.mp_migration_ledger')" "$((N+1))"
chk "S5.5 probe marker untouched" "$(Q 'select count(*) from replay_probe')" "1"
cp "$SB/.pristine/supabase/migration_security_lockdown.sql" "$SB/$TAMPER"   # restore

# ============================================================================
echo; echo "— S6: a FAILED migration gets NO ledger entry, rolls back, and stops the run —"
FAILM="supabase/migration_zz_replay_fail.sql"
NEVER="supabase/migration_zz_replay_never.sql"
cat > "$SB/$FAILM" <<'SQL'
create table replay_fail_artifact (id int);   -- must VANISH on rollback
select 1/0;                                    -- forced failure
SQL
printf 'create table replay_never (id int);\n' > "$SB/$NEVER"
printf '\nMP_MIGRATIONS+=("%s" "%s")\n' "$FAILM" "$NEVER" >> "$SB/launch/migration-manifest.sh"
run_launch s6 $'BACKED UP\nAPPLY MIGRATIONS\n' --db-upgrade
chk "S6.1 upgrade exits non-zero" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S6.2 failure names the migration" "$(grep -c "MIGRATION FAILED: $FAILM" "$OUT/s6.log" || true)" "1"
chk "S6.3 failed migration has NO ledger entry" "$(Q "select count(*) from public.mp_migration_ledger where filename = '$FAILM'")" "0"
chk "S6.4 its DDL was rolled back (file + ledger row share one transaction)" \
    "$(Q "select count(*) from pg_tables where tablename = 'replay_fail_artifact'")" "0"
chk "S6.5 run STOPPED at first error: later new migration never ran" \
    "$(Q "select count(*) from pg_tables where tablename = 'replay_never'")" "0"
chk "S6.6 …and has no ledger entry either" "$(Q "select count(*) from public.mp_migration_ledger where filename = '$NEVER'")" "0"
chk "S6.7 ledger count unchanged" "$(Q 'select count(*) from public.mp_migration_ledger')" "$((N+1))"

# ============================================================================
echo; echo "— S7/S8: --db-fresh guards (any-table refusal; fail closed, no override) —"
run_launch s7 '' --db-fresh
chk "S7.1 fresh on a populated target exits non-zero" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S7.2 refusal states it is NOT an empty project" "$(grep -c 'NOT an empty project' "$OUT/s7.log" || true)" "1"
chk "S7.3 refusal happened BEFORE the destructive gate (no prompt shown)" \
    "$(grep -c 'ERASE AND INSTALL' "$OUT/s7.log" || true)" "0"
SAVED_URL="$SUPABASE_DB_URL"
export SUPABASE_DB_URL="postgresql://postgres:${DECOY_PW}@127.0.0.1:1/${DB}"   # unreachable
run_launch s8 '' --db-fresh
chk "S8.1 unverifiable target exits non-zero (fail closed)" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "S8.2 message states FAIL CLOSED / no override" "$(grep -c 'FAIL CLOSED' "$OUT/s8.log" || true)" "1"
chk "S8.3 no override gate was offered" "$(grep -c 'brand-new empty project' "$OUT/s8.log" || true)" "0"
chk "S8.4 password still never printed" "$(grep -c "$DECOY_PW" "$OUT/s8.log" || true)" "0"
export SUPABASE_DB_URL="$SAVED_URL"

# ============================================================================
echo
echo "UPGRADE REPLAY — $PASS passed, $FAIL failed  (chain: $N migrations; ledger: public.mp_migration_ledger)"
[ "$FAIL" -eq 0 ] || exit 1

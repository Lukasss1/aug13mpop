#!/usr/bin/env bash
# ============================================================================
# stage21-upgrade-scenario.test.sh — the re-audit's remaining deployment proof:
#
#   "upgrade from ledgered Stage 2.1 → PASS
#    direct manager salary query   → DENIED"
#
# Builds a real PostgreSQL 17 database whose ledger ends at
# migration_stage2_1_permission_closure.sql — exactly the state of a
# production database that applied the Stage-2.1 package — then drives the
# REAL launch.sh --db-upgrade with the full current manifest and proves:
#
#   P1  the ledgered-2.1 pre-state is genuine (ledger head, checksum match,
#       and the ORIGINAL-2.1 grant surface live: manager CAN read email,
#       already CANNOT read pay);
#   P2  the upgrade applies EXACTLY the two appended migrations (2.1.1,
#       2.1.2), records both checksums, and touches nothing else;
#   P3  on the UPGRADED database the auditor's adversarial query
#       `select id, name, pay_rate, pay_type from staff_profiles;` is
#       permission-denied for an AAL2 manager — and `select email` too,
#       which only the 2.1.2 DYNAMIC per-column revoke guarantees on this
#       path (a table-level revoke alone would leave the original-2.1
#       column grants readable);
#   P4  the deliberate read paths work post-upgrade (directory scope, own
#       pay, owner payroll RPC) and the sanctioned five-column grant holds;
#   P5  a tampered Stage-2.1 file makes the SAME upgrade fail closed with
#       CHECKSUM MISMATCH before applying anything, and restoring the
#       bytes recovers cleanly.
#
# BYTE-AGNOSTIC BY DESIGN: every checksum assertion compares the ledger row
# against the file ON DISK, never against a hard-coded value. The scenario
# is therefore equally valid before and after the operator replaces the
# reconstructed Stage-2.1 file with the byte-exact original — it proves the
# MECHANISM the auditor requires, for whichever bytes are authoritative.
# (Whether the on-disk file IS the original is the separate, deliberate job
# of scripts/check-stage21-restoration.sh.)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/stage21-upgrade-scenario.test.sh"
fi

PGDATA="/tmp/milkpop-s21-pg"
PGPORT=54331
DB=milkpop_s21
SB="/tmp/milkpop-s21-sandbox"
OUT="/tmp/milkpop-s21-out"
S21="supabase/migration_stage2_1_permission_closure.sql"
DECOY_PW='S3cr3t-DECOY-Pw'
export SUPABASE_DB_URL="postgresql://postgres:${DECOY_PW}@127.0.0.1:${PGPORT}/${DB}"

PSQL()  { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" "$@"; }
PSQLR() { "$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" "$@"; }  # no error stop — for denial probes
Q()     { PSQL -tA -c "$1"; }

# as_user <uuid> <aal1|aal2> <sql>  → runs sql inside an authenticated session
# with the given identity; prints rows to stdout, errors to stdout too (merged)
as_user() {
  local sub="$1" aal="$2" sql="$3"
  PSQLR -tA 2>&1 <<EOF
do \$mp\$ begin
  perform set_config('request.jwt.claim.sub', '${sub}', false);
  perform set_config('request.jwt.claims',
    '{"sub":"${sub}","role":"authenticated","email":"${sub}@test.local","aal":"${aal}"}', false);
end \$mp\$;
set role authenticated;
${sql}
EOF
}

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "✔ $1"; }
bad() { FAIL=$((FAIL+1)); echo "✖ $1${2:+
    $2}"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2', expected '$3'"; fi; }
has() { if echo "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "output lacked '$3': $(echo "$2" | tail -2)"; fi; }

# --- 0. Fresh cluster ---------------------------------------------------------
cleanup
rm -rf "$PGDATA" "$SB" "$OUT"; mkdir -p "$PGDATA" "$OUT"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='127.0.0.1' -c port=$PGPORT -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database $DB" >/dev/null

# --- 1. Supabase surface shim (mirrors upgrade-replay.test.sh §1) ------------
# R4.10 Increment 4: shim body replaced by the ONE shared file so every
# database harness starts from the same posture as production.
PSQL < "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

# --- 2. Sandbox repo copy -----------------------------------------------------
mkdir -p "$SB/launch" "$SB/supabase" "$SB/.pristine"
cp package.json "$SB/"
cp launch/launch.sh launch/migration-manifest.sh "$SB/launch/"
cp supabase/*.sql "$SB/supabase/"
cp -r "$SB/supabase" "$SB/launch" "$SB/.pristine/"

# shellcheck source=/dev/null
source "$SB/launch/migration-manifest.sh"
N=${#MP_MIGRATIONS[@]}
# Everything AFTER Stage 2.1 in the chain is the "appended tail" this
# scenario upgrades with — computed dynamically so later append-only stages
# (2.1.1, 2.1.2, Stage 3, …) extend the proof instead of breaking it.
POST21=()
seen21=0
for f in "${MP_MIGRATIONS[@]}"; do
  if [ "$seen21" = "1" ]; then POST21+=("$f"); fi
  [ "$f" = "$S21" ] && seen21=1
done
NPOST=${#POST21[@]}
N21=$((N - NPOST))
echo "chain length: $N migrations; ledgered-2.1 pre-state: $N21; appended tail: $NPOST"

run_launch() {
  local name="$1" input="$2"; shift 2
  local rcfile="$OUT/$name.rc"
  ( cd "$SB" && printf '%s' "$input" | bash launch/launch.sh "$@" ) \
      >"$OUT/$name.log" 2>&1 && echo 0 >"$rcfile" || echo $? >"$rcfile"
  RC="$(cat "$rcfile")"
}

# ============================================================================
echo; echo "— P1: build & verify the ledgered-through-Stage-2.1 production state —"
# The pre-state package: manifest ends at Stage 2.1; the later files do not
# exist yet (they hadn't been written when a 2.1 database was deployed).
for f in "${POST21[@]}"; do
  sed -i "\\#$(basename "$f")#d" "$SB/launch/migration-manifest.sh"
  mv "$SB/$f" "$OUT/"
done
run_launch p1 $'ERASE AND INSTALL\nDONE\n' --db-fresh
chk "P1.1 fresh install of the 2.1-era chain exits 0" "$RC" "0"
chk "P1.2 ledger holds exactly the 2.1-era chain ($N21 rows)" \
    "$(Q 'select count(*) from public.mp_migration_ledger')" "$N21"
chk "P1.3 the ledger HEAD is the Stage-2.1 migration" \
    "$(Q 'select filename from public.mp_migration_ledger order by ordinal desc limit 1')" "$S21"
WANT="$(sha256sum "$SB/$S21" | awk '{print $1}')"
GOT="$(Q "select checksum from public.mp_migration_ledger where filename = '$S21'")"
chk "P1.4 the ledgered 2.1 checksum equals the on-disk file's sha256" "$GOT" "$WANT"

# Fixtures: one store, an owner, a manager and an employee with real pay.
U_OWNER='00000000-0000-4000-8000-0000000000d1'
U_MGR='00000000-0000-4000-8000-0000000000d2'
U_EMP='00000000-0000-4000-8000-0000000000d3'
PSQL <<FIX
insert into stores (id, name, address, postcode)
values ('s1', 'Solihull', '1 Scenario Way', 'B90 0AA') on conflict (id) do nothing;
insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id, points, level, badges, pay_rate, pay_type)
values
 ('emp_owner', 'Olive Owner', 'owner@s21.local', 'owner',         's1', 'Solihull', '$U_OWNER', 0, 1, '[]'::jsonb, 0,     'salary'),
 ('emp_mgr',   'Mia Manager', 'mgr@s21.local',   'store_manager', 's1', 'Solihull', '$U_MGR',   0, 1, '[]'::jsonb, 14.25, 'hourly'),
 ('emp_a',     'Anna Staff',  'anna@s21.local',  'team_member',   's1', 'Solihull', '$U_EMP',   0, 1, '[]'::jsonb, 12.50, 'hourly')
on conflict (id) do nothing;
FIX

# The ORIGINAL-2.1 grant surface, live: email readable, pay already withheld.
R="$(as_user "$U_MGR" aal2 "select email from staff_profiles where id = 'emp_a';")"
has "P1.5 pre-upgrade: a manager CAN read staff email (the original-2.1 column grant)" "$R" "anna@s21.local"
R="$(as_user "$U_MGR" aal2 "select pay_rate from staff_profiles where id = 'emp_a';")"
has "P1.6 pre-upgrade: pay was ALREADY off the 2.1 grant (denied)" "$R" "permission denied"

# ============================================================================
echo; echo "— P2: the upgrade applies EXACTLY the $NPOST appended migrations —"
cp "$SB/.pristine/launch/migration-manifest.sh" "$SB/launch/"
for f in "${POST21[@]}"; do mv "$OUT/$(basename "$f")" "$SB/$f"; done
run_launch p2 $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "P2.1 upgrade exits 0" "$RC" "0"
chk "P2.2 exactly $NPOST applied, $N21 already-applied skipped" \
    "$(grep -c "$NPOST migration(s) applied, $N21 already-applied skipped" "$OUT/p2.log" || true)" "1"
chk "P2.3 ledger now holds the full chain ($N rows)" \
    "$(Q 'select count(*) from public.mp_migration_ledger')" "$N"
for f in "${POST21[@]}"; do
  WANT="$(sha256sum "$SB/$f" | awk '{print $1}')"
  GOT="$(Q "select checksum from public.mp_migration_ledger where filename = '$f'")"
  chk "P2.4 $(basename "$f") ledgered with its real sha256" "$GOT" "$WANT"
done
chk "P2.5 the Stage-2.1 ledger row itself is untouched (pre-upgrade checksum intact)" \
    "$(Q "select checksum from public.mp_migration_ledger where filename = '$S21'")" \
    "$(sha256sum "$SB/$S21" | awk '{print $1}')"

# ============================================================================
echo; echo "— P3: the auditor's adversarial queries on the UPGRADED database —"
R="$(as_user "$U_MGR" aal2 "select id, name, pay_rate, pay_type from staff_profiles;")"
has "P3.1 the exact re-audit manager pay query is DENIED" "$R" "permission denied"
R="$(as_user "$U_MGR" aal2 "select email from staff_profiles where id = 'emp_a';")"
has "P3.2 the email read that WORKED pre-upgrade is now DENIED (dynamic column revoke)" "$R" "permission denied"
R="$(as_user "$U_MGR" aal2 "select auth_id from staff_profiles where id = 'emp_owner';")"
has "P3.3 the owner's auth_id is DENIED to a manager" "$R" "permission denied"
R="$(as_user "$U_OWNER" aal2 "select pay_rate from staff_profiles;")"
has "P3.4 even the OWNER's direct base-table pay read is DENIED" "$R" "permission denied"

# ============================================================================
echo; echo "— P4: the deliberate read paths work on the UPGRADED database —"
chk "P4.1 directory scope: AAL2 manager sees the store (3 rows)" \
    "$(as_user "$U_MGR" aal2 'select count(*) from get_staff_directory();')" "3"
chk "P4.2 directory scope: the SAME manager at AAL1 gets only their own row" \
    "$(as_user "$U_MGR" aal1 'select count(*) from get_staff_directory();')" "1"
chk "P4.3 an employee reads their OWN pay via get_my_staff_profile" \
    "$(as_user "$U_EMP" aal1 "select id || '/' || pay_rate::text from get_my_staff_profile();")" "emp_a/12.50"
chk "P4.4 owner_staff_pay: manager gets ZERO rows" \
    "$(as_user "$U_MGR" aal2 'select count(*) from owner_staff_pay();')" "0"
chk "P4.5 owner_staff_pay: the owner reads the real value" \
    "$(as_user "$U_OWNER" aal2 "select pay_rate from owner_staff_pay() where id = 'emp_a';")" "12.50"
chk "P4.6 the sanctioned five-column grant holds for policy joins/writes" \
    "$(as_user "$U_EMP" aal1 "select name || '/' || role || '/' || store_id || '/' || store_name from staff_profiles where id = 'emp_a';")" \
    "Anna Staff/team_member/s1/Solihull"

# ============================================================================
echo; echo "— P5: a tampered Stage-2.1 file fails the SAME upgrade closed —"
printf '\n-- tampered byte\n' >> "$SB/$S21"
run_launch p5 $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "P5.1 upgrade exits non-zero" "$([ "$RC" -ne 0 ] && echo yes)" "yes"
chk "P5.2 failure names CHECKSUM MISMATCH and the Stage-2.1 file" \
    "$(grep -c "CHECKSUM MISMATCH: $S21" "$OUT/p5.log" || true)" "1"
chk "P5.3 it stopped BEFORE applying or skipping anything" \
    "$(grep -c '→ apply\|= skip' "$OUT/p5.log" || true)" "0"
chk "P5.4 ledger untouched" "$(Q 'select count(*) from public.mp_migration_ledger')" "$N"
cp "$SB/.pristine/supabase/$(basename "$S21")" "$SB/$S21"
run_launch p5b $'BACKED UP\nDONE\nDONE\n' --db-upgrade
chk "P5.5 restoring the bytes recovers: 0 applied, $N skipped" \
    "$(grep -c "0 migration(s) applied, $N already-applied skipped" "$OUT/p5b.log" || true)" "1"

# ============================================================================
echo
echo "STAGE-2.1 UPGRADE SCENARIO — $PASS passed, $FAIL failed  (pre-state: $N21 ledgered; full chain: $N)"
[ "$FAIL" -eq 0 ] || exit 1
